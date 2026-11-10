// M1 真实权限矩阵：5 角色 × 8 敏感端点 + 匿名 401 + 跨租户隔离。
// 全部通过真实 HTTP 命中正在运行的 API，并以真实数据库读回验证副作用。
// allow => 期望 2xx；deny => 期望 403 且 error=permission_denied。
export default async function run({ api, cookies, readBack, check, T }) {
  const SUITE = "M1";

  // 取管理员任职 id（作为薪资读取目标：除 admin 外无人是其本人）与员工任职 id（作为薪资写入/审批目标所属）
  const { rows: adminEmp } = await readBack(
    `SELECT id FROM platform.employments WHERE tenant_id=$1 AND person_id=$2 LIMIT 1`, [T.tenant, T.admin]);
  const { rows: empEmp } = await readBack(
    `SELECT id FROM platform.employments WHERE tenant_id=$1 AND person_id=$2 LIMIT 1`, [T.tenant, T.employee]);
  const adminEmpId = adminEmp[0].id;
  const empEmpId = empEmp[0].id;

  // 为 #8 报销审批预置 3 张由“普通员工”提交的报销单（提交人≠审批人，避免职责分离干扰能力判定）
  const expIds = [];
  for (let i = 0; i < 3; i++) {
    const r = await api(cookies.employee, "POST", "/v1/finance/expenses", {
      category: "travel", amount_cents: 10000 + i, expense_date: "2026-01-05", description: `matrix-exp-${i}`,
    });
    if (r.status !== 201) { check(SUITE, "预置报销单", false, `status=${r.status}`); return; }
    expIds.push(r.body.id);
  }

  // 矩阵定义：[名称, method, pathFn(roleIdx), body, 允许角色集合]
  const roles = ["admin", "manager", "hr", "finance", "employee"];
  const endpoints = [
    ["GET /v1/rbac/members (people.manage_roles)", "GET", () => "/v1/rbac/members", undefined, ["admin"]],
    ["PATCH /v1/settings/finance (settings.manage)", "PATCH", () => "/v1/settings/finance", { approval_threshold_cents: 600000 }, ["admin"]],
    ["PATCH /v1/approval-flows/expense (approval.manage)", "PATCH", () => "/v1/approval-flows/expense", { is_active: true }, ["admin"]],
    ["POST /v1/hr/employees (hr.manage)", "POST", () => "/v1/hr/employees", (role) => ({ display_name: "矩阵新建员工", primary_email: `mx-${role}@acceptance.test`, employee_number: `MX-${role}` }), ["admin", "hr"]],
    [`GET /v1/hr/employees/:id/salary (hr.salary.read)`, "GET", () => `/v1/hr/employees/${adminEmpId}/salary`, undefined, ["admin", "hr"]],
    [`POST /v1/hr/employees/:id/salary (hr.salary.write)`, "POST", () => `/v1/hr/employees/${empEmpId}/salary`, { component_type: "bonus", name: "矩阵奖金", amount_cents: 12345 }, ["admin", "hr"]],
    ["POST /v1/finance/budgets (finance.manage)", "POST", () => "/v1/finance/budgets", (role) => ({ category: "operations", total_amount_cents: 100000, period_year: 2026, notes: `mx-budget-${role}` }), ["admin", "finance"]],
    ["POST /v1/finance/expenses/:id/approve (finance.approve)", "POST", () => `/v1/finance/expenses/${expIds[0]}/approve`, { approved: true }, ["admin", "manager", "finance"]],
  ];

  // #8 每个允许角色用独立报销单，避免状态流转导致后续 404
  const approveTargets = { admin: expIds[0], manager: expIds[1], finance: expIds[2] };

  let matrixPass = 0, matrixFail = 0;
  for (const [label, method, pathFn, body, allowRoles] of endpoints) {
    for (const role of roles) {
      let path = pathFn(role);
      if (label.includes("expenses/:id/approve")) {
        path = `/v1/finance/expenses/${approveTargets[role] ?? expIds[0]}/approve`;
      }
      const expectAllow = allowRoles.includes(role);
      const useBody = typeof body === "function" ? body(role) : body;
      const r = await api(cookies[role], method, path, useBody);
      const pass = expectAllow
        ? (r.status >= 200 && r.status < 300)
        : (r.status === 403 && r.body?.error === "permission_denied");
      const detail = `${role} ${expectAllow ? "allow" : "deny"} -> ${r.status} ${r.body?.error ?? ""}`;
      check(SUITE, `${label} :: ${detail}`, pass, pass ? "" : `expected ${expectAllow ? "2xx" : "403 permission_denied"}`);
      pass ? matrixPass++ : matrixFail++;
    }
  }

  // 匿名 401：任一敏感端点无 cookie
  const anon = await api(null, "GET", "/v1/rbac/members", undefined);
  check(SUITE, `匿名 GET /v1/rbac/members -> ${anon.status} (期望 401)`, anon.status === 401);

  // 跨租户读隔离：admin 在租户 A 建项目，adminB(租户 B) 读该项目应 404（RLS）
  const proj = await api(cookies.admin, "POST", "/v1/projects", { name: "跨租户隔离项目", customer_name: "甲方A" });
  const cross = await api(cookies.adminB, "GET", `/v1/projects/${proj.body.id}`, undefined);
  check(SUITE, `跨租户读取租户A项目(租户B会话) -> ${cross.status} (期望 404)`, cross.status === 404, `project=${proj.body?.id}`);

  // 副作用核验：被拒角色不应产生越权任职（仅 admin+hr 两次成功 => employee_number LIKE 'MX-%' 恰为 2）
  const { rows: cnt } = await readBack(
    `SELECT count(*)::int n FROM platform.employments WHERE tenant_id=$1 AND employee_number LIKE 'MX-%'`, [T.tenant]);
  check(SUITE, `被拒角色未产生越权数据：新建任职行数=${cnt[0].n} (期望 2)`, cnt[0].n === 2);

  check(SUITE, `矩阵汇总 ${matrixPass}/${matrixPass + matrixFail} 命中预期`, matrixFail === 0, matrixFail ? `${matrixFail} 项不符` : "");
}

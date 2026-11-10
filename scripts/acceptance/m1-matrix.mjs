// M1 真实角色 × 敏感端点差异矩阵。
// 隔离库 + 真实 HTTP 服务器 + 真实 HMAC 会话，逐条 curl(fetch) 验证。
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth,
  makeCookies, HOST_URL, REPO,
} from "./lib.mjs";

const SEED = `${REPO}/scripts/acceptance/seed.mjs`;

async function call(cookie, method, path, body) {
  const res = await fetch(`${HOST_URL}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-json */ }
  return { status: res.status, payload };
}

// 为审批类用例创建一个属于"普通员工"的待处理对象（审批人 != 提交人）。
async function newExpenseAsEmployee(cookie) {
  const { status, payload } = await call(cookie, "POST", "/v1/finance/expenses",
    { category: "travel", amount_cents: 1000, expense_date: "2026-01-05", description: "matrix" });
  if (status !== 201) throw new Error(`create expense failed ${status} ${JSON.stringify(payload)}`);
  return payload.id;
}
async function newLeaveAsEmployee(cookie) {
  const { status, payload } = await call(cookie, "POST", "/v1/hr/leave-requests",
    { leave_type: "annual", start_date: "2026-02-01", end_date: "2026-02-02", days: 1, reason: "matrix" });
  if (status !== 201) throw new Error(`create leave failed ${status} ${JSON.stringify(payload)}`);
  return payload.id;
}

// 8 个敏感端点；expected 为各角色是否放行（A=allow 2xx, D=deny 403）。
// 每个 case 返回实际状态；允许类用例执行前构造必要资源。
const ROLES = ["admin", "manager", "hr", "finance", "employee"];

async function buildCases(cookies) {
  return [
    { name: "POST /v1/hr/employees", cap: "hr.manage",
      expected: { admin: "A", manager: "D", hr: "A", finance: "D", employee: "D" },
      run: (c) => call(c, "POST", "/v1/hr/employees", { display_name: "矩阵新员工", primary_email: `mx-${Math.random()}@t.test`, employee_number: `MX-${Math.floor(Math.random() * 1e8)}` }) },

    { name: "POST /v1/finance/payments", cap: "finance.manage",
      expected: { admin: "A", manager: "D", hr: "D", finance: "A", employee: "D" },
      run: (c) => call(c, "POST", "/v1/finance/payments", { customer_name: "矩阵客户", amount_cents: 500000, due_date: "2026-06-01", milestone: "M1" }) },

    { name: "GET /v1/rbac/members", cap: "people.manage_roles(admin)",
      expected: { admin: "A", manager: "D", hr: "D", finance: "D", employee: "D" },
      run: (c) => call(c, "GET", "/v1/rbac/members") },

    { name: "PUT /v1/rbac/members/:id/roles", cap: "people.manage_roles(admin)",
      expected: { admin: "A", manager: "D", hr: "D", finance: "D", employee: "D" },
      run: (c, cookies) => call(c, "PUT", `/v1/rbac/members/${idFrom(cookies.employee)}/roles`, { roles: ["manager"] }) },

    { name: "PATCH /v1/settings/finance", cap: "settings.manage(admin)",
      expected: { admin: "A", manager: "D", hr: "D", finance: "D", employee: "D" },
      run: (c) => call(c, "PATCH", "/v1/settings/finance", { approval_threshold_cents: 600000 }) },

    { name: "PATCH /v1/approval-flows/expense", cap: "approval.manage(admin)",
      expected: { admin: "A", manager: "D", hr: "D", finance: "D", employee: "D" },
      run: (c) => call(c, "PATCH", "/v1/approval-flows/expense", { is_active: true }) },

    { name: "POST /v1/finance/expenses/:id/approve", cap: "finance.approve",
      expected: { admin: "A", manager: "A", hr: "D", finance: "A", employee: "D" },
      run: async (c) => { const id = await newExpenseAsEmployee(cookies.employee); return call(c, "POST", `/v1/finance/expenses/${id}/approve`, { approved: true }); } },

    { name: "PATCH /v1/hr/leave-requests/:id", cap: "hr.leave.approve",
      expected: { admin: "A", manager: "A", hr: "A", finance: "D", employee: "D" },
      run: async (c) => { const id = await newLeaveAsEmployee(cookies.employee); return call(c, "PATCH", `/v1/hr/leave-requests/${id}`, { status: "approved" }); } },
  ];
}

// 从 employee 会话 cookie 解出 personId（用于 rbac PUT 路径参数）。
function idFrom(cookie) {
  const token = cookie.replace("hq_session=", "").split(".")[0];
  const identity = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  return identity.personId;
}

const outcome = (s) => (s >= 200 && s < 400 ? "A" : s === 403 ? "D" : `X${s}`);

async function main() {
  await ensureContainer({ fresh: true });
  const mig = await applyMigrations();
  await runSeed("./seed.mjs");
  const server = startServer();
  let exitCode = 0;
  try {
    await waitHealth(server);
    const cookies = await makeCookies();
    const cases = await buildCases(cookies);

    const rows = [];
    let mismatches = 0;
    for (const cs of cases) {
      const actual = {};
      for (const role of ROLES) {
        const { status } = await cs.run(cookies[role], cookies);
        actual[role] = outcome(status);
      }
      const diffs = ROLES.filter((r) => actual[r] !== cs.expected[r]);
      mismatches += diffs.length;
      rows.push({ name: cs.name, cap: cs.cap, expected: cs.expected, actual, ok: diffs.length === 0, diffs });
    }

    // 未认证一律 401
    const anon = {};
    for (const [name, m, p] of [
      ["GET /v1/rbac/members", "GET", "/v1/rbac/members"],
      ["PATCH /v1/settings/finance", "PATCH", "/v1/settings/finance"],
    ]) {
      anon[name] = (await call("", m, p, name.includes("settings") ? { approval_threshold_cents: 1 } : undefined)).status;
    }

    // 跨租户隔离：B 租户员工读取 A 租户 rbac（应 403，因 B 员工无 people.manage_roles）
    const crossTenant = await call(cookies.adminB, "GET", "/v1/rbac/members");

    const report = {
      migrations: mig,
      roles: ROLES,
      matrix: rows,
      unauthenticated: anon,
      crossTenantB_onA: crossTenant.status,
      mismatches,
      passed: mismatches === 0 && Object.values(anon).every((s) => s === 401) && crossTenant.status === 403,
    };
    console.log("=== M1 角色×端点差异矩阵 ===");
    for (const r of rows) {
      console.log(`${r.ok ? "OK " : "BAD"}  ${r.name.padEnd(42)} [${r.cap}]`);
      console.log(`     expected: ${ROLES.map((x) => `${x}=${r.expected[x]}`).join(" ")}`);
      console.log(`     actual:   ${ROLES.map((x) => `${x}=${r.actual[x]}`).join(" ")}`);
    }
    console.log("未认证:", JSON.stringify(anon));
    console.log("跨租户B→A:", crossTenant.status);
    console.log("\n" + JSON.stringify(report, null, 2));
    if (!report.passed) exitCode = 1;
  } finally {
    server.kill("SIGTERM");
  }
  process.exit(exitCode);
}

main().catch((err) => { console.error("M1 harness error:", err); process.exit(2); });

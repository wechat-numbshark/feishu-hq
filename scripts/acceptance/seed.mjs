// 验收用隔离租户种子数据（确定性 UUID，便于读回断言）。
// 由 harness 以 hq_admin（超级用户，绕过 RLS）身份执行，逐条显式写 tenant_id。
import { randomUUID } from "node:crypto";

export const T = {
  tenant: "10000000-0000-4000-8000-000000000001", // = DEMO_TENANT_ID，复用演示工作流链
  legalEntity: "30000000-0000-4000-8000-000000000001",
  orgUnit: "40000000-0000-4000-8000-000000000001",
  position: "50000000-0000-4000-8000-000000000001",
  admin: "20000000-0000-4000-8000-000000000001", // = demoIdentity.personId，tenant_admin
  manager: "20000000-0000-4000-8000-000000000002", // 部门主管
  hr: "20000000-0000-4000-8000-000000000003", // 人事管理员
  finance: "20000000-0000-4000-8000-000000000004", // 财务管理员
  employee: "20000000-0000-4000-8000-000000000005", // 普通员工（无岗位角色）
  // 第二个租户，用于跨租户隔离断言
  tenantB: "10000000-0000-4000-8000-0000000000b2",
  legalEntityB: "30000000-0000-4000-8000-0000000000b2",
  orgUnitB: "40000000-0000-4000-8000-0000000000b2",
  personB: "20000000-0000-4000-8000-0000000000b2",
};

const ts = () => new Date().toISOString();

// 返回一组 { sql, values } 语句，供 harness 顺序执行。
export function buildSeedStatements() {
  const st = [];
  const add = (sql, values = []) => st.push({ sql, values });

  // ── 租户 ──
  add(
    `INSERT INTO platform.tenants (id, code, name, deployment_mode, status)
     VALUES ($1,'acceptance','验收测试企业','private','active')
     ON CONFLICT (id) DO NOTHING`,
    [T.tenant]
  );
  add(
    `INSERT INTO platform.tenants (id, code, name, deployment_mode, status)
     VALUES ($1,'acceptance-b','验收测试企业B','private','active')
     ON CONFLICT (id) DO NOTHING`,
    [T.tenantB]
  );

  // ── 法人 / 组织 / 岗位 ──
  const legal = (id, tenant, code, name) =>
    add(
      `INSERT INTO platform.legal_entities (id, tenant_id, code, name, status)
       VALUES ($1,$2,$3,$4,'active') ON CONFLICT (id) DO NOTHING`,
      [id, tenant, code, name]
    );
  legal(T.legalEntity, T.tenant, "LE-MAIN", "验收主法人");
  legal(T.legalEntityB, T.tenantB, "LE-B", "B 法人");

  // 依赖顺序：people 先于 org_units(引用 manager_person_id) 与 employments。
  const person = (id, tenant, name, email) =>
    add(
      `INSERT INTO platform.people (id, tenant_id, display_name, primary_email, status, classification)
       VALUES ($1,$2,$3,$4,'active','internal') ON CONFLICT (id) DO NOTHING`,
      [id, tenant, name, email]
    );
  person(T.admin, T.tenant, "验收管理员", "admin@acceptance.test");
  person(T.manager, T.tenant, "部门主管", "manager@acceptance.test");
  person(T.hr, T.tenant, "人事管理员", "hr@acceptance.test");
  person(T.finance, T.tenant, "财务管理员", "finance@acceptance.test");
  person(T.employee, T.tenant, "普通员工", "employee@acceptance.test");
  person(T.personB, T.tenantB, "B 企业员工", "b@acceptance.test");

  const org = (id, tenant, code, name, managerId) =>
    add(
      `INSERT INTO platform.org_units (id, tenant_id, code, name, type, status, manager_person_id)
       VALUES ($1,$2,$3,$4,'company','active',$5) ON CONFLICT (id) DO NOTHING`,
      [id, tenant, code, name, managerId]
    );
  org(T.orgUnit, T.tenant, "HQ", "总部", T.manager);
  org(T.orgUnitB, T.tenantB, "HQ-B", "B 总部", null);

  add(
    `INSERT INTO platform.positions (id, tenant_id, org_unit_id, code, name, status)
     VALUES ($1,$2,$3,'POS-ENG','工程岗','open') ON CONFLICT (id) DO NOTHING`,
    [T.position, T.tenant, T.orgUnit]
  );

  const employment = (id, tenant, personId, legalId, orgId, managerId, no) =>
    add(
      `INSERT INTO platform.employments (id, tenant_id, person_id, legal_entity_id, org_unit_id, manager_person_id, employee_number, status, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active', current_date - interval '365 days') ON CONFLICT (id) DO NOTHING`,
      [id, tenant, personId, legalId, orgId, managerId, no]
    );

  // employee/主管/hr/财务 的直属上级都是 manager；manager 与 admin 无上级（测试缺主管回退）
  employment(randomUUID(), T.tenant, T.admin, T.legalEntity, T.orgUnit, null, "E-ADMIN");
  employment(randomUUID(), T.tenant, T.manager, T.legalEntity, T.orgUnit, null, "E-MGR");
  employment(randomUUID(), T.tenant, T.hr, T.legalEntity, T.orgUnit, T.manager, "E-HR");
  employment(randomUUID(), T.tenant, T.finance, T.legalEntity, T.orgUnit, T.manager, "E-FIN");
  employment(randomUUID(), T.tenant, T.employee, T.legalEntity, T.orgUnit, T.manager, "E-EMP");
  employment(randomUUID(), T.tenantB, T.personB, T.legalEntityB, T.orgUnitB, null, "E-B");

  // ── 岗位角色与绑定（RBAC 能力来源）──
  const role = (id, tenant, code, name, kind) =>
    add(
      `INSERT INTO authz.roles (id, tenant_id, code, name, role_kind, status)
       VALUES ($1,$2,$3,$4,$5,'active') ON CONFLICT (tenant_id, code) DO NOTHING`,
      [id, tenant, code, name, kind]
    );
  const binding = (tenant, roleId, personId) =>
    add(
      `INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason)
       VALUES ($1,$2,$3,'person',$4,'acceptance seed')`,
      [randomUUID(), tenant, roleId, personId]
    );
  const rManager = randomUUID();
  const rHr = randomUUID();
  const rFinance = randomUUID();
  role(rManager, T.tenant, "manager", "部门主管", "business");
  role(rHr, T.tenant, "hr_manager", "人事管理员", "business");
  role(rFinance, T.tenant, "finance_manager", "财务管理员", "business");
  binding(T.tenant, rManager, T.manager);
  binding(T.tenant, rHr, T.hr);
  binding(T.tenant, rFinance, T.finance);

  // ── 审批流：报销 / 请假 = 直属上级 -> 财务/HR 角色（role 步骤不自动指派）──
  const flow = (code, name, module, steps) =>
    add(
      `INSERT INTO platform.approval_flows (id, tenant_id, code, name, module, steps, auto_approve_if_no_approver, is_active)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,false,true) ON CONFLICT (tenant_id, code) DO NOTHING`,
      [randomUUID(), T.tenant, code, name, module, JSON.stringify(steps)]
    );
  flow("expense", "费用报销审批", "finance", [
    { order: 1, type: "manager", label: "直属上级" },
    { order: 2, type: "role", label: "财务负责人" },
  ]);
  flow("leave_request", "请假审批", "hr", [
    { order: 1, type: "manager", label: "直属上级" },
    { order: 2, type: "role", label: "HR 负责人" },
  ]);

  // ── AI 工具授权：6 个 L0 读取默认放行；create_task(L2) 不默认放行 ──
  const l0 = [
    ["query_projects", "project.project.read", "project"],
    ["query_crm", "crm.opportunity.read", "crm"],
    ["query_hr", "hr.requisition.read", "hr"],
    ["query_finance", "finance.summary.read", "finance"],
    ["search_knowledge", "knowledge.item.read", "knowledge"],
    ["get_workspace_overview", "platform.overview.read", "platform"],
  ];
  for (const [tool, action, domain] of l0) {
    add(
      `INSERT INTO platform.ai_tool_authorizations (id, tenant_id, person_id, tool_name, action, risk_level, data_domain, effect, status, reason)
       VALUES ($1,$2,NULL,$3,$4,'L0',$5,'allow','active','authenticated read default')
       ON CONFLICT (tenant_id, tool_name) WHERE person_id IS NULL AND deleted_at IS NULL DO NOTHING`,
      [randomUUID(), T.tenant, tool, action, domain]
    );
  }

  // ── 一条薪资记录，用于敏感读取矩阵（他人薪资）──
  add(
    `INSERT INTO hr.salary_components (id, tenant_id, person_id, employment_id, component_type, name, amount_cents, is_fixed, effective_from)
     SELECT $1, $2, $3, e.id, 'base', '基本工资', 3000000, true, current_date - interval '30 days'
     FROM platform.employments e
     WHERE e.tenant_id = $2 AND e.person_id = $3 LIMIT 1
     ON CONFLICT DO NOTHING`,
    [randomUUID(), T.tenant, T.employee]
  );

  // ── 通用设置初始值（finance 审批阈值）──
  add(
    `INSERT INTO platform.tenant_settings (tenant_id, namespace, key, value, updated_at)
     VALUES ($1,'finance','approval_threshold_cents', '500000'::jsonb, now())
     ON CONFLICT (tenant_id, namespace, key) DO UPDATE SET value = '500000'::jsonb, updated_at = now()`,
    [T.tenant]
  );

  return st;
}

export const seedMeta = { generatedAt: ts, tenantId: T.tenant };

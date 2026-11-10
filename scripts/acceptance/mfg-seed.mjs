// 制造业专属种子：在通用 seed.mjs（租户/角色/审批流/AI授权/阈值）之上，
// 追加"恒精精密制造"的组织、员工、雇佣、合同与可驱动的两级审批流。
// 全部确定性 UUID，供 mfg-e2e.mjs 真实读回断言。以 hq_admin（BYPASSRLS）执行。
import { T } from "./seed.mjs";

// ── 制造业人员（platform.people）──
export const M = {
  salesDirector:   "2e000000-0000-4000-8000-000000000001", // 销售总监
  salesRep:        "2e000000-0000-4000-8000-000000000002", // 销售经理 张伟（商机负责人）
  processEng:      "2e000000-0000-4000-8000-000000000003", // 工艺工程师 王芳（普通同事，脱敏视角）
  prodSupervisor:  "2e000000-0000-4000-8000-000000000004", // 生产主管
  purchaser:       "2e000000-0000-4000-8000-000000000005", // 采购专员 李雷（报销申请人）
  purchaseMgr:     "2e000000-0000-4000-8000-000000000006", // 采购经理（审批1 + 薪资保护目标）
  qc:              "2e000000-0000-4000-8000-000000000007", // 质检员
  financeDirector: "2e000000-0000-4000-8000-000000000008", // 财务总监 赵敏（审批2）
  cncWorker:       "2e000000-0000-4000-8000-000000000009", // CNC 操作工（入职环节动态创建）

  // 部门（platform.org_units）
  deptSales:    "4e000000-0000-4000-8000-000000000001",
  deptTech:     "4e000000-0000-4000-8000-000000000002",
  deptProd:     "4e000000-0000-4000-8000-000000000003",
  deptPurchase: "4e000000-0000-4000-8000-000000000004",
  deptQC:       "4e000000-0000-4000-8000-000000000005",
  deptFinance:  "4e000000-0000-4000-8000-000000000006",

  // 雇佣（platform.employments，固定 id 供详情端点 :id 引用）
  empPurchaser:    "6e000000-0000-4000-8000-000000000005",
  empPurchaseMgr:  "6e000000-0000-4000-8000-000000000006",
  empProcessEng:   "6e000000-0000-4000-8000-000000000003",
  empProdSup:      "6e000000-0000-4000-8000-000000000004",
  empSalesRep:     "6e000000-0000-4000-8000-000000000002",
  empSalesDirector:"6e000000-0000-4000-8000-000000000001",
  empQC:           "6e000000-0000-4000-8000-000000000007",
  empFinance:      "6e000000-0000-4000-8000-000000000008",

  // 采购经理劳动合同（薪资保护目标，供 S10 ABAC 断言）
  contractPurchaseMgr: "7e000000-0000-4000-8000-000000000006",
};

export function buildMfgSeedStatements() {
  const st = [];
  const add = (sql, values = []) => st.push({ sql, values });

  const person = (id, name, email, mobile) =>
    add(
      `INSERT INTO platform.people (id, tenant_id, display_name, primary_email, mobile, city, gender, status, classification)
       VALUES ($1,$2,$3,$4,$5,'苏州',$6,'active','internal') ON CONFLICT (id) DO NOTHING`,
      [id, T.tenant, name, email, mobile ?? null, name.includes("总监") || name.includes("经理") ? "female" : "male"]
    );
  person(M.salesDirector,   "销售总监 陈总", "sales-director@hengjing.test", "13900000001");
  person(M.salesRep,        "销售经理 张伟", "zhangwei@hengjing.test",       "13900000002");
  person(M.processEng,      "工艺工程师 王芳", "wangfang@hengjing.test",      "13900000003");
  person(M.prodSupervisor,  "生产主管 刘强", "liuqiang@hengjing.test",       "13900000004");
  person(M.purchaser,       "采购专员 李雷", "lilei@hengjing.test",          "13900000005");
  person(M.purchaseMgr,     "采购经理 孙倩", "sunqian@hengjing.test",        "13900000006");
  person(M.qc,              "质检员 周明", "zhouming@hengjing.test",         "13900000007");
  person(M.financeDirector, "财务总监 赵敏", "zhaomin@hengjing.test",        "13900000008");

  const dept = (id, code, name, managerId) =>
    add(
      `INSERT INTO platform.org_units (id, tenant_id, legal_entity_id, code, name, type, status, manager_person_id)
       VALUES ($1,$2,$3,$4,$5,'department','active',$6) ON CONFLICT (id) DO NOTHING`,
      [id, T.tenant, T.legalEntity, code, name, managerId ?? null]
    );
  dept(M.deptSales,    "DEPT-SALES",    "销售部",     M.salesDirector);
  dept(M.deptTech,     "DEPT-TECH",     "研发工艺部", M.processEng);
  dept(M.deptProd,     "DEPT-PROD",     "生产部",     M.prodSupervisor);
  dept(M.deptPurchase, "DEPT-PURCHASE", "采购部",     M.purchaseMgr);
  dept(M.deptQC,       "DEPT-QC",       "质检部",     M.qc);
  dept(M.deptFinance,  "DEPT-FINANCE",  "财务部",     M.financeDirector);

  // employment(id, person, org, manager, no, type)
  const emp = (id, personId, orgId, managerId, no, type = "employee") =>
    add(
      `INSERT INTO platform.employments (id, tenant_id, person_id, legal_entity_id, org_unit_id, manager_person_id, employee_number, employment_type, status, start_date, work_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active', current_date - interval '200 days','苏州工厂') ON CONFLICT (id) DO NOTHING`,
      [id, T.tenant, personId, T.legalEntity, orgId, managerId, no, type]
    );
  emp(M.empSalesDirector,  M.salesDirector,   M.deptSales,    null,            "HJ-1001");
  emp(M.empSalesRep,       M.salesRep,        M.deptSales,    M.salesDirector, "HJ-1002");
  emp(M.empProcessEng,     M.processEng,      M.deptTech,     M.prodSupervisor,"HJ-2001");
  emp(M.empProdSup,        M.prodSupervisor,  M.deptProd,     null,            "HJ-3001");
  emp(M.empPurchaser,      M.purchaser,       M.deptPurchase, M.purchaseMgr,   "HJ-4001"); // 报销人，上级=采购经理
  emp(M.empPurchaseMgr,    M.purchaseMgr,     M.deptPurchase, null,            "HJ-4002");
  emp(M.empQC,             M.qc,              M.deptQC,       M.prodSupervisor,"HJ-5001");
  emp(M.empFinance,        M.financeDirector, M.deptFinance,  null,            "HJ-6001");

  // 岗位角色绑定：财务总监=finance_manager（财务概览/审批能力），生产主管=manager
  const roleBinding = (personId, code) =>
    add(
      `INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason)
       SELECT gen_random_uuid(), $1, r.id, 'person', $2, 'mfg seed'
       FROM authz.roles r WHERE r.tenant_id = $1 AND r.code = $3
         AND NOT EXISTS (
           SELECT 1 FROM authz.role_bindings rb
           WHERE rb.tenant_id = $1 AND rb.role_id = r.id AND rb.subject_id = $2
         )`,
      [T.tenant, personId, code]
    );
  roleBinding(M.financeDirector, "finance_manager");
  roleBinding(M.prodSupervisor, "manager");

  // 采购经理劳动合同（薪资保护目标）
  add(
    `INSERT INTO hr.employee_contracts (id, tenant_id, person_id, contract_type, start_date, base_salary_cents, status)
     VALUES ($1,$2,$3,'full_time', current_date - interval '200 days', 4800000, 'active') ON CONFLICT (id) DO NOTHING`,
    [M.contractPurchaseMgr, T.tenant, M.purchaseMgr]
  );

  // 把"报销"审批流改为可确定性驱动：1) 直属上级(采购经理) 2) 指定人(财务总监)
  add(
    `UPDATE platform.approval_flows
     SET steps = $2::jsonb
     WHERE tenant_id = $1 AND code = 'expense'`,
    [T.tenant, JSON.stringify([
      { order: 1, type: "manager", label: "部门经理" },
      { order: 2, type: "person", label: "财务总监", person_id: M.financeDirector },
    ])]
  );

  return st;
}

export const mfgSeedMeta = { tenantId: T.tenant, company: "恒精精密制造股份有限公司" };

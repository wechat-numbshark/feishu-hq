// 软件公司专属种子：在通用 seed.mjs（租户/角色/审批流/AI授权/阈值）之上，
// 追加"云枢软件"的组织、员工、雇佣、合同与可确定性驱动的两级审批流。
// 全部确定性 UUID，供 sw-e2e.mjs 真实读回断言。以 hq_admin（BYPASSRLS）执行。
import { T } from "./seed.mjs";

// ── 云枢软件人员（platform.people）──
export const S = {
  ceo:      "8e000000-0000-4000-8000-000000000001", // CEO 郭诚（tenant_admin 会话身份）
  vpTech:   "8e000000-0000-4000-8000-000000000002", // CTO 周明远（manager 绑定；薪资保护目标；审批1）
  hrd:      "8e000000-0000-4000-8000-000000000003", // HRD 罗幻（hr_manager 绑定；请假终批）
  cfo:      "8e000000-0000-4000-8000-000000000004", // 财务总监 严斌（finance_manager 绑定；审批2）
  itAdmin:  "8e000000-0000-4000-8000-000000000005", // IT 管理员 魏东（云服务年费申请人）
  pd:       "8e000000-0000-4000-8000-000000000006", // 产品总监 何柳（PRD/知识）
  pm:       "8e000000-0000-4000-8000-000000000007", // 产品经理 林晓菲（商机负责人）
  beDev:    "8e000000-0000-4000-8000-000000000008", // 后端工程师 李默（日常：打卡/任务/请假）
  feDev:    "8e000000-0000-4000-8000-000000000009", // 前端工程师 苏娟（ABAC 同事视角）
  qa:       "8e000000-0000-4000-8000-00000000000a", // 测试工程师 白山（缺陷近似）
  payroll:  "8e000000-0000-4000-8000-00000000000b", // 薪资专员 钱华（无绑定=无关员工行级域负例）

  // 部门（platform.org_units）
  deptExec:    "9e000000-0000-4000-8000-0000000000a1",
  deptProduct: "9e000000-0000-4000-8000-0000000000a2",
  deptRnD:     "9e000000-0000-4000-8000-0000000000a3",
  deptHR:      "9e000000-0000-4000-8000-0000000000a4",
  deptFinance: "9e000000-0000-4000-8000-0000000000a5",
  deptIT:      "9e000000-0000-4000-8000-0000000000a6",

  // 雇佣（platform.employments，固定 id 供 /v1/hr/employees/:employment_id 引用）
  empVpTech:  "ae000000-0000-4000-8000-000000000002",
  empBeDev:   "ae000000-0000-4000-8000-000000000008",
  empFeDev:   "ae000000-0000-4000-8000-000000000009",

  // CTO 劳动合同（薪资保护目标，供 S11 ABAC 断言）
  contractVp: "be000000-0000-4000-8000-000000000002",
};

export function buildSwSeedStatements() {
  const st = [];
  const add = (sql, values = []) => st.push({ sql, values });

  const person = (id, name, email, mobile) =>
    add(
      `INSERT INTO platform.people (id, tenant_id, display_name, primary_email, mobile, city, gender, status, classification)
       VALUES ($1,$2,$3,$4,$5,'杭州',$6,'active','internal') ON CONFLICT (id) DO NOTHING`,
      [id, T.tenant, name, email, mobile, name.includes("何柳") || name.includes("苏娟") || name.includes("林晓菲") || name.includes("钱华") || name.includes("罗幻") ? "female" : "male"]
    );
  person(S.ceo, "CEO 郭诚", "guocheng@yunshu.test", "13800000001");
  person(S.vpTech, "CTO 周明远", "zhoumy@yunshu.test", "13800000002");
  person(S.hrd, "HRD 罗幻", "luohuan@yunshu.test", "13800000003");
  person(S.cfo, "财务总监 严斌", "yanbin@yunshu.test", "13800000004");
  person(S.itAdmin, "IT管理员 魏东", "weidong@yunshu.test", "13800000005");
  person(S.pd, "产品总监 何柳", "heliu@yunshu.test", "13800000006");
  person(S.pm, "产品经理 林晓菲", "linxf@yunshu.test", "13800000007");
  person(S.beDev, "后端工程师 李默", "limo@yunshu.test", "13800000008");
  person(S.feDev, "前端工程师 苏娟", "sujuan@yunshu.test", "13800000009");
  person(S.qa, "测试工程师 白山", "baishan@yunshu.test", "13800000010");
  person(S.payroll, "薪资专员 钱华", "qianhua@yunshu.test", "13800000011");

  const dept = (id, code, name, managerId) =>
    add(
      `INSERT INTO platform.org_units (id, tenant_id, legal_entity_id, code, name, type, status, manager_person_id)
       VALUES ($1,$2,$3,$4,$5,'department','active',$6) ON CONFLICT (id) DO NOTHING`,
      [id, T.tenant, T.legalEntity, code, name, managerId ?? null]
    );
  dept(S.deptExec, "DEPT-EXEC", "总经办", S.ceo);
  dept(S.deptProduct, "DEPT-PRODUCT", "产品部", S.pd);
  dept(S.deptRnD, "DEPT-RND", "研发中心", S.vpTech);
  dept(S.deptHR, "DEPT-HR", "人事部", S.hrd);
  dept(S.deptFinance, "DEPT-SW-FINANCE", "财务部", S.cfo);
  dept(S.deptIT, "DEPT-IT", "IT部", S.itAdmin);

  // employment(id, person, org, manager, no)
  const emp = (id, personId, orgId, managerId, no) =>
    add(
      `INSERT INTO platform.employments (id, tenant_id, person_id, legal_entity_id, org_unit_id, manager_person_id, employee_number, employment_type, status, start_date, work_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'employee','active', current_date - interval '200 days','杭州研发中心') ON CONFLICT (id) DO NOTHING`,
      [id, T.tenant, personId, T.legalEntity, orgId, managerId, no]
    );
  emp(S.empVpTech, S.vpTech, S.deptRnD, null, "YS-0002");
  emp("ae000000-0000-4000-8000-000000000001", S.ceo, S.deptExec, null, "YS-0001");
  emp("ae000000-0000-4000-8000-000000000003", S.hrd, S.deptHR, S.ceo, "YS-0003");
  emp("ae000000-0000-4000-8000-000000000004", S.cfo, S.deptFinance, S.ceo, "YS-0004");
  emp("ae000000-0000-4000-8000-000000000005", S.itAdmin, S.deptIT, S.vpTech, "YS-0005"); // 云服务年费申请人，上级=CTO
  emp("ae000000-0000-4000-8000-000000000006", S.pd, S.deptProduct, null, "YS-0006");
  emp("ae000000-0000-4000-8000-000000000007", S.pm, S.deptProduct, S.pd, "YS-0007");
  emp(S.empBeDev, S.beDev, S.deptRnD, S.vpTech, "YS-0008"); // 请假/小额报销申请人，上级=CTO
  emp(S.empFeDev, S.feDev, S.deptRnD, S.vpTech, "YS-0009");
  emp("ae000000-0000-4000-8000-00000000000a", S.qa, S.deptRnD, S.vpTech, "YS-000A");
  emp("ae000000-0000-4000-8000-00000000000b", S.payroll, S.deptFinance, S.cfo, "YS-000B");

  // 岗位角色绑定
  const roleBinding = (personId, code) =>
    add(
      `INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason)
       SELECT gen_random_uuid(), $1, r.id, 'person', $2, 'sw seed'
       FROM authz.roles r WHERE r.tenant_id = $1 AND r.code = $3
         AND NOT EXISTS (
           SELECT 1 FROM authz.role_bindings rb
           WHERE rb.tenant_id = $1 AND rb.role_id = r.id AND rb.subject_id = $2
         )`,
      [T.tenant, personId, code]
    );
  roleBinding(S.vpTech, "manager");
  roleBinding(S.hrd, "hr_manager");
  roleBinding(S.cfo, "finance_manager");

  // CTO 劳动合同（薪资保护目标）
  add(
    `INSERT INTO hr.employee_contracts (id, tenant_id, person_id, contract_type, start_date, base_salary_cents, status)
     VALUES ($1,$2,$3,'full_time', current_date - interval '200 days', 6800000, 'active') ON CONFLICT (id) DO NOTHING`,
    [S.contractVp, T.tenant, S.vpTech]
  );

  // 审批流改可确定性驱动：报销 = 直属上级(CTO) -> 指定人(财务总监)；请假 = 直属上级(CTO) -> 指定人(HRD)
  add(
    `UPDATE platform.approval_flows SET steps = $2::jsonb WHERE tenant_id = $1 AND code = 'expense'`,
    [T.tenant, JSON.stringify([
      { order: 1, type: "manager", label: "直属上级(CTO)" },
      { order: 2, type: "person", label: "财务总监", person_id: S.cfo },
    ])]
  );
  add(
    `UPDATE platform.approval_flows SET steps = $2::jsonb WHERE tenant_id = $1 AND code = 'leave_request'`,
    [T.tenant, JSON.stringify([
      { order: 1, type: "manager", label: "直属上级(CTO)" },
      { order: 2, type: "person", label: "HRD", person_id: S.hrd },
    ])]
  );

  return st;
}

export const swSeedMeta = { tenantId: T.tenant, company: "云枢软件（SaaS + 定制交付）" };

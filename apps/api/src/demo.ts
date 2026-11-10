import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SessionIdentity } from "./session.ts";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000 }) : null;
export const DEMO_TENANT_ID = "10000000-0000-4000-8000-000000000001";

// ── 一键换公司（docs/16）：演示公司注册表 ──────────────────────
// standard=体验企业（原有演示租户）；mfg/sw 由迁移 0025 预置，各自独立租户（RLS 隔离）。
export interface DemoCompany {
  key: string; tenantId: string; adminPersonId: string;
  name: string; industry: string; description: string;
}
export const DEMO_COMPANIES: DemoCompany[] = [
  {
    key: "standard", tenantId: DEMO_TENANT_ID, adminPersonId: "20000000-0000-4000-8000-000000000001",
    name: "总部 OS 体验企业", industry: "综合",
    description: "通用企业管理演示：自由创建商机→项目→招聘→收款链路。",
  },
  {
    key: "mfg", tenantId: "d0000001-0000-4000-8000-000000000001", adminPersonId: "d0000001-0000-4000-8000-00000000aa01",
    name: "恒精精密制造", industry: "汽车零部件 · 离散制造",
    description: "制造全流程演示：OKR/商机/合同/BOM/工艺/工单/采购/质检/回款/制造看板。",
  },
  {
    key: "sw", tenantId: "d0000002-0000-4000-8000-000000000001", adminPersonId: "d0000002-0000-4000-8000-00000000bb01",
    name: "云枢软件", industry: "B2B SaaS · 软件研发",
    description: "软件公司全流程演示：OKR/需求池/缺陷/迭代燃尽/版本/合同/订阅 MRR/绩效。",
  },
];
const COMPANY_BY_KEY = new Map(DEMO_COMPANIES.map(c => [c.key, c]));
const COMPANY_TENANTS = new Set(DEMO_COMPANIES.map(c => c.tenantId));

export function resolveDemoCompany(key: unknown): DemoCompany | null {
  if (key == null) return COMPANY_BY_KEY.get("standard")!;
  return typeof key === "string" ? COMPANY_BY_KEY.get(key) ?? null : null;
}
export function listDemoCompanies() {
  return DEMO_COMPANIES.map(({ key, tenantId, name, industry, description }) => ({ key, tenantId, name, industry, description }));
}

// ── 岗位细节（docs/17）：演示岗位注册表 ─────────────────────────
// 每个岗位 = 一个可登录的真实身份（person），带职责说明与业务标签；
// 工作台按标签/角色渲染岗位专属区块；权限差异来自真实角色绑定（manager/hr/finance 等）。
export interface DemoPersona {
  personId: string; name: string; title: string; org: string;
  duty: string; tags: string[]; isAdmin: boolean;
}
export const DEMO_PERSONAS: Record<string, DemoPersona[]> = {
  standard: [{
    personId: "20000000-0000-4000-8000-000000000001", name: "体验管理员", title: "企业管理员", org: "总部",
    duty: "全权限视角：体验跨模块业务链、审批与 AI。", tags: ["exec"], isAdmin: true,
  }],
  mfg: [
    { personId: "d0000001-0000-4000-8000-00000000aa01", name: "陈志恒", title: "总经理", org: "总经办",
      duty: "经营总览：看板/OKR/合同回款/全审批，掌握良率·OTD·账龄。", tags: ["exec"], isAdmin: true },
    { personId: "d0000001-0000-4000-8000-00000000aa02", name: "刘慧敏", title: "销售总监", org: "销售部",
      duty: "商机漏斗与跟进：停滞商机预警、赢单转合同、客户档案。", tags: ["sales"], isAdmin: false },
    { personId: "d0000001-0000-4000-8000-00000000aa03", name: "王芳", title: "工艺工程师", org: "研发工艺部",
      duty: "BOM/工艺路线维护与发布，SOP 知识沉淀。", tags: ["production"], isAdmin: false },
    { personId: "d0000001-0000-4000-8000-00000000aa04", name: "赵国庆", title: "生产主管", org: "生产部",
      duty: "工单下达与进度：未结工单、在制数量、报工良率。", tags: ["production"], isAdmin: false },
    { personId: "d0000001-0000-4000-8000-00000000aa05", name: "李雷", title: "采购专员", org: "采购部",
      duty: "采购申请与订单执行：PR→PO→收货，供应商交期。", tags: ["purchase"], isAdmin: false },
    { personId: "d0000001-0000-4000-8000-00000000aa06", name: "周建军", title: "采购经理", org: "采购部",
      duty: "采购审批与预算：审批采购单，关注超支风险。", tags: ["purchase"], isAdmin: false },
    { personId: "d0000001-0000-4000-8000-00000000aa07", name: "孙倩", title: "质检员", org: "质检部",
      duty: "来料/工序检验与不合格处置（NCR），良率监控。", tags: ["quality", "production"], isAdmin: false },
    { personId: "d0000001-0000-4000-8000-00000000aa08", name: "赵敏", title: "财务总监", org: "财务部",
      duty: "应收账龄/预算占用/发票回款/费用与合同审批。", tags: ["finance"], isAdmin: false },
  ],
  sw: [
    { personId: "d0000002-0000-4000-8000-00000000bb01", name: "郭诚", title: "CEO", org: "总经办",
      duty: "北极星指标：MRR/ARR、准交率、高层看板与 OKR。", tags: ["exec"], isAdmin: true },
    { personId: "d0000002-0000-4000-8000-00000000bb02", name: "周明远", title: "CTO", org: "研发中心",
      duty: "交付与健康度：迭代燃尽、严重缺陷、里程碑、工时成本。", tags: ["rnd"], isAdmin: false },
    { personId: "d0000002-0000-4000-8000-00000000bb03", name: "罗幻", title: "HRD", org: "人事部",
      duty: "招聘漏斗、入职/转正提醒、假期发放与绩效周期。", tags: ["hr"], isAdmin: false },
    { personId: "d0000002-0000-4000-8000-00000000bb04", name: "严斌", title: "财务总监", org: "财务部",
      duty: "账龄/预算/发票回款；订阅收入与合同审批。", tags: ["finance"], isAdmin: false },
    { personId: "d0000002-0000-4000-8000-00000000bb05", name: "魏东", title: "IT 管理员", org: "IT 部",
      duty: "资产与许可台账：到期提醒、SLA 超时工单、席位分配。", tags: ["it"], isAdmin: false },
    { personId: "d0000002-0000-4000-8000-00000000bb06", name: "何柳", title: "产品总监", org: "产品部",
      duty: "需求池分办与优先级：客户声音→需求→迭代排期。", tags: ["product"], isAdmin: false },
    { personId: "d0000002-0000-4000-8000-00000000bb07", name: "林晓菲", title: "产品经理", org: "产品部",
      duty: "商机跟进与签约：停滞预警、合同起草、客户对接。", tags: ["sales"], isAdmin: false },
    { personId: "d0000002-0000-4000-8000-00000000bb08", name: "李默", title: "后端工程师", org: "研发中心",
      duty: "迭代任务与缺陷修复：工时登记、燃尽贡献。", tags: ["rnd"], isAdmin: false },
    { personId: "d0000002-0000-4000-8000-00000000bb0a", name: "白山", title: "测试工程师", org: "研发中心",
      duty: "缺陷提交与验证：严重级别把关、版本回归。", tags: ["rnd"], isAdmin: false },
  ],
};

export function listDemoPersonas(companyKey: string) {
  const list = DEMO_PERSONAS[companyKey] ?? [];
  return list.map(({ personId, name, title, org, duty, isAdmin }) => ({ personId, name, title, org, duty, isAdmin }));
}

export function resolveDemoPersona(company: DemoCompany, personId: unknown): DemoPersona {
  const fallback = (DEMO_PERSONAS[company.key] ?? []).find(p => p.isAdmin)
    ?? (DEMO_PERSONAS[company.key] ?? [])[0];
  if (typeof personId !== "string") return fallback;
  return (DEMO_PERSONAS[company.key] ?? []).find(p => p.personId === personId) ?? fallback;
}

/** 当前演示会话对应岗位（含标签）；非演示或未注册身份返回 null。 */
export function demoPersonaOf(identity: { mode?: string; tenantId?: string; personId?: string } | SessionIdentity): DemoPersona | null {
  if (!identity || (identity as SessionIdentity).mode !== "demo") return null;
  const company = DEMO_COMPANIES.find(c => c.tenantId === (identity as SessionIdentity).tenantId);
  if (!company) return null;
  return (DEMO_PERSONAS[company.key] ?? []).find(p => p.personId === (identity as SessionIdentity).personId) ?? null;
}

export type DemoFlowInput = {
  customerName: string; opportunityName: string; amountYuan: number; expectedCloseDate: string;
  projectName: string; startDate: string; endDate: string;
  hiringEnabled: boolean; jobTitle?: string; headcount?: number;
  paymentPercent: number; paymentDueDate: string;
};

function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error("invalid_demo_input");
  return value.trim();
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error("invalid_demo_input");
  return value;
}
export function validateDemoFlow(value: unknown): DemoFlowInput {
  if (!value || typeof value !== "object") throw new Error("invalid_demo_input");
  const v = value as Record<string, unknown>;
  const input: DemoFlowInput = {
    customerName: text(v.customerName, 200), opportunityName: text(v.opportunityName, 200),
    amountYuan: Number(v.amountYuan), expectedCloseDate: date(v.expectedCloseDate),
    projectName: text(v.projectName, 200), startDate: date(v.startDate), endDate: date(v.endDate),
    hiringEnabled: v.hiringEnabled !== false,
    paymentPercent: Number(v.paymentPercent), paymentDueDate: date(v.paymentDueDate)
  };
  if (!Number.isFinite(input.amountYuan) || input.amountYuan < 1000 || input.amountYuan > 100_000_000) throw new Error("invalid_demo_input");
  if (input.endDate < input.startDate || input.paymentPercent < 1 || input.paymentPercent > 100) throw new Error("invalid_demo_input");
  if (input.hiringEnabled) {
    input.jobTitle = text(v.jobTitle, 200); input.headcount = Number(v.headcount);
    if (!Number.isInteger(input.headcount) || input.headcount! < 1 || input.headcount! > 20) throw new Error("invalid_demo_input");
  }
  return input;
}

function assertDemo(identity: SessionIdentity) {
  if (identity.mode !== "demo" || !COMPANY_TENANTS.has(identity.tenantId)) throw new Error("demo_session_required");
  if (!pool) throw new Error("database_not_configured");
}

async function transaction<T>(identity: SessionIdentity, run: (client: pg.PoolClient) => Promise<T>) {
  assertDemo(identity); const client = await pool!.connect();
  try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)",[identity.tenantId]); await client.query("SET LOCAL ROLE hq_app"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; } finally { client.release(); }
}

export async function getDemoWorkspace(identity: SessionIdentity) {
  return transaction(identity, async client => {
    const [opportunities, projects, requisitions, payments, workflows] = await Promise.all([
      client.query("SELECT id,name,customer_name,amount_cents,stage,win_probability,expected_close_date,created_at FROM crm.opportunities WHERE is_demo ORDER BY created_at DESC LIMIT 20"),
      client.query("SELECT id,code,name,customer_name,budget_cents,status,start_date,end_date,progress,created_at FROM project.projects WHERE is_demo ORDER BY created_at DESC LIMIT 20"),
      client.query("SELECT id,project_id,title,headcount,reason,status,created_at FROM hr.job_requisitions WHERE is_demo ORDER BY created_at DESC LIMIT 20"),
      client.query("SELECT id,project_id,customer_name,amount_cents,due_date,milestone,status,created_at FROM finance.payment_plans WHERE is_demo ORDER BY created_at DESC LIMIT 20"),
      client.query("SELECT id,opportunity_id,project_id,requisition_id,payment_plan_id,summary,created_at FROM platform.demo_workflows ORDER BY created_at DESC LIMIT 20")
    ]);
    return { opportunities:opportunities.rows, projects:projects.rows, requisitions:requisitions.rows, payments:payments.rows, workflows:workflows.rows };
  });
}

export async function createDemoFlow(identity: SessionIdentity, raw: unknown, traceId: string) {
  const input = validateDemoFlow(raw);
  return transaction(identity, async client => {
    const opportunityId=randomUUID(), projectId=randomUUID(), requisitionId=input.hiringEnabled?randomUUID():null, paymentId=randomUUID(), workflowId=randomUUID();
    const amountCents=Math.round(input.amountYuan*100), paymentCents=Math.round(amountCents*input.paymentPercent/100);
    const code=`DEMO-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    await client.query("INSERT INTO crm.opportunities(id,tenant_id,name,customer_name,owner_person_id,amount_cents,stage,win_probability,expected_close_date,notes,is_demo) VALUES($1,$2,$3,$4,$5,$6,'won',100,$7,'由体验流程创建',true)",[opportunityId,identity.tenantId,input.opportunityName,input.customerName,identity.personId,amountCents,input.expectedCloseDate]);
    await client.query("INSERT INTO project.projects(id,tenant_id,source_opportunity_id,code,name,customer_name,owner_person_id,budget_cents,status,start_date,end_date,progress,is_demo) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'planning',$9,$10,8,true)",[projectId,identity.tenantId,opportunityId,code,input.projectName,input.customerName,identity.personId,amountCents,input.startDate,input.endDate]);
    if (requisitionId) await client.query("INSERT INTO hr.job_requisitions(id,tenant_id,project_id,title,headcount,reason,status,is_demo) VALUES($1,$2,$3,$4,$5,$6,'open',true)",[requisitionId,identity.tenantId,projectId,input.jobTitle,input.headcount,`${input.projectName} 交付资源需求`]);
    await client.query("INSERT INTO finance.payment_plans(id,tenant_id,project_id,customer_name,amount_cents,due_date,milestone,status,is_demo) VALUES($1,$2,$3,$4,$5,$6,'项目首期款','planned',true)",[paymentId,identity.tenantId,projectId,input.customerName,paymentCents,input.paymentDueDate]);
    const summary={customerName:input.customerName,opportunityName:input.opportunityName,projectName:input.projectName,amountYuan:input.amountYuan,paymentYuan:paymentCents/100,jobTitle:input.jobTitle||null,headcount:input.headcount||0};
    await client.query("INSERT INTO platform.demo_workflows(id,tenant_id,opportunity_id,project_id,requisition_id,payment_plan_id,created_by,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[workflowId,identity.tenantId,opportunityId,projectId,requisitionId,paymentId,identity.personId,JSON.stringify(summary)]);
    await client.query("INSERT INTO audit.audit_events(id,tenant_id,actor_id,action,resource_id,resource_type,outcome,change_summary,client_context,trace_id) VALUES($1,$2,$3,'demo.sales_to_delivery.created',$4,'demo_workflow','success',$5::jsonb,'{\"mode\":\"demo\"}'::jsonb,$6)",[randomUUID(),identity.tenantId,identity.personId,workflowId,JSON.stringify(summary),traceId]);
    return { id:workflowId, opportunityId, projectId, requisitionId, paymentPlanId:paymentId, code, summary };
  });
}

export async function resetDemoWorkspace(identity: SessionIdentity, traceId: string) {
  return transaction(identity, async client => {
    await client.query("DELETE FROM platform.demo_workflows");
    const results: number[] = [];
    results.push((await client.query("DELETE FROM hr.job_requisitions WHERE is_demo")).rowCount||0);
    results.push((await client.query("DELETE FROM finance.payment_plans WHERE is_demo")).rowCount||0);
    results.push((await client.query("DELETE FROM project.projects WHERE is_demo")).rowCount||0);
    results.push((await client.query("DELETE FROM crm.opportunities WHERE is_demo")).rowCount||0);
    await client.query("INSERT INTO audit.audit_events(id,tenant_id,actor_id,action,outcome,change_summary,client_context,trace_id) VALUES($1,$2,$3,'demo.workspace.reset','success',$4::jsonb,'{\"mode\":\"demo\"}'::jsonb,$5)",[randomUUID(),identity.tenantId,identity.personId,JSON.stringify({deleted:results.reduce((a,b)=>a+b,0)}),traceId]);
    return { reset:true, deleted:results.reduce((a,b)=>a+b,0) };
  });
}

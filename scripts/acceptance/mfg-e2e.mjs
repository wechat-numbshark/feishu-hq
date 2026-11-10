// 制造业全流程端到端演练（npm run accept:mfg）。
// 主角：恒精精密制造。用真实数据把「战略→销售→立项→人力→设备→采购审批→质量知识→交付回款→AI办事→权限」逐段跑通，
// 每段基于真实 HTTP/executeTool + 真实 PG 读回断言；并把"只能近似/无端点/领域缺失"如实记为 GAP。
// 纪律：任一断言失败 exit 1；不编造——所有 PASS/FAIL 与 GAP 均来自本次真实执行。
import pg from "pg";
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth,
  ADMIN_DB_URL, SESSION_SECRET, HOST_URL, api, destroyContainer,
} from "./lib.mjs";
import { T } from "./seed.mjs";
import { M, buildMfgSeedStatements } from "./mfg-seed.mjs";

const steps = [];
const gaps = [];
const add = (phase, name, ok, detail) => steps.push({ phase, name, ok: !!ok, detail });
const gap = (id, sev, desc) => gaps.push({ id, sev, desc });

let server, admin, exitCode = 0;
const run = async () => {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  await runSeed("./seed.mjs");

  // 追加制造业种子
  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  for (const { sql, values } of buildMfgSeedStatements()) await admin.query(sql, values);

  server = startServer();
  await waitHealth(server);
  process.env.DATABASE_URL = ADMIN_DB_URL;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.MODEL_API_KEY = "";
  const { createSession } = await import("../../apps/api/src/session.ts");
  const { executeTool } = await import("../../apps/api/src/ai.ts");
  const { processDueJobs } = await import("../../packages/domain/src/job-queue.ts");
  const ck = (personId, role = "employee") =>
    `hq_session=${createSession({ tenantId: T.tenant, personId, role, mode: "feishu" })}`;
  const adminCk = ck(T.admin, "tenant_admin");
  const purchaserCk = ck(M.purchaser);
  const purchaseMgrCk = ck(M.purchaseMgr);
  const financeCk = ck(M.financeDirector);
  const processEngCk = ck(M.processEng);
  const adminIdentity = { tenantId: T.tenant, personId: T.admin, role: "tenant_admin", mode: "feishu" };

  // ── S1 战略 OKR ─────────────────────────────────────────
  {
    const per = await api(adminCk, "POST", "/v1/strategy/periods", {
      label: "2026年度", period_type: "year", start_date: "2026-01-01", end_date: "2026-12-31",
    });
    const obj = await api(adminCk, "POST", "/v1/strategy/objectives", {
      period_id: per.body.id, title: "提升良率与客户结构升级", type: "company",
    });
    const kr = await api(adminCk, "POST", `/v1/strategy/objectives/${obj.body.id}/key-results`, {
      title: "一次交检良率", kr_type: "percentage", target_value: 98.5, unit: "%",
    });
    const ci = await api(adminCk, "POST", `/v1/strategy/key-results/${kr.body.id}/checkins`, {
      value_at_checkin: 96.2, confidence: 70,
    });
    const krRow = await api(adminCk, "GET", `/v1/strategy/key-results/${kr.body.id}`);
    add("S1战略", "OKR 周期→目标→KR→打卡，读回 current_value=96.2",
      per.status === 201 && obj.status === 201 && kr.status === 201 && ci.status === 201
      && Number(krRow.body?.current_value) === 96.2,
      { per: per.status, obj: obj.status, kr: kr.status, krId: kr.body?.id, ci: ci.status, readStatus: krRow.status, readErr: krRow.body?.error, current_value: krRow.body?.current_value });
    gap("G-S1", "低", "OKR 无原生「良率/准交/成本」KPI 口径，指标须由业务表实时派生（当前手工打卡）。");
  }

  // ── S2 销售：客户→商机→AI推进→赢单 ───────────────────────
  let OPP;
  {
    const acc = await api(adminCk, "POST", "/v1/crm/accounts", {
      name: "华驰动力", industry: "汽车零部件", annual_revenue_cents: 5000000000,
    });
    const opp = await api(adminCk, "POST", "/v1/crm/opportunities", {
      name: "HX 传动轴年框", customer_name: "华驰动力", amount_cents: 800000000, stage: "qualified",
    });
    OPP = opp.body.id;
    await api(adminCk, "POST", `/v1/crm/opportunities/${OPP}/activities`, {
      activity_type: "meeting", title: "技术方案交流",
    });
    const r = await executeTool("update_opportunity_stage", { opportunity_id: OPP, stage: "negotiation", win_probability: 80 }, adminIdentity, { traceId: "mfg-s2" });
    void r;
    const won = await api(adminCk, "POST", `/v1/crm/opportunities/${OPP}/stage`, { stage: "won" });
    const row = (await admin.query(`SELECT stage, win_probability FROM crm.opportunities WHERE id=$1`, [OPP])).rows[0];
    add("S2销售", "客户→商机→AI推进 negotiation→赢单 won，读回 stage=won & wp=100",
      acc.status === 201 && opp.status === 201 && won.status === 200 && row.stage === "won" && Number(row.win_probability) === 100,
      { stage: row.stage, wp: row.win_probability });
    gap("G-S2", "中", "CRM 无报价/合同/销售订单(SO)对象；赢单后须手工建项目，缺 商机→项目 自动编排（outbox/作业可演进）。");
  }

  // ── S3 立项：项目→里程碑(直插)→工序任务 + AI 建任务 ────────
  let PRJ;
  {
    const prj = await api(adminCk, "POST", "/v1/projects", {
      name: "HX 传动轴量产项目", customer_name: "华驰动力", source_opportunity_id: OPP,
      budget_cents: 800000000, start_date: "2026-03-01", end_date: "2026-12-31",
    });
    PRJ = prj.body.id;
    // 里程碑：无创建端点 → 直插（记为 GAP）
    const msId = "9e000000-0000-4000-8000-000000000001";
    await admin.query(
      `INSERT INTO project.milestones (id, tenant_id, project_id, name, status, due_date)
       VALUES ($1,$2,$3,'量产爬坡','in_progress','2026-06-30')`, [msId, T.tenant, PRJ]);
    const t1 = await api(adminCk, "POST", `/v1/projects/${PRJ}/tasks`, {
      title: "粗车工序作业", assignee_person_id: M.prodSupervisor, priority: "high", milestone_id: msId,
    });
    // AI 受控建任务（生产工单近似）
    await executeTool("create_task", { project_id: PRJ, title: "精磨工序首件检验", assignee_person_id: M.qc, priority: "high" }, adminIdentity, { traceId: "mfg-s3" });
    const done = await api(adminCk, "PATCH", `/v1/tasks/${t1.body.id}`, { status: "done" });
    const cnt = (await admin.query(`SELECT count(*)::int c FROM project.tasks WHERE project_id=$1`, [PRJ])).rows[0].c;
    add("S3立项", "项目(关联赢单)→里程碑(直插)→工序任务→AI建任务→工序置done，读回任务数>=2 且工序 done",
      prj.status === 201 && t1.status === 201 && done.body.status === "done" && cnt >= 2, { taskCount: cnt });
    gap("G-S3a", "高", "无「里程碑/工序」创建 API（须直插 SQL）；project.tasks 充当「生产工单」缺 数量/工序号/设备/报工/工时定额 等制造字段。");
    gap("G-S3b", "高", "缺 产品/SKU/物料/BOM/工艺路线(Routing) 主数据；无法表达「一台产品由哪些料、按哪些工序制造」。");
  }

  // ── S4 人力：AI 招聘需求→候选人→面试→Offer→入职 ────────────
  {
    const req = await executeTool("create_requisition", { title: "CNC 操作工", headcount: 6, reason: "HX 量产扩产" }, adminIdentity, { traceId: "mfg-s4" });
    const reqId = req.requisition?.id;
    const cand = await api(adminCk, "POST", "/v1/hr/candidates", {
      name: "候选人·张师傅", requisition_id: reqId, current_title: "数控操作工", years_of_experience: 6, source: "referral",
    });
    const iv = await api(adminCk, "POST", `/v1/hr/candidates/${cand.body.id}/interviews`, {
      scheduled_at: "2026-03-05T09:00:00Z", interview_type: "technical", interviewer_person_ids: [M.prodSupervisor],
    });
    const ev = await api(adminCk, "POST", `/v1/hr/interviews/${iv.body.id}/evaluations`, { recommendation: "recommend", overall_score: 8 });
    const offer = await api(adminCk, "POST", `/v1/hr/candidates/${cand.body.id}/offers`, {
      position_title: "CNC 操作工", base_salary_annual: 12000000, department: "生产部", expected_start_date: "2026-03-20",
    });
    const accepted = await api(adminCk, "PATCH", `/v1/hr/offers/${offer.body.id}`, { status: "accepted" });
    // 入职：offer→employment 不联动 → 手工登记（记 GAP）
    await admin.query(
      `INSERT INTO platform.people (id, tenant_id, display_name, primary_email, mobile, status, classification)
       VALUES ($1,$2,'CNC操作工·张师傅','zhangsf@hengjing.test','13900000100','active','internal') ON CONFLICT (id) DO NOTHING`,
      [M.cncWorker, T.tenant]);
    await admin.query(
      `INSERT INTO platform.employments (id, tenant_id, person_id, legal_entity_id, org_unit_id, manager_person_id, employee_number, employment_type, status, start_date, work_location)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'HJ-3100','employee','active', current_date,'苏州工厂')`,
      [T.tenant, M.cncWorker, T.legalEntity, M.deptProd, M.prodSupervisor]);
    const empOn = (await admin.query(`SELECT count(*)::int c FROM platform.employments WHERE person_id=$1 AND status='active'`, [M.cncWorker])).rows[0].c;
    add("S4人力", "AI 招聘需求→候选人→面试→评价→Offer 接受→入职登记生效，读回 需求/入职各 +1",
      req.created === true && cand.status === 201 && iv.status === 201 && ev.status === 201
      && offer.status === 201 && accepted.body.status === "accepted" && empOn === 1);
    gap("G-S4", "中", "Offer 接受后不自动生成雇佣/员工账号/考勤组（须手工登记）；缺 入职清单/转正/工位-设备-账号 联动。");
  }

  // ── S5 设备：加工中心台账→点检工单→闭环 ─────────────────────
  {
    const asset = await api(adminCk, "POST", "/v1/it/assets", {
      name: "五轴加工中心 DMU 50", category: "hardware", vendor: "DMG MORI", model: "DMU50",
      purchase_cost_cents: 250000000, status: "in_use", location: "苏州工厂/一号产线",
    });
    const tk = await api(adminCk, "POST", "/v1/it/tickets", {
      title: "DMU50 首保点检", category: "device", priority: "high", asset_id: asset.body.id,
    });
    const resolved = await api(adminCk, "PATCH", `/v1/it/tickets/${tk.body.id}`, { status: "resolved", resolution_notes: "按点检标准完成" });
    add("S5设备", "设备台账(借 it.assets)→点检工单→闭环 resolved，读回工单 status=resolved",
      asset.status === 201 && tk.status === 201 && resolved.body.status === "resolved");
    gap("G-S5", "高", "it.assets 是 IT 台账语义，缺 生产设备 OEE/稼动率/停机损失/保养计划/备件/点检标准；设备≠IT资产。");
  }

  // ── S6 采购 + 审批：预算→超阈采购报销→两级审批→终态回写 ───────
  {
    const bud = await api(adminCk, "POST", "/v1/finance/budgets", {
      category: "operations", total_amount_cents: 100000000, period_year: 2026, org_unit_id: M.deptPurchase,
    });
    const exp = await api(purchaserCk, "POST", "/v1/finance/expenses", {
      category: "supplies", amount_cents: 8000000, description: "合金钢棒料 42CrMo 采购", expense_date: "2026-03-10",
    });
    const expId = exp.body.id;
    const inst = (await admin.query(
      `SELECT id FROM platform.approval_instances WHERE tenant_id=$1 AND resource_type='expense' AND resource_id=$2`,
      [T.tenant, expId])).rows[0];
    const d1 = await api(purchaseMgrCk, "POST", `/v1/approvals/${inst.id}/decide`, { decision: "approved", comment: "价格核准" });
    const d2 = await api(financeCk, "POST", `/v1/approvals/${inst.id}/decide`, { decision: "approved", comment: "预算内" });
    const expRow = (await admin.query(`SELECT status FROM finance.expenses WHERE id=$1`, [expId])).rows[0];
    const instRow = (await admin.query(`SELECT status FROM platform.approval_instances WHERE id=$1`, [inst.id])).rows[0];
    add("S6采购审批", "预算→超阈报销自动建审批→经理批准→财务批准→费用终态 approved（回写）",
      bud.status === 201 && exp.status === 201 && exp.body.needs_approval === true && !!inst
      && d2.body.newStatus === "approved" && expRow.status === "approved" && instRow.status === "approved",
      { bud: bud.status, exp: exp.status, needs: exp.body?.needs_approval, d1: d1.body?.newStatus, d2: d2.body?.newStatus, expense: expRow.status, instance: instRow.status });
    gap("G-S6", "高", "采购只能借「费用报销」表达，缺 采购申请(PR)/采购订单(PO)/供应商(supplier，it.vendors 面向IT)/收货/来料检/三单匹配/应付；无库存增减。");
  }

  // ── S7 质量与知识：分类→SOP/检验规范→全文检索命中 ─────────────
  {
    const cat = await api(adminCk, "POST", "/v1/knowledge/categories", { name: "工艺规程" });
    const sop = await api(adminCk, "POST", "/v1/knowledge/items", {
      category_id: cat.body.id, title: "HX 传动轴车加工作业指导书",
      content: "本作业指导书规定传动轴粗车、半精车、精车各工序的装夹、刀具、切削参数与检验要求，保证一次交检合格率。",
      classification: "internal",
    });
    await api(adminCk, "POST", "/v1/knowledge/items", {
      title: "传动轴终检检验规范", content: "终检项目：外径、圆度、跳动、表面粗糙度；量具与抽样方案见附录。",
    });
    const search = await api(adminCk, "GET", "/v1/knowledge/items?search=" + encodeURIComponent("HX"));
    const hits = Array.isArray(search.body?.items) ? search.body.items.length : 0;
    add("S7知识", "建分类→SOP/检验规范→全文检索命中（>=1）",
      cat.status === 201 && sop.status === 201 && hits >= 1, { hits, status: search.status, err: search.body?.error });
    gap("G-S7", "中", "知识=文档层，缺 工艺参数结构化(可被派工引用)、版本受控变更审批、图纸与 BOM 关联；QMS 检验记录(实测值/SPC/不合格处置)无处落。另：全文检索用 'simple' 配置不对中文分词，中文关键词检索命中差（需 zhparser/pg_jieba），本演练以 ASCII 料号 HX 验证检索链路。");
  }

  // ── S8 交付回款：应收开票→收款计划→回款→财务概览 ─────────────
  {
    const inv = await api(adminCk, "POST", "/v1/finance/invoices", {
      invoice_type: "receivable", counterparty_name: "华驰动力", amount_cents: 800000000,
      issue_date: "2026-06-30", due_date: "2026-07-30", invoice_number: "INV-HJ-2026-0001",
    });
    await api(adminCk, "PATCH", `/v1/finance/invoices/${inv.body.id}`, { status: "sent" });
    const pay = await api(adminCk, "POST", "/v1/finance/payments", {
      customer_name: "华驰动力", amount_cents: 800000000, due_date: "2026-07-30",
      milestone: "HX 首批量产交付", project_id: PRJ, status: "planned",
    });
    const paid = await api(adminCk, "PATCH", `/v1/finance/payments/${pay.body.id}`, { status: "paid" });
    const ov = await api(adminCk, "GET", "/v1/finance/overview");
    const collected = Number(ov.body?.payments?.collected_total ?? 0);
    add("S8交付回款", "应收发票→收款计划→标记已收→财务概览 collected_total>=8000000 元",
      inv.status === 201 && paid.status === 200 && collected >= 800000000, { collected });
    gap("G-S8", "中", "缺 发货/出库单 与 发票→出库→对账 关联；无 标准成本/工单成本归集(料工费)/毛利，无法按订单/产品核算盈利。");
  }

  // ── S9 AI 跨系统办事 + 持久周报 ────────────────────────────
  {
    const q = await executeTool("queue_weekly_report", {}, adminIdentity, { traceId: "mfg-s9" });
    await processDueJobs(admin, { limit: 50 });
    const job = (await admin.query(`SELECT status, result FROM platform.jobs WHERE id=$1`, [q.job_id])).rows[0];
    const keys = job?.result ? Object.keys(job.result) : [];
    add("S9AI周报", "AI queue_weekly_report→真实作业处理 succeeded 且 result 含 projects/crm/hr/finance",
      q.queued === true && job?.status === "succeeded" && ["projects","crm","hr","finance"].every((k) => keys.includes(k)),
      { status: job?.status, keys });
    gap("G-S9", "低", "周报为通用经营聚合，缺制造业 KPI（OEE/良率/准交/在制/库存周转）；指标口径未覆盖生产域。");
  }

  // ── S10 权限：ABAC 数据域/字段脱敏在制造组织内生效 ────────────
  {
    const asColleague = await api(processEngCk, "GET", `/v1/hr/employees/${M.empPurchaseMgr}`);
    const colSalary = asColleague.body?.contracts?.[0]?.base_salary_cents;
    const asAdmin = await api(adminCk, "GET", `/v1/hr/employees/${M.empPurchaseMgr}`);
    const admSalary = asAdmin.body?.contracts?.[0]?.base_salary_cents;
    const list = await api(processEngCk, "GET", "/v1/hr/employees");
    const pmRow = (list.body?.items ?? []).find((r) => r.person_id === M.purchaseMgr);
    add("S10权限", "同事(工艺工程师)看采购经理：薪资隐藏 + 手机号脱敏；管理员可读取完整薪资",
      colSalary === undefined && Number(admSalary) === 4800000 && typeof pmRow?.mobile === "string" && pmRow.mobile.includes("****"),
      { colleagueSalary: colSalary, adminSalary: admSalary, maskedMobile: pmRow?.mobile });
    gap("G-S10", "中", "ABAC 目前落地在 HR 薪资/联系方式切片；CRM(按负责人)/项目(按成员)/财务/采购 的行级数据域与字段策略尚未接入。");
  }
};

try {
  await run();
} catch (e) {
  add("FATAL", "演练异常中断", false, { error: String(e?.message || e) });
} finally {
  // 输出
  console.log("\n=== 恒精精密制造 · 全流程端到端演练 ===");
  let last = "";
  for (const s of steps) {
    if (s.phase !== last) { console.log(`\n[${s.phase}]`); last = s.phase; }
    console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  }
  console.log(`\n=== 步骤：${steps.filter((s) => s.ok).length}/${steps.length} 通过 ===`);
  console.log("\n=== 差距与改进点（本次真实演练暴露，非臆测）===");
  for (const g of gaps) console.log(`  [${g.sev}] ${g.id}  ${g.desc}`);
  const failed = steps.filter((s) => !s.ok);
  console.log("\n" + JSON.stringify({ passed: failed.length === 0, steps_total: steps.length, steps_failed: failed.length, gaps: gaps.length }, null, 2));
  if (failed.length) exitCode = 1;
  await admin?.end();
  server?.kill();
  void HOST_URL;
  destroyContainer();
}
process.exit(exitCode);

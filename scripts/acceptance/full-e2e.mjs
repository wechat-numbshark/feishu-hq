// 双公司全打通端到端演练（npm run accept:full · docs/15 P3）。
// 主角：恒精精密制造（制造线）+ 云枢软件（软件线），同租户共存，全部走真实 API/executeTool + 真实 worker。
// 覆盖：A 制造线(AI 建 PR→审批；AI 下工单→释放) B 研发线(AI 需求→迭代→任务→工时→缺陷→版本发布→燃尽)
//       C 合同线(AI 起草→提交审批→财务批准→AI 签署→收款计划→开票回款；AI 建订阅→MRR/ARR)
//       D 人事线(HR 发假期额度→AI 请假→批准→余额扣减；绩效 自评→上级评→完成)
//       E 高层看板(管理员聚合断言) F AI 权限负例(普通员工被拒且审计留痕) G 赢单→自动立项(worker) H outbox 全发布。
// 纪律：任一断言失败 exit 1；全部结论来自本次真实执行（隔离容器自建自毁）。
import pg from "pg";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth, startStubModel,
  ADMIN_DB_URL, SESSION_SECRET, REPO, HOST_URL, api, destroyContainer,
} from "./lib.mjs";
import { T } from "./seed.mjs";
import { S, buildSwSeedStatements } from "./sw-seed.mjs";
import { M, buildMfgSeedStatements } from "./mfg-seed.mjs";

const steps = [];
const add = (phase, name, ok, detail) => steps.push({ phase, name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, { timeout = 45000, interval = 700, label = "" } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`poll_timeout:${label}`);
    await sleep(interval);
  }
}

let server, worker, stub, admin, exitCode = 0;
const wlogs = [];

const run = async () => {
  await ensureContainer({ fresh: true });
  const mig = await applyMigrations();
  await runSeed("./seed.mjs");
  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  for (const { sql, values } of buildMfgSeedStatements()) await admin.query(sql, values);
  for (const { sql, values } of buildSwSeedStatements()) await admin.query(sql, values);

  stub = await startStubModel();
  server = startServer({
    RATE_LIMIT_PER_MINUTE: "100000",
    MODEL_API_KEY: "stub-key",
    MODEL_BASE_URL: `http://127.0.0.1:${process.env.STUB_MODEL_PORT || 3900}/v1`,
    MODEL_NAME: "stub-model",
  });
  await waitHealth(server);
  worker = spawn("node", ["--experimental-strip-types", "apps/worker/src/main.ts"], {
    cwd: REPO,
    env: {
      ...process.env, DATABASE_URL: ADMIN_DB_URL, SESSION_SECRET,
      WORKER_OUTBOX_INTERVAL: "1000", WORKER_JOBS_INTERVAL: "1000", WORKER_SNAPSHOT_INTERVAL: "3600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (d) => wlogs.push(String(d)));
  worker.stderr.on("data", (d) => wlogs.push(String(d)));

  process.env.DATABASE_URL = ADMIN_DB_URL;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.MODEL_API_KEY = "";
  const { createSession } = await import("../../apps/api/src/session.ts");
  const { executeTool } = await import("../../apps/api/src/ai.ts");
  const ck = (personId, role = "employee") =>
    `hq_session=${createSession({ tenantId: T.tenant, personId, role, mode: "feishu" })}`;
  const ceoCk = ck(S.ceo, "tenant_admin");
  const ctoCk = ck(S.vpTech);
  const hrdCk = ck(S.hrd);
  const cfoCk = ck(S.cfo);
  const pmCk = ck(S.pm);
  const beCk = ck(S.beDev);
  const qaCk = ck(S.qa);
  const purchaserCk = ck(M.purchaser);
  const prodSupCk = ck(M.prodSupervisor);
  const payrollCk = ck(S.payroll);
  const pmIdentity = { tenantId: T.tenant, personId: S.pm, role: "employee", mode: "feishu" };
  const beIdentity = { tenantId: T.tenant, personId: S.beDev, role: "employee", mode: "feishu" };
  const qaIdentity = { tenantId: T.tenant, personId: S.qa, role: "employee", mode: "feishu" };
  const purchaserIdentity = { tenantId: T.tenant, personId: M.purchaser, role: "employee", mode: "feishu" };
  const prodSupIdentity = { tenantId: T.tenant, personId: M.prodSupervisor, role: "employee", mode: "feishu" };
  const payrollIdentity = { tenantId: T.tenant, personId: S.payroll, role: "employee", mode: "feishu" };

  // ── S0：AI 工具人员授权（L2 需 person grant；tenant_admin 自动全放行）+ 确定性审批流 ──
  await section0("S0地基", async () => {
    const grant = (personId, tool, action, domain, risk = "L2") =>
      admin.query(
        `INSERT INTO platform.ai_tool_authorizations (id, tenant_id, person_id, tool_name, action, risk_level, data_domain, effect, status, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'allow','active','full-e2e person grant')`,
        [randomUUID(), T.tenant, personId, tool, action, risk, domain]);
    await grant(S.pm, "create_contract", "sales.contract.create", "sales");
    await grant(S.pm, "update_contract_status", "sales.contract.update", "sales");
    await grant(S.pm, "create_subscription", "sales.subscription.create", "sales");
    await grant(S.pm, "create_requirement", "sw.requirement.create", "sw");
    await grant(S.pm, "create_task", "project.task.create", "project");
    await grant(S.pm, "create_iteration", "sw.iteration.create", "sw");
    await grant(S.qa, "create_defect", "sw.defect.create", "sw");
    await grant(S.beDev, "create_leave_request", "hr.leave.create", "hr");
    await grant(S.beDev, "create_it_ticket", "it.ticket.create", "it");
    await grant(M.purchaser, "create_purchase_requisition", "purchase.requisition.create", "purchase");
    await grant(M.prodSupervisor, "create_work_order", "mfg.workorder.create", "mfg");
    await grant(S.pd, "create_knowledge_item", "knowledge.item.create", "knowledge");
    await grant(S.vpTech, "create_milestone", "project.milestone.create", "project");
    await grant(S.vpTech, "log_work", "project.task.update", "project");
    await grant(S.beDev, "query_dashboard", "platform.dashboard.read", "platform", "L0"); // 有 grant 但非管理层 → 执行器角色硬校验负例
    // 合同审批流预置（person:cfo 确定性步骤）；请假审批流改为 person:HRD
    await admin.query(
      `INSERT INTO platform.approval_flows (id, tenant_id, code, name, module, steps, auto_approve_if_no_approver, is_active)
       VALUES ($1,$2,'contract','销售合同审批','sales',$3::jsonb,false,true)
       ON CONFLICT (tenant_id, code) DO UPDATE SET steps = EXCLUDED.steps`,
      [randomUUID(), T.tenant, JSON.stringify([{ order: 1, type: "person", person_id: S.cfo, label: "财务负责人" }])]
    );
    const f2 = await api(ceoCk, "PATCH", "/v1/approval-flows/leave_request", {
      steps: [{ order: 1, type: "person", person_id: S.hrd, label: "HRD" }],
    });
    const flowRow = (await admin.query(
      `SELECT steps::text AS steps FROM platform.approval_flows WHERE tenant_id=$1 AND code='contract'`, [T.tenant])).rows[0];
    add("S0地基", "14 个新 AI 工具 person 授权 + 合同流(person:cfo)/请假流(person:HRD) 确定性配置",
      f2.status === 200 && /person/.test(String(flowRow?.steps ?? "")),
      { leave_flow: f2.status, contract_flow: !!flowRow?.steps, migrations: mig.applied });
  });

  // ═══ A 制造线（恒精：AI 采购申请→审批；AI 下工单→释放→看板）═══
  let PART_MAT, PART_PRODUCT;
  await section0("A制造线", async () => {
    const mat = await api(prodSupCk, "POST", "/v1/mfg/parts", {
      part_number: "MAT-STEEL-40Cr", name: "40Cr 合金钢棒料", kind: "raw", uom: "KG", safety_stock: 200,
    });
    const prod = await api(prodSupCk, "POST", "/v1/mfg/parts", {
      part_number: "HX-SHAFT-001", name: "HX 系列传动轴", kind: "product", uom: "PCS",
    });
    PART_MAT = mat.body.id; PART_PRODUCT = prod.body.id;
    // AI 提交采购申请（受控写：purchaser 授权）
    const pr = await executeTool("create_purchase_requisition", {
      lines: [{ part_id: PART_MAT, quantity: 500, expected_unit_price_cents: 8200 }],
      need_date: "2026-10-15", reason: "HX-001 批量备料",
    }, purchaserIdentity, { traceId: "full-a1" });
    const prId = pr.requisition.id;
    // PR 提交→批准（采购链路真实端点）
    const submit = await api(purchaserCk, "POST", `/v1/purchase/requisitions/${prId}/submit`, {});
    const approve = await api(prodSupCk, "POST", `/v1/purchase/requisitions/${prId}/approve`, { comment: "同意备料" });
    const prRow = (await admin.query(
      `SELECT status, total_amount_cents, requester_person_id FROM purchase.requisitions WHERE tenant_id=$1 AND id=$2`,
      [T.tenant, prId])).rows[0];
    // 主数据：BOM + 工艺（发布后才能下工单）
    const bom = await api(prodSupCk, "POST", `/v1/mfg/parts/${PART_PRODUCT}/boms`, {
      lines: [{ child_part_id: PART_MAT, quantity: 2.5, scrap_rate: 0.02 }],
    });
    const bomRel = await api(prodSupCk, "POST", `/v1/mfg/boms/${bom.body.id}/release`, {});
    const routing = await api(prodSupCk, "POST", `/v1/mfg/parts/${PART_PRODUCT}/routings`, {
      ops: [{ name: "车削", work_center: "WC-CNC-01", standard_hours: 0.5, inspect: true },
            { name: "磨削", work_center: "WC-GRIND-01", standard_hours: 0.3, inspect: true }],
    });
    const rtRel = await api(prodSupCk, "POST", `/v1/mfg/routings/${routing.body.id}/release`, {});
    // AI 下生产工单（受控写：prodSupervisor 授权；自动引用最新已发布 BOM/工艺）
    const wo = await executeTool("create_work_order", {
      product_part_id: PART_PRODUCT, planned_qty: 200, priority: "high",
      planned_start: "2026-09-29", planned_finish: "2026-10-20",
    }, prodSupIdentity, { traceId: "full-a2" });
    const woRel = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${wo.work_order.id}/release`, {});
    const woRow = (await admin.query(
      `SELECT status, bom_id, routing_id, planned_qty FROM mfg.work_orders WHERE tenant_id=$1 AND id=$2`,
      [T.tenant, wo.work_order.id])).rows[0];
    add("A制造线", "AI 建 PR(¥4,100)→提交→批准；BOM/工艺发布；AI 下工单 200 件→释放(released)且自动挂 BOM+工艺",
      prRow?.status === "approved" && Number(prRow.total_amount_cents) === 4100000
      && mat.status === 201 && prod.status === 201 && bomRel.status === 200 && rtRel.status === 200
      && woRow?.status === "released" && !!woRow?.bom_id && !!woRow?.routing_id && Number(woRow.planned_qty) === 200,
      { pr_status: prRow?.status, pr_total: prRow?.total_amount_cents, wo_status: woRow?.status });
  });

  // ═══ B 研发线（云枢：AI 需求→迭代→任务→工时→缺陷→版本发布→燃尽）═══
  let PRJ, ITER, VER;
  await section0("B研发线", async () => {
    const acc = await api(pmCk, "POST", "/v1/crm/accounts", { name: "恒精精密二期", industry: "汽车零部件制造" });
    const prj = await api(ctoCk, "POST", "/v1/projects", {
      name: "云枢 SaaS 平台 V2 研发", customer_name: "云枢软件自研", owner_person_id: S.vpTech,
      budget_cents: 80000000, start_date: "2026-09-01", end_date: "2026-12-31",
    });
    PRJ = prj.body.id;
    await api(ctoCk, "POST", `/v1/projects/${PRJ}/members`, { person_id: S.beDev });
    await api(ctoCk, "POST", `/v1/projects/${PRJ}/members`, { person_id: S.qa });
    // AI 里程碑（受控写）
    const ms = await executeTool("create_milestone", {
      project_id: PRJ, name: "V2.0 发布", due_date: "2026-11-30", description: "计费自助化+性能优化",
    }, { tenantId: T.tenant, personId: S.vpTech, role: "employee", mode: "feishu" }, { traceId: "full-b1" });
    // AI 需求入池（受控写）
    const req1 = await executeTool("create_requirement", {
      title: "订阅计费自助化（客户可在线扩容席位）", project_id: PRJ, source: "customer", priority: "high", story_points: 13,
    }, pmIdentity, { traceId: "full-b2" });
    // AI 建迭代（受控写）
    const iter = await executeTool("create_iteration", {
      project_id: PRJ, name: "Sprint 1", goal: "计费自助化后端", start_date: "2026-09-26", end_date: "2026-10-09", capacity_points: 30,
    }, pmIdentity, { traceId: "full-b3" });
    ITER = iter.iteration.id;
    const iterStart = await api(ctoCk, "POST", `/v1/sw/iterations/${ITER}/start`, {});
    // AI 建任务挂迭代（受控写；create_task 扩展）
    const task = await executeTool("create_task", {
      project_id: PRJ, title: "订阅扩容 API", assignee_person_id: S.beDev, story_points: 8, priority: "high", iteration_id: ITER,
    }, pmIdentity, { traceId: "full-b4" });
    // AI 登记工时 ×2（受控写）
    await executeTool("log_work", { task_id: task.task.id, hours: 6 }, { tenantId: T.tenant, personId: S.vpTech, role: "employee", mode: "feishu" }, { traceId: "full-b5" });
    const lw = await executeTool("log_work", { task_id: task.task.id, hours: 2.5 }, { tenantId: T.tenant, personId: S.vpTech, role: "employee", mode: "feishu" }, { traceId: "full-b6" });
    // 任务完成 → 燃尽下降
    const done = await api(beCk, "PATCH", `/v1/tasks/${task.task.id}`, { status: "done" });
    // AI 提交缺陷（受控写：qa）→ 修复指向版本
    const defect = await executeTool("create_defect", {
      title: "席位扩容后配额未即时生效", project_id: PRJ, severity: "critical",
      repro_steps: "1. 扩容 10 席 2. 立即邀请成员 3. 提示无可用席位", environment: "staging/V2.0-rc1", assignee_person_id: S.beDev,
    }, qaIdentity, { traceId: "full-b7" });
    // 版本创建→挂缺陷→发布（缺陷自动 verified）
    const ver = await api(ctoCk, "POST", "/v1/sw/versions", {
      project_id: PRJ, version_number: "V2.0.0", iteration_id: ITER, release_notes: "计费自助化首发",
    });
    VER = ver.body.id;
    const fixed = await api(beCk, "PATCH", `/v1/sw/defects/${defect.defect.id}`, { status: "fixed", fixed_in_version_id: VER });
    const rel = await api(ctoCk, "POST", `/v1/sw/versions/${VER}/release`, {});
    const burn = await api(ctoCk, "GET", `/v1/sw/iterations/${ITER}/burndown`);
    const board = await api(ctoCk, "GET", `/v1/sw/iterations/${ITER}/board`);
    // 完成里程碑 → 发 project.milestone.completed.v1（H 段断言）
    const msDone = await api(ctoCk, "PATCH", `/v1/milestones/${ms.milestone.id}`, { status: "completed" });
    const defectRow = (await admin.query(
      `SELECT status, resolved_at IS NOT NULL AS resolved FROM sw.defects WHERE tenant_id=$1 AND id=$2`,
      [T.tenant, defect.defect.id])).rows[0];
    const msRow = (await admin.query(
      `SELECT count(*)::int AS n FROM project.milestones WHERE tenant_id=$1 AND project_id=$2 AND name='V2.0 发布'`,
      [T.tenant, PRJ])).rows[0];
    add("B研发线", "AI 里程碑→需求(13pt)→迭代 Sprint1(active)→任务挂迭代(8pt)→AI 工时 8.5h→done→AI 缺陷(critical)→修复挂版本→发布→缺陷自动 verified→燃尽/看板读回→里程碑 completed(发事件)",
      msRow.n === 1 && Number(req1.requirement.story_points) === 13 && iterStart.status === 200
      && Number(lw.task.actual_hours) === 8.5 && done.status === 200
      && fixed.status === 200 && rel.status === 200 && rel.body.status === "released"
      && defectRow?.status === "verified" && defectRow?.resolved
      && Number(burn.body?.remaining_points) === 0 && Number(burn.body?.total_points) === 8
      && board.body?.board?.done?.length === 1 && msDone.status === 200,
      { ms: msRow.n, sp: req1.requirement.story_points, hours: lw.task.actual_hours,
        ver: rel.body?.status, defect: defectRow?.status, remaining: burn.body?.remaining_points, msDone: msDone.status });
  });

  // ═══ C 合同+订阅线（AI 起草→审批→签署→收款计划→开票回款；订阅 MRR/ARR）═══
  await section0("C合同订阅", async () => {
    const acc = await api(pmCk, "POST", "/v1/crm/accounts", { name: "恒精精密（合同客户）", industry: "汽车零部件制造" });
    const ACC = acc.body.id;
    // AI 起草合同（受控写）
    const c = await executeTool("create_contract", {
      title: "恒精数字化平台实施与运维服务合同", account_id: ACC, contract_type: "implementation",
      amount_cents: 36000000, payment_terms: "4:4:2 分三期", start_date: "2026-10-01", end_date: "2027-09-30",
    }, pmIdentity, { traceId: "full-c1" });
    const contractId = c.contract.id;
    // AI 提交评审（自动建审批实例）
    const sub = await executeTool("update_contract_status", { contract_id: contractId, action: "submit" }, pmIdentity, { traceId: "full-c2" });
    const instId = sub.approval_instance_id;
    // 财务总监（person 步骤）批准 → 合同回写 approved
    const decide = await api(cfoCk, "POST", `/v1/approvals/${instId}/decide`, { decision: "approved", comment: "条款与价盘合规" });
    const approvedRow = (await admin.query(
      `SELECT status FROM sales.contracts WHERE tenant_id=$1 AND id=$2`, [T.tenant, contractId])).rows[0];
    // AI 签署（受控写；发 signed 事件）
    const sign = await executeTool("update_contract_status", { contract_id: contractId, action: "sign", sign_date: "2026-09-29" }, pmIdentity, { traceId: "full-c3" });
    // 按合同生成收款计划（真实端点，两期）
    const plans = await api(pmCk, "POST", `/v1/sales/contracts/${contractId}/payment-plans`, {
      lines: [
        { due_date: "2026-10-31", amount_cents: 14400000, milestone_title: "首期（预付 40%）" },
        { due_date: "2027-03-31", amount_cents: 14400000, milestone_title: "二期（验收 40%）" },
      ],
    });
    // 开票（第一期）→ sent → 回款 → paid
    const inv = await api(cfoCk, "POST", "/v1/finance/invoices", {
      invoice_type: "receivable", counterparty_name: "恒精精密（合同客户）", amount_cents: 14400000,
      invoice_number: "INV-FULL-2026-0001", due_date: "2026-10-31",
    });
    await api(cfoCk, "PATCH", `/v1/finance/invoices/${inv.body.id}`, { status: "sent" });
    const pay = await api(cfoCk, "POST", "/v1/finance/payments", {
      customer_name: "恒精精密（合同客户）", amount_cents: 14400000, due_date: "2026-10-31",
      milestone: "合同:" + c.contract.contract_no, status: "planned",
    });
    await api(cfoCk, "PATCH", `/v1/finance/payments/${pay.body.id}`, { status: "paid" });
    // 发票同步回款 → 账龄出清（0 未结）
    await api(cfoCk, "PATCH", `/v1/finance/invoices/${inv.body.id}`, { status: "paid", paid_cents: 14400000 });
    const aging = await api(cfoCk, "GET", "/v1/finance/receivables/aging");
    // AI 建订阅（active → MRR 生效事件）
    const sub1 = await executeTool("create_subscription", {
      account_id: ACC, plan_name: "云枢 SaaS 专业版", mrr_cents: 960000, seats: 40, status: "active",
      contract_id: contractId, billing_cycle: "monthly",
    }, pmIdentity, { traceId: "full-c4" });
    const metrics = await api(pmCk, "GET", "/v1/sales/subscriptions/metrics");
    add("C合同订阅", "AI 起草合同(¥36万)→AI 提交→财务批准(approved)→AI 签署(signed+事件)→两期收款计划→开票回款 paid；AI 建订阅(active ¥9,600/月)→MRR=96万分/ARR=1152万分",
      decide.status === 200 && approvedRow?.status === "approved" && sign.status === "signed"
      && plans.status === 201 && plans.body?.items?.length === 2 && pay.status === 201
      && Number(aging.body?.buckets?.outstanding_cents) === 0
      && sub1.subscription?.status === "active"
      && Number(metrics.body?.mrr_cents) === 960000 && Number(metrics.body?.arr_cents) === 11520000,
      { contract: approvedRow?.status, sign: sign.status, plans: plans.body?.items?.length,
        aging_outstanding: aging.body?.buckets?.outstanding_cents, mrr: metrics.body?.mrr_cents, arr: metrics.body?.arr_cents });
  });

  // ═══ D 人事线（假期额度→AI 请假→批准→余额扣减；绩效闭环）═══
  await section0("D人事线", async () => {
    // HRD 发年假额度 10 天（真实端点）
    const grant = await api(hrdCk, "POST", "/v1/hr/leave-balances", {
      person_id: S.beDev, leave_type: "annual", year: 2026, entitled_days: 10,
    });
    // AI 提交请假（受控写：自动进入审批流）
    const leave = await executeTool("create_leave_request", {
      leave_type: "annual", start_date: "2026-10-12", end_date: "2026-10-13", days: 2, reason: "家中事务",
    }, beIdentity, { traceId: "full-d1" });
    // HRD（person 步骤）批准 → 同事务扣减余额
    const decide = await api(hrdCk, "POST", `/v1/approvals/${leave.approval_instance_id}/decide`, { decision: "approved", comment: "批准" });
    const leaveRow = (await admin.query(
      `SELECT status FROM hr.leave_requests WHERE tenant_id=$1 AND id=$2`, [T.tenant, leave.leave_id])).rows[0];
    const bal = (await admin.query(
      `SELECT entitled_days, used_days, (entitled_days + accrued_days + carried_over_days - used_days) AS remaining
       FROM hr.leave_balances WHERE tenant_id=$1 AND person_id=$2 AND leave_type='annual' AND year=2026`,
      [T.tenant, S.beDev])).rows[0];
    // 绩效：HRD 建考核 → 被评人自评 → 上级评定 → 完成
    const review = await api(hrdCk, "POST", "/v1/hr/performance-reviews", {
      cycle: "2026-H2", reviewee_person_id: S.beDev, reviewer_person_id: S.vpTech,
      goals: [{ title: "交付订阅计费后端", weight: 60 }, { title: "线上缺陷率<0.5%", weight: 40 }],
    });
    const self = await api(beCk, "POST", `/v1/hr/performance-reviews/${review.body.id}/self-review`, {
      self_rating: 4, self_comments: "计费后端按期交付",
    });
    const mgr = await api(ctoCk, "POST", `/v1/hr/performance-reviews/${review.body.id}/manager-review`, {
      manager_rating: 5, manager_comments: "超出预期，主动补齐幂等与回滚",
    });
    const rvRow = (await admin.query(
      `SELECT status, self_rating, manager_rating, overall_rating FROM hr.performance_reviews WHERE tenant_id=$1 AND id=$2`,
      [T.tenant, review.body.id])).rows[0];
    add("D人事线", "HRD 发年假 10 天→AI 请假 2 天→HRD 批准→余额 used=2/remaining=8；绩效 2026-H2 自评 4→上级 5→completed 总分 4.5",
      grant.status === 201 && decide.status === 200
      && Number(bal?.entitled_days) === 10 && Number(bal?.used_days) === 2 && Number(bal?.remaining) === 8
      && self.status === 200 && mgr.status === 200
      && rvRow?.status === "completed" && Number(rvRow?.overall_rating) === 4.5,
      { bal, review: { s: rvRow?.status, o: rvRow?.overall_rating }, decide: decide.status, inst: leave.approval_instance_id, leave_status: leaveRow?.status });
  });

  // ═══ E 高层看板（双公司聚合 + AI query_dashboard）═══
  await section0("E看板", async () => {
    const dash = await api(ceoCk, "GET", "/v1/dashboard/executive");
    const d = dash.body;
    const aiDash = await executeTool("query_dashboard", {}, { tenantId: T.tenant, personId: S.ceo, role: "tenant_admin", mode: "feishu" }, { traceId: "full-e1" });
    const agingOk = d?.finance?.ar_aging_cents && typeof d.finance.ar_aging_cents.d_0_30 === "number";
    add("E看板", "管理员 GET /v1/dashboard/executive：MRR=96万分/ARR、制造 KPI(未结工单/良率/OTD)、研发(开放缺陷/迭代)、应收账龄分桶、待审批、headcount 一次聚合；AI query_dashboard 同口径",
      dash.status === 200
      && Number(d?.subscriptions?.mrr_cents) === 960000
      && !!d?.manufacturing && Number(d?.manufacturing?.open_work_orders) >= 1
      && Number(d?.delivery?.open_defects) >= 1 && agingOk
      && Number(d?.approvals_pending) >= 0 && Number(d?.hr?.headcount) >= 15
      && Number(aiDash?.subscriptions?.mrr_cents) === 960000,
      { status: dash.status, mrr: d?.subscriptions?.mrr_cents, mfg: d?.manufacturing, aging: d?.finance?.ar_aging_cents, hr: d?.hr?.headcount });
  });

  // ═══ F AI 权限负例（默认拒绝 + 审计留痕 + 角色硬校验）═══
  await section0("F权限负例", async () => {
    // 无授权员工调 L2 工具 → 拒绝 + authorization_decisions denied
    let denied1 = null;
    try { await executeTool("create_contract", { title: "越权合同", account_id: "00000000-0000-4000-8000-00000000000f", amount_cents: 100 }, payrollIdentity, { traceId: "full-f1" }); }
    catch (e) { denied1 = String(e?.message || e); }
    // 有 grant 但非管理层 → query_dashboard 执行器角色硬校验拒绝（failure 审计）
    let denied2 = null;
    try { await executeTool("query_dashboard", {}, beIdentity, { traceId: "full-f2" }); }
    catch (e) { denied2 = String(e?.message || e); }
    // HTTP 看板：普通员工 403
    const http403 = await api(payrollCk, "GET", "/v1/dashboard/executive");
    const audits = (await admin.query(
      `SELECT (SELECT count(*) FROM audit.authorization_decisions WHERE tenant_id=$1 AND subject_id='ai:'||$2 AND allowed=false AND trace_id='full-f1') AS dec_denied,
              (SELECT count(*) FROM audit.audit_events WHERE tenant_id=$1 AND actor_id='ai:'||$2 AND outcome IN ('denied','failure') AND trace_id IN ('full-f1','full-f2')) AS ev_denied`,
      [T.tenant, S.payroll])).rows[0];
    const ev2 = (await admin.query(
      `SELECT count(*)::int AS n FROM audit.audit_events WHERE tenant_id=$1 AND actor_id='ai:'||$2 AND outcome='failure' AND trace_id='full-f2'`,
      [T.tenant, S.beDev])).rows[0];
    const ev2all = (await admin.query(
      `SELECT outcome, trace_id FROM audit.audit_events WHERE tenant_id=$1 AND trace_id IN ('full-f1','full-f2')`,
      [T.tenant])).rows;
    add("F权限负例", "无授权 create_contract→permission_denied(decision denied 留痕)；有 grant 非管理层 query_dashboard→executive_role_required(failure 留痕)；HTTP 看板 403",
      /permission_denied/.test(denied1 ?? "") && /permission_denied/.test(denied2 ?? "")
      && http403.status === 403 && Number(audits?.dec_denied) === 1 && Number(audits?.ev_denied) >= 1 && Number(ev2?.n) === 1,
      { denied1, denied2, http: http403.status, dec_denied: audits?.dec_denied, ev_denied: audits?.ev_denied, ev2: ev2?.n, ev2all });
  });

  // ═══ F2 AI 对话路径（桩模型确定性驱动工具调用 + 权限继承）═══
  await section0("F2对话路径", async () => {
    const chat1 = await api(qaCk, "POST", "/v1/ai/chat", {
      message: "[[tool:create_defect:{\"title\":\"AI 对话提交：报表导出乱码\",\"severity\":\"minor\",\"project_id\":\"" + PRJ + "\"}]]",
    });
    const chat2 = await api(payrollCk, "POST", "/v1/ai/chat", {
      message: "[[tool:create_contract:{\"title\":\"越权合同\",\"account_id\":\"00000000-0000-4000-8000-00000000000f\",\"amount_cents\":100}]]",
    });
    await sleep(300);
    const defectRow = (await admin.query(
      `SELECT id, severity FROM sw.defects WHERE tenant_id=$1 AND title LIKE 'AI 对话提交%'`, [T.tenant])).rows[0];
    const toolMsg = chat2.body?.conversation_id ? (await admin.query(
      `SELECT content FROM platform.ai_messages WHERE tenant_id=$1 AND conversation_id=$2 AND role='tool' ORDER BY created_at DESC LIMIT 1`,
      [T.tenant, chat2.body.conversation_id])).rows[0] : null;
    add("F2对话路径", "对话驱动工具：pm 经 /v1/ai/chat 提交缺陷成功落库；payroll 越权调合同工具 → tool 消息含 permission_denied",
      chat1.status === 200 && !!defectRow?.id && defectRow.severity === "minor"
      && chat2.status === 200 && /permission_denied/.test(String(toolMsg?.content ?? "")),
      { chat1: chat1.status, defect: defectRow?.id, chat2: chat2.status, toolMsg: String(toolMsg?.content ?? "").slice(0, 120) });
  });

  // ═══ G 赢单→自动立项（真实 worker：outbox→job→项目+里程碑）═══
  await section0("G自动立项", async () => {
    const acc = await api(pmCk, "POST", "/v1/crm/accounts", { name: "华驰动力（自动立项）", industry: "汽车 Tier-1" });
    const opp = await api(pmCk, "POST", "/v1/crm/opportunities", {
      name: "华驰 MES 二期", customer_name: "华驰动力", account_id: acc.body.id, amount_cents: 20000000, stage: "proposal",
    });
    const won = await api(pmCk, "POST", `/v1/crm/opportunities/${opp.body.id}/stage`, { stage: "won" });
    const project = await pollUntil(async () => {
      const r = (await admin.query(
        `SELECT p.id, p.code, p.status, p.source_opportunity_id,
                (SELECT count(*)::int FROM project.milestones m WHERE m.tenant_id=p.tenant_id AND m.project_id=p.id AND m.name='项目启动') AS ms_n
         FROM project.projects p WHERE p.tenant_id=$1 AND p.source_opportunity_id=$2`,
        [T.tenant, opp.body.id])).rows[0];
      return r && r.ms_n === 1 ? r : null;
    }, { label: "auto project from won", timeout: 45000 }).catch(() => null);
    const job = (await admin.query(
      `SELECT status FROM platform.jobs WHERE tenant_id=$1 AND kind='create_project_from_opportunity' AND payload->>'opportunity_id'=$2`,
      [T.tenant, opp.body.id])).rows[0];
    add("G自动立项", "赢单→outbox 事件→worker 入队 create_project_from_opportunity→自动建项目(active)+首个里程碑「项目启动」；作业 succeeded",
      won.status === 200 && !!project?.id && project.status === "active" && job?.status === "succeeded",
      { won: won.status, project: project?.code, job: job?.status });
  });

  // ═══ H outbox 全发布（新增事件类型 0 失败）═══
  await section0("H事件总线", async () => {
    const EXPECT = ["sales.contract.signed.v1", "sales.subscription.activated.v1", "sw.requirement.created.v1",
      "sw.defect.created.v1", "sw.version.released.v1", "project.milestone.completed.v1", "hr.review.completed.v1"];
    const agg = await pollUntil(async () => {
      const r = (await admin.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE published_at IS NOT NULL)::int AS pub,
                count(*) FILTER (WHERE attempts>=5 AND published_at IS NULL)::int AS err,
                (SELECT array(select distinct event_type from platform.outbox_events where tenant_id=$1)) AS types
         FROM platform.outbox_events WHERE tenant_id=$1`, [T.tenant])).rows[0];
      return r.total === r.pub && r.err === 0 && EXPECT.every((t) => (r.types ?? []).includes(t)) ? r : null;
    }, { label: "outbox all published", timeout: 45000 }).catch(() => null);
    add("H事件总线", "本轮 7 类新事件（合同签署/订阅生效/需求/缺陷/版本发布/里程碑/绩效）全部 published 且 0 死信",
      !!agg, agg ? { total: agg.total, types: agg.types.length } : { note: "未全发布；worker 尾部=" + wlogs.join("").slice(-300) });
  });
};

async function section0(name, fn) {
  try { await fn(); } catch (e) { add(name, "阶段异常中断", false, { error: String(e?.message || e) }); }
}

try {
  await run();
} catch (e) {
  add("FATAL", "演练异常中断", false, { error: String(e?.message || e), workerLogs: wlogs.join("").slice(-400) });
} finally {
  console.log("\n=== 双公司全打通 · 端到端演练（恒精制造 × 云枢软件）===");
  let last = "";
  for (const s of steps) {
    if (s.phase !== last) { console.log(`\n[${s.phase}]`); last = s.phase; }
    console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  }
  console.log(`\n=== 步骤：${steps.filter((s) => s.ok).length}/${steps.length} 通过 ===`);
  const failed = steps.filter((s) => !s.ok);
  console.log("\n" + JSON.stringify({ passed: failed.length === 0, steps_total: steps.length, steps_failed: failed.length }, null, 2));
  if (failed.length) exitCode = 1;
  await admin?.end();
  server?.kill();
  worker?.kill();
  stub?.close();
  destroyContainer();
}
process.exit(exitCode);

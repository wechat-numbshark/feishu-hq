// 制造业 P0/P1/P2 全链路端到端演练（npm run accept:mfg2）。
// 覆盖：主数据/BOM/工艺 → 采购 PR→PO→收货→来料检→库存 → 三单匹配→应付
//       → 工单下达/领料/报工/完工成本 → 设备台账/点检/停机/保养/OEE
//       → 销售 SO/发货出库/毛利 → Offer→入职作业联动 → ABAC 行级域 → 中文检索回退
//       → outbox 生产者 + 真实 worker 消费（published）。
// 纪律：任一断言失败 exit 1；全部结论来自本次真实执行（隔离容器自建自毁）。
import pg from "pg";
import { spawn } from "node:child_process";
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth,
  ADMIN_DB_URL, SESSION_SECRET, REPO, api, destroyContainer,
} from "./lib.mjs";
import { T } from "./seed.mjs";
import { M, buildMfgSeedStatements } from "./mfg-seed.mjs";

const steps = [];
const add = (phase, name, ok, detail) => steps.push({ phase, name, ok: !!ok, detail });
const section = async (name, fn) => {
  try { await fn(); } catch (e) { add(name, "阶段异常中断", false, { error: String(e?.message || e) }); }
};

let server, worker, admin, exitCode = 0;
const wlogs = [];
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

const run = async () => {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  await runSeed("./seed.mjs");
  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  for (const { sql, values } of buildMfgSeedStatements()) await admin.query(sql, values);

  server = startServer({ RATE_LIMIT_PER_MINUTE: "100000" });
  await waitHealth(server);
  // 真实 worker：outbox/jobs 1s 节奏；无飞书凭据 → 通知静默降级、事件仍 published
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
  const ck = (personId, role = "employee") =>
    `hq_session=${createSession({ tenantId: T.tenant, personId, role, mode: "feishu" })}`;
  const adminCk = ck(T.admin, "tenant_admin");
  const purchaserCk = ck(M.purchaser);
  const purchaseMgrCk = ck(M.purchaseMgr);
  const qcCk = ck(M.qc);
  const financeCk = ck(M.financeDirector);
  const processEngCk = ck(M.processEng);
  const salesRepCk = ck(M.salesRep);
  const prodSupCk = ck(M.prodSupervisor);

  const onhandQty = async (partId) => {
    const r = await api(adminCk, "GET", `/v1/stock/onhand?part_id=${partId}`);
    return Number(r.body?.items?.[0]?.quantity ?? 0);
  };
  const movementCount = async (partId, type) => {
    const r = await api(adminCk, "GET", `/v1/stock/movements?part_id=${partId}&movement_type=${type}`);
    return (r.body?.items ?? []).length;
  };

  // ═══ P1 主数据：物料/产品/BOM/工艺路线 ═══════════════════════
  let BAR, KEY, FIN, BOM, RTG, SOP;
  await section("P1主数据", async () => {
    const bar = await api(adminCk, "POST", "/v1/mfg/parts", { part_number: "BAR-42CRMO", name: "42CrMo 合金钢棒料", kind: "raw", uom: "KG", standard_unit_cost_cents: 2100 });
    const key = await api(adminCk, "POST", "/v1/mfg/parts", { part_number: "KEY-6614", name: "6614 平键", kind: "raw", uom: "PCS", standard_unit_cost_cents: 500 });
    const fin = await api(adminCk, "POST", "/v1/mfg/parts", { part_number: "FIN-HX300", name: "HX-300 传动轴", kind: "product", uom: "PCS", standard_unit_cost_cents: 5500 });
    BAR = bar.body.id; KEY = key.body.id; FIN = fin.body.id;
    const list = await api(adminCk, "GET", "/v1/mfg/parts?search=" + encodeURIComponent("42CrMo"));
    add("P1主数据", "3 料号创建 + 检索 42CrMo 命中 1",
      bar.status === 201 && key.status === 201 && fin.status === 201 && (list.body?.items ?? []).length === 1,
      { statuses: [bar.status, key.status, fin.status], hits: (list.body?.items ?? []).length });

    const bom = await api(adminCk, "POST", `/v1/mfg/parts/${FIN}/boms`, {
      version: "V1.0", lines: [
        { child_part_id: BAR, quantity: 1, scrap_rate: 0.02 },
        { child_part_id: KEY, quantity: 1 },
      ],
    });
    BOM = bom.body.id;
    const rel = await api(adminCk, "POST", `/v1/mfg/boms/${BOM}/release`, {});
    const rel2 = await api(adminCk, "POST", `/v1/mfg/boms/${BOM}/release`, {});
    const read = await api(adminCk, "GET", `/v1/mfg/boms/${BOM}`);
    add("P1主数据", "BOM 创建→发布→读回 2 行；重复发布 409",
      bom.status === 201 && rel.body?.status === "released" && rel2.status === 409 && (read.body?.lines ?? []).length === 2,
      { bom: bom.status, rel: rel.body?.status, rel2: rel2.status, lines: (read.body?.lines ?? []).length });

    const rtg = await api(adminCk, "POST", `/v1/mfg/parts/${FIN}/routings`, {
      version: "V1.0", ops: [
        { seq_no: 10, name: "粗车", work_center: "WC-1", standard_hours: 0.4 },
        { seq_no: 20, name: "精磨", work_center: "WC-1", standard_hours: 0.3, inspect: true },
        { seq_no: 30, name: "终检", work_center: "QC-1", standard_hours: 0.1, inspect: true },
      ],
    });
    RTG = rtg.body.id;
    const rtRel = await api(adminCk, "POST", `/v1/mfg/routings/${RTG}/release`, {});
    const rtRead = await api(adminCk, "GET", `/v1/mfg/routings/${RTG}`);
    add("P1主数据", "工艺路线 3 工序→发布→读回 ops=3",
      rtg.status === 201 && rtRel.body?.status === "released" && (rtRead.body?.ops ?? []).length === 3,
      { rtg: rtg.status, ops: (rtRead.body?.ops ?? []).length });

    // 中文 SOP（供 P11 检索；worker 30s 周期索引）
    const cat = await api(adminCk, "POST", "/v1/knowledge/categories", { name: "工艺规程" });
    const sop = await api(adminCk, "POST", "/v1/knowledge/items", {
      category_id: cat.body.id, title: "HX-300 传动轴车加工作业指导书",
      content: "本作业指导书规定传动轴粗车、半精车、精车各工序的装夹方式、刀具选择、切削参数与检验要求：粗车留精磨余量，主轴转速与进给量按材料硬度分档执行，加工后表面不得有振刀纹，保证一次交检合格率。Rough turning shall leave grinding allowance for the alloy steel bar stock before finishing.",
      classification: "internal",
    });
    SOP = sop.body.id;
    const cjkHit = await api(adminCk, "GET", "/v1/knowledge/items?search=" + encodeURIComponent("传动轴"));
    add("P1主数据", "SOP 建档 + 中文子串检索(P2b 列表回退)命中", sop.status === 201 && (cjkHit.body?.items ?? []).length >= 1,
      { sop: sop.status, hits: (cjkHit.body?.items ?? []).length });
  });

  // ═══ P2 采购链：PR→PO→收货→来料检→库存 ═════════════════════
  let SUP, PO1, PO2, R1, R2, R3, PR1, IQC1;
  await section("P2采购", async () => {
    const sup = await api(purchaseMgrCk, "POST", "/v1/purchase/suppliers", { name: "华兴特钢", supplier_code: "SUP-HX01", lead_time_days: 15 });
    SUP = sup.body.id;
    add("P2采购", "供应商创建", sup.status === 201, { status: sup.status });

    const pr = await api(purchaserCk, "POST", "/v1/purchase/requisitions", {
      reason: "HX-300 首批量产投料", need_date: "2026-10-20",
      lines: [{ part_id: BAR, quantity: 200, expected_unit_price_cents: 2100 }],
    });
    PR1 = pr.body.id;
    const submit = await api(purchaserCk, "POST", `/v1/purchase/requisitions/${PR1}/submit`, {});
    const approve = await api(purchaseMgrCk, "POST", `/v1/purchase/requisitions/${PR1}/approve`, {});
    const convert = await api(purchaserCk, "POST", `/v1/purchase/requisitions/${PR1}/convert`, { supplier_id: SUP });
    PO1 = convert.body.id;
    add("P2采购", "PR(200×¥21)→提交→批准→转 PO1(4200 元)",
      pr.status === 201 && pr.body.total_amount_cents == 420000 && submit.body?.status === "submitted"
      && approve.body?.status === "approved" && convert.status === 201 && convert.body?.total_amount_cents == 420000,
      { pr: pr.status, total: pr.body?.total_amount_cents, st: [submit.body?.status, approve.body?.status, convert.body?.status] });

    const poApprove = await api(purchaseMgrCk, "POST", `/v1/purchase/orders/${PO1}/approve`, {});
    const over = await api(purchaserCk, "POST", `/v1/purchase/orders/${PO1}/receipts`, { lines: [{ order_line_id: (await api(adminCk, "GET", `/v1/purchase/orders/${PO1}`)).body.lines[0].id, quantity: 250 }] });
    add("P2采购", "PO1 批准；超量收货 250>200 被拒 400 over_receive",
      poApprove.body?.status === "approved" && over.status === 400 && String(over.body?.error).startsWith("over_receive_not_allowed"),
      { approve: poApprove.body?.status, over: over.status, err: over.body?.error });

    const ol1 = (await api(adminCk, "GET", `/v1/purchase/orders/${PO1}`)).body.lines[0].id;
    const rec1 = await api(purchaserCk, "POST", `/v1/purchase/orders/${PO1}/receipts`, { lines: [{ order_line_id: ol1, quantity: 100 }], notes: "首批到货" });
    R1 = rec1.body.id;
    const iqc1 = await api(qcCk, "GET", `/v1/qms/inspections?receipt_id=${R1}&result=pending`);
    IQC1 = (iqc1.body?.items ?? [])[0]?.id;
    const v1 = await api(qcCk, "POST", `/v1/qms/inspections/${IQC1}/verdict`, { result: "pass", note: "尺寸全检合格" });
    const barQty1 = await onhandQty(BAR);
    const poAfter1 = await api(adminCk, "GET", `/v1/purchase/orders/${PO1}`);
    add("P2采购", "收货100→IQC 自动生成→判定 pass→库存 +100，收货单 accepted，PO1 partially_received",
      rec1.status === 201 && IQC1 && v1.body?.result === "pass" && barQty1 === 100
      && v1.body?.receipt_handled !== false && poAfter1.body?.status === "partially_received",
      { rec: rec1.status, iqc: !!IQC1, verdict: v1.body?.result, onhand: barQty1, po: poAfter1.body?.status });

    const rec2 = await api(purchaserCk, "POST", `/v1/purchase/orders/${PO1}/receipts`, { lines: [{ order_line_id: ol1, quantity: 100 }] });
    R2 = rec2.body.id;
    const rl2 = (await api(adminCk, "GET", `/v1/purchase/receipts/${R2}`)).body.lines[0];
    const IQC2 = (await api(qcCk, "GET", `/v1/qms/inspections?receipt_id=${R2}&result=pending`)).body.items[0].id;
    await api(qcCk, "POST", `/v1/qms/inspections/${IQC2}/measurements`, { items: [{ characteristic: "外径φ30", standard_value: "30±0.1", measured_value: 30.05, result: "pass" }] });
    const v2 = await api(qcCk, "POST", `/v1/qms/inspections/${IQC2}/verdict`, {
      result: "pass",
      accepted_quantities: [{ receipt_line_id: rl2.id, accepted_quantity: 95, rejected_quantity: 5 }],
      note: "5 支锈蚀隔离",
    });
    const barQty2 = await onhandQty(BAR);
    const rcpt2 = await api(adminCk, "GET", `/v1/purchase/receipts/${R2}`);
    const poAfter2 = await api(adminCk, "GET", `/v1/purchase/orders/${PO1}`);
    add("P2采购", "收货2×100→部分合格判定(95收/5退)→库存 195，收货单 partial_accepted，PO1 收满 received",
      v2.body?.result === "pass" && barQty2 === 195 && rcpt2.body?.status === "partial_accepted" && poAfter2.body?.status === "received",
      { onhand: barQty2, receipt: rcpt2.body?.status, po: poAfter2.body?.status });

    // PO2（直采平键）
    const po2 = await api(purchaseMgrCk, "POST", "/v1/purchase/orders", {
      supplier_id: SUP, notes: "平键配套直采",
      lines: [{ part_id: KEY, quantity: 60, unit_price_cents: 500 }],
    });
    PO2 = po2.body.id;
    await api(purchaseMgrCk, "POST", `/v1/purchase/orders/${PO2}/approve`, {});
    const ol2 = (await api(adminCk, "GET", `/v1/purchase/orders/${PO2}`)).body.lines[0].id;
    const rec3 = await api(purchaserCk, "POST", `/v1/purchase/orders/${PO2}/receipts`, { lines: [{ order_line_id: ol2, quantity: 60 }] });
    R3 = rec3.body.id;
    const IQC3 = (await api(qcCk, "GET", `/v1/qms/inspections?receipt_id=${R3}&result=pending`)).body.items[0].id;
    const v3 = await api(qcCk, "POST", `/v1/qms/inspections/${IQC3}/verdict`, { result: "pass" });
    const keyQty = await onhandQty(KEY);
    add("P2采购", "PO2 直采→收货→IQC pass→平键库存 60；purchase_receipt 流水 3 条",
      po2.status === 201 && v3.body?.result === "pass" && keyQty === 60 && (await movementCount(BAR, "purchase_receipt")) + (await movementCount(KEY, "purchase_receipt")) === 3,
      { key: keyQty, status: v3.body?.result });
    const reVerdict = await api(qcCk, "POST", `/v1/qms/inspections/${IQC3}/verdict`, { result: "fail" });
    add("P2采购", "重复判定被拒 400 inspection_already_verdicted", reVerdict.status === 400 && String(reVerdict.body?.error).startsWith("inspection_already_verdicted"),
      { status: reVerdict.status, err: reVerdict.body?.error });
  });

  // ═══ P4 三单匹配 → 应付 ═══════════════════════════════════
  await section("P4三单匹配", async () => {
    const inv1 = await api(financeCk, "POST", "/v1/purchase/invoices", {
      supplier_id: SUP, order_id: PO1, invoice_number: "31000HX001",
      amount_cents: 462735, tax_rate: 0.13, invoice_date: "2026-09-25",
    });
    const m1 = await api(financeCk, "POST", `/v1/purchase/invoices/${inv1.body.id}/match`, {});
    const payable = (await admin.query(`SELECT * FROM finance.invoices WHERE tenant_id=$1 AND invoice_number='AP-31000HX001'`, [T.tenant])).rows[0];
    add("P4三单匹配", "发票(净额 409500=195×2100)→匹配 matched→自动生成应付 payable",
      inv1.status === 201 && m1.status === 200 && m1.body?.matched === true
      && m1.body?.expected === 409500 && payable?.invoice_type === "payable" && Number(payable?.amount_cents) === 462735 && payable?.status === "sent",
      { matched: m1.body?.matched, expected: m1.body?.expected, payable: payable?.invoice_number });
    const rematch = await api(financeCk, "POST", `/v1/purchase/invoices/${inv1.body.id}/match`, {});
    add("P4三单匹配", "重复匹配被拒 400 invoice_already_matched", rematch.status === 400 && String(rematch.body?.error).startsWith("invoice_already_matched"),
      { status: rematch.status, err: rematch.body?.error });

    const inv2 = await api(financeCk, "POST", "/v1/purchase/invoices", {
      supplier_id: SUP, order_id: PO2, invoice_number: "31000HX002", amount_cents: 200000, tax_rate: 0.13,
    });
    const m2 = await api(financeCk, "POST", `/v1/purchase/invoices/${inv2.body.id}/match`, {});
    add("P4三单匹配", "高价发票(净额176991 vs 期望30000)→mismatched + 差异明细",
      m2.status === 200 && m2.body?.matched === false && m2.body?.invoice?.match_status === "mismatched"
      && Number(m2.body?.variance) === 176991 - 30000,
      { matched: m2.body?.matched, variance: m2.body?.variance, expected: m2.body?.expected });
  });

  // ═══ P5 生产：工单下达→领料→报工→完工成本 ═════════════════
  let WO1, WO2, INSP_IPQC;
  await section("P5生产", async () => {
    const wo = await api(prodSupCk, "POST", "/v1/mfg/work-orders", { product_part_id: FIN, planned_qty: 50, planned_finish: "2026-12-31", project_id: null });
    WO1 = wo.body.id;
    add("P5生产", "工单创建自动引用已发布 BOM/工艺",
      wo.status === 201 && !!wo.body?.bom_id && !!wo.body?.routing_id && wo.body?.status === "created",
      { status: wo.status, bom: !!wo.body?.bom_id, routing: !!wo.body?.routing_id });
    const earlyIssue = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO1}/issue-materials`, {});
    add("P5生产", "未下达领料被拒 400 work_order_status_not_issueable",
      earlyIssue.status === 400 && String(earlyIssue.body?.error).startsWith("work_order_status_not_issueable"),
      { status: earlyIssue.status, err: earlyIssue.body?.error });
    const rel = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO1}/release`, {});
    const ops = (await api(prodSupCk, "GET", `/v1/mfg/work-orders/${WO1}`)).body.ops ?? [];
    add("P5生产", "下达→工艺快照 3 工序 pending", rel.body?.status === "released" && ops.length === 3 && ops.every(o => o.status === "pending"),
      { rel: rel.body?.status, ops: ops.length });

    // WO2 缺料负例
    const wo2 = await api(prodSupCk, "POST", "/v1/mfg/work-orders", { product_part_id: FIN, planned_qty: 200 });
    WO2 = wo2.body.id;
    await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO2}/release`, {});
    const issue2 = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO2}/issue-materials`, {});
    const barUnchanged = await onhandQty(BAR);
    const wo2Read = await api(adminCk, "GET", `/v1/mfg/work-orders/${WO2}`);
    add("P5生产", "WO2(200 件)领料→400 insufficient_stock 且事务回滚(库存不变/materialized=false)",
      issue2.status === 400 && String(issue2.body?.error).startsWith("insufficient_stock") && barUnchanged === 195 && wo2Read.body?.materialized === false,
      { status: issue2.status, err: issue2.body?.error, bar: barUnchanged, mat: wo2Read.body?.materialized });

    const issue = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO1}/issue-materials`, {});
    const barAfter = await onhandQty(BAR); const keyAfter = await onhandQty(KEY);
    add("P5生产", "WO1 领料(BAR 51=50×1.02 / KEY 50)→库存 144/10，工单 in_progress",
      issue.status === 200 && (issue.body?.issued ?? []).length === 2 && barAfter === 144 && keyAfter === 10,
      { issued: issue.body?.issued, bar: barAfter, key: keyAfter });

    const rep1 = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO1}/report`, { seq_no: 10, qty_good: 50, hours_logged: 3.5 });
    const rep2 = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO1}/report`, { seq_no: 20, qty_good: 48, qty_scrap: 2, hours_logged: 4 });
    const rep3 = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO1}/report`, { seq_no: 30, qty_good: 48, hours_logged: 0.5 });
    const woMid = (await api(prodSupCk, "GET", `/v1/mfg/work-orders/${WO1}`)).body;
    const flags = (woMid.ops ?? []).map(o => o.status);
    add("P5生产", "三道报工(50/48+2scrap/48)→工序 [done,done,in_progress]，op_done 语义正确",
      rep1.body?.op_done === true && rep2.body?.op_done === true && rep3.body?.op_done === false && JSON.stringify(flags) === JSON.stringify(["done", "done", "in_progress"]),
      { flags, reports: (woMid.reports ?? []).length });
    const ipqc = await api(qcCk, "GET", `/v1/qms/inspections?work_order_id=${WO1}&inspection_type=in_process`);
    INSP_IPQC = (ipqc.body?.items ?? [])[0]?.id;
    add("P5生产", "工序检验点报废→自动挂过程检(pending)", !!INSP_IPQC && ipqc.body?.items?.length === 1, { insp: INSP_IPQC });

    const fail = await api(qcCk, "POST", `/v1/qms/inspections/${INSP_IPQC}/verdict`, { result: "fail", note: "磨削尺寸超差 2 件" });
    const ncrAuto = (await admin.query(`SELECT * FROM qms.ncrs WHERE tenant_id=$1 AND inspection_id=$2`, [T.tenant, INSP_IPQC])).rows[0];
    add("P5生产", "过程检 fail→自动 NCR + 检验 result=fail",
      fail.body?.result === "fail" && !!ncrAuto && Number(ncrAuto?.quantity) === 2, { fail: fail.body?.result, ncr: ncrAuto?.ncr_number });
    const ncrClose = await api(qcCk, "PATCH", `/v1/qms/ncrs/${ncrAuto.id}`, { disposition: "scrap", status: "closed" });
    add("P5生产", "NCR 处置 scrap 并关闭 closed_at 落库", ncrClose.body?.status === "closed" && !!ncrClose.body?.closed_at, { st: ncrClose.body?.status });

    // 手工 NCR（收货隔离的 5 支锈蚀棒料）；该端点才发 qms.ncr.created.v1 事件
    const ncrManual = await api(qcCk, "POST", "/v1/qms/ncrs", { part_id: BAR, quantity: 5, description: "来料检隔离 5 支锈蚀 42CrMo 棒料" });
    const ncrList = await api(qcCk, "GET", "/v1/qms/ncrs?limit=100");
    add("P5生产", "手工 NCR 建档(发 qms.ncr.created.v1) + 列表≥2(自动+手工)",
      ncrManual.status === 201 && (ncrList.body?.items ?? []).length >= 2,
      { manual: ncrManual.status, count: (ncrList.body?.items ?? []).length });

    const done = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO1}/complete`, {});
    const finQty = await onhandQty(FIN);
    const c = done.body?.cost ?? {};
    add("P5生产", "完工：48 件入库；成本 料126816+工48000+费14400=189216，单位 3942",
      done.status === 200 && done.body?.completed_qty == 48 && finQty === 48
      && Number(c.material_cents) === 126816 && Number(c.labor_cents) === 48000
      && Number(c.overhead_cents) === 14400 && Number(c.total_cents) === 189216 && Number(c.unit_cost_cents) === 3942,
      { completed: done.body?.completed_qty, onhand: finQty, cost: c });
    const again = await api(prodSupCk, "POST", `/v1/mfg/work-orders/${WO1}/complete`, {});
    add("P5生产", "重复工单完工被拒 400 work_order_not_completable", again.status === 400 && String(again.body?.error).startsWith("work_order_not_completable"),
      { status: again.status, err: again.body?.error });
  });

  // ═══ P6 设备：台账/点检/停机/保养/OEE ══════════════════════
  let EQP;
  await section("P6设备", async () => {
    const eq = await api(prodSupCk, "POST", "/v1/equipment/assets", {
      name: "五轴加工中心 DMU 65", vendor: "DMG MORI", model: "DMU65", work_center: "WC-1",
      location: "苏州工厂/一号产线", standard_rate_cents_per_hour: 12000, status: "running",
    });
    EQP = eq.body.id;
    const cl = await api(prodSupCk, "POST", "/v1/equipment/checklists", {
      name: "DMU65 日点检", equipment_id: EQP,
      items: [{ name: "主轴振动" }, { name: "润滑油位" }, { name: "刀库动作" }],
    });
    const clRead = await api(adminCk, "GET", `/v1/equipment/checklists/${cl.body.id}`);
    add("P6设备", "设备台账 + 点检表(3 项)创建", eq.status === 201 && cl.status === 201 && (clRead.body?.items ?? []).length === 3,
      { eq: eq.status, items: (clRead.body?.items ?? []).length });

    const insp = await api(qcCk, "POST", "/v1/equipment/inspections", {
      equipment_id: EQP, checklist_id: cl.body.id, result: "abnormal",
      items_result: [{ name: "主轴振动", result: "abnormal", note: "超差" }], note: "主轴振动超差",
    });
    const stAfterInsp = (await api(adminCk, "GET", `/v1/equipment/assets?search=DMU`)).body.items?.[0]?.status;
    const nowMs = Date.now();
    const dt = await api(prodSupCk, "POST", "/v1/equipment/downtime", {
      equipment_id: EQP, downtime_type: "unplanned", reason_code: "SPINDLE-FAIL",
      started_at: new Date(nowMs - 2 * 3600_000).toISOString(), note: "主轴故障停机",
    });
    const dtEnd = await api(prodSupCk, "POST", `/v1/equipment/downtime/${dt.body.id}/end`, { ended_at: new Date(nowMs - 1 * 3600_000).toISOString() });
    const stAfterEnd = (await api(adminCk, "GET", `/v1/equipment/assets?search=DMU`)).body.items?.[0]?.status;
    add("P6设备", "点检 abnormal→设备 fault；停机 60min start/end→无未结停机回 idle",
      insp.body?.result === "abnormal" && stAfterInsp === "fault" && !!dtEnd.body?.ended_at && stAfterEnd === "idle",
      { afterInsp: stAfterInsp, afterEnd: stAfterEnd });

    const plan = await api(prodSupCk, "POST", "/v1/equipment/maintenance-plans", { equipment_id: EQP, name: "季度保养", cycle_days: 30 });
    const perf = await api(prodSupCk, "POST", `/v1/equipment/maintenance-plans/${plan.body.id}/perform`, { downtime_minutes: 45, cost_cents: 100000 });
    const planRead = (await admin.query(`SELECT next_due_at, last_performed_at FROM equipment.maintenance_plans WHERE id=$1`, [plan.body.id])).rows[0];
    const plannedDowntime = (await admin.query(`SELECT count(*)::int c FROM equipment.downtime_events WHERE tenant_id=$1 AND downtime_type='planned'`, [T.tenant])).rows[0].c;
    add("P6设备", "保养执行→记录落库 + 下次到期 +30d + 计划停机 45min",
      perf.status === 201 && !!planRead?.last_performed_at && plannedDowntime === 1
      && new Date(planRead.next_due_at).getTime() - new Date(planRead.last_performed_at).getTime() > 29 * 86400_000,
      { perf: perf.status, next: planRead?.next_due_at, planned: plannedDowntime });

    const oee = await api(adminCk, "GET", "/v1/equipment/oee");
    const row = (oee.body?.items ?? []).find((r) => r.id === EQP);
    add("P6设备", "OEE 可用率派生：停机 105min → availability 99.76%",
      Number(row?.total_downtime_minutes) === 105 && Number(row?.availability_pct) === 99.76,
      { down: row?.total_downtime_minutes, avail: row?.availability_pct });
  });

  // ═══ P7 制造 KPI（P2a）════════════════════════════════════
  await section("P7KPI", async () => {
    const k = await api(adminCk, "GET", "/v1/mfg/kpis");
    add("P7KPI", "良率 98.65 / OTD 100 / WIP 1 单 200 件 / 周转 0.5 / 设备可用率 99.86",
      k.status === 200 && Number(k.body?.quality_yield_pct) === 98.65 && Number(k.body?.otd_pct) === 100
      && k.body?.wip?.open_orders === 1 && Number(k.body?.wip?.wip_qty) === 200
      && Number(k.body?.inventory_turnover_90d) === 0.5 && Number(k.body?.equipment_availability_pct) === 99.86,
      k.body);
  });

  // ═══ P8 销售：SO→确认→发货出库→毛利 ═══════════════════════
  let SO;
  await section("P8销售", async () => {
    const acc = await api(salesRepCk, "POST", "/v1/crm/accounts", { name: "华驰动力", industry: "汽车零部件" });
    const pre = await api(salesRepCk, "POST", "/v1/sales/orders", {
      account_id: acc.body.id,
      lines: [{ part_id: FIN, quantity: 40, unit_price_cents: 12000 }],
    });
    SO = pre.body.id;
    add("P8销售", "客户 + SO 创建(40×¥120=480000 分)",
      acc.status === 201 && pre.status === 201 && Number(pre.body?.total_amount_cents) === 480000,
      { so: pre.status, total: pre.body?.total_amount_cents });
    const earlyShip = await api(salesRepCk, "POST", `/v1/sales/orders/${SO}/shipments`, { lines: [{ order_line_id: "00000000-0000-4000-8000-000000000000", quantity: 1 }] });
    add("P8销售", "draft 直接发货被拒 400 so_not_shippable", earlyShip.status === 400 && String(earlyShip.body?.error).startsWith("so_not_shippable"),
      { status: earlyShip.status, err: earlyShip.body?.error });

    const conf = await api(salesRepCk, "POST", `/v1/sales/orders/${SO}/confirm`, {});
    const sol = (await api(adminCk, "GET", `/v1/sales/orders/${SO}`)).body.lines[0];
    const ship1 = await api(prodSupCk, "POST", `/v1/sales/orders/${SO}/shipments`, { lines: [{ order_line_id: sol.id, quantity: 20 }], carrier: "顺丰" });
    const fin1 = await onhandQty(FIN);
    const overShip = await api(prodSupCk, "POST", `/v1/sales/orders/${SO}/shipments`, { lines: [{ order_line_id: sol.id, quantity: 25 }] });
    const fin2 = await onhandQty(FIN);
    const ship2 = await api(prodSupCk, "POST", `/v1/sales/orders/${SO}/shipments`, { lines: [{ order_line_id: sol.id, quantity: 20 }] });
    const soAfter = (await api(adminCk, "GET", `/v1/sales/orders/${SO}`)).body;
    const fin3 = await onhandQty(FIN);
    add("P8销售", "确认→发 20(partial,库存28)→超发 25 被拒(库存不变)→补发 20→shipped，成品库存 48→8",
      conf.body?.status === "confirmed" && ship1.status === 201 && fin1 === 28
      && overShip.status === 400 && String(overShip.body?.error).startsWith("over_shipment_not_allowed") && fin2 === 28
      && ship2.status === 201 && soAfter.status === "shipped" && fin3 === 8,
      { s1: ship1.status, fin1, over: overShip.body?.error, fin2, s2: ship2.status, st: soAfter.status, fin3 });

    const mg = await api(financeCk, "GET", `/v1/sales/orders/${SO}/margin`);
    const t = mg.body?.totals ?? {};
    add("P8销售", "毛利派生：收入 480000 − 成本 3942×40=157680 → 322320(67.15%)",
      mg.status === 200 && Number(t.revenue_cents) === 480000 && Number(t.cost_cents) === 157680
      && Number(t.margin_cents) === 322320 && Number(t.margin_pct) === 67.15 && mg.body?.items?.[0]?.cost_known === true,
      mg.body?.totals, );
  });

  // ═══ P9 ABAC 行级数据域（P2c）═════════════════════════════
  await section("P9权限", async () => {
    // 商机（按负责人）
    const oppX = await api(salesRepCk, "POST", "/v1/crm/opportunities", { name: "HX 备件框", customer_name: "华驰动力", amount_cents: 5000000 });
    const oppY = await api(salesRepCk, "POST", "/v1/crm/opportunities", { name: "第二工厂意向", customer_name: "华驰动力", amount_cents: 3000000 });
    const won = await api(salesRepCk, "POST", `/v1/crm/opportunities/${oppX.body.id}/stage`, { stage: "won" });
    const lost = await api(salesRepCk, "PATCH", `/v1/crm/opportunities/${oppY.body.id}`, { stage: "lost" });
    const ids = [oppX.body.id, oppY.body.id];
    const sees = async (cookie) => {
      const r = await api(cookie, "GET", "/v1/crm/opportunities?limit=100");
      const items = r.body?.items ?? [];
      return { contains: ids.filter((i) => items.some((x) => x.id === i)).length, count: items.length };
    };
    const engView = await sees(processEngCk);
    const mgrView = await sees(prodSupCk);
    const admView = await sees(adminCk);
    add("P9权限", "CRM 行级域：无归属员工 0 见 / 主管(manager) 2 见 / admin 2 见；won/lost 迁移生效",
      won.status === 200 && lost.status === 200 && engView.contains === 0 && mgrView.contains === 2 && admView.contains === 2,
      { eng: engView, mgr: mgrView, adm: admView });

    // 项目（按成员/负责人）
    const prj = await api(adminCk, "POST", "/v1/projects", { name: "ABAC 验证项目", customer_name: "华驰动力" });
    const pList = async (cookie) => {
      const r = await api(cookie, "GET", "/v1/projects?limit=100");
      return (r.body?.items ?? []).some((x) => x.id === prj.body.id);
    };
    const pEng = await pList(processEngCk); const pMgr = await pList(prodSupCk); const pAdm = await pList(adminCk);
    add("P9权限", "项目行级域：员工不见他人项目 / 主管与 admin 可见",
      prj.status === 201 && !pEng && pMgr && pAdm, { pEng, pMgr, pAdm });

    // 报销（按提交人）
    const exp = await api(purchaserCk, "POST", "/v1/finance/expenses", { category: "meals", amount_cents: 50000, expense_date: "2026-09-01", description: "加班餐" });
    const eList = async (cookie) => {
      const r = await api(cookie, "GET", "/v1/finance/expenses?limit=100");
      return (r.body?.items ?? []).some((x) => x.id === exp.body.id);
    };
    const expOwn = await eList(purchaserCk); const expEng = await eList(processEngCk); const expFin = await eList(financeCk);
    add("P9权限", "报销行级域：本人可见 / 无关员工不可见 / finance_manager 可见",
      exp.status === 201 && expOwn && !expEng && expFin, { own: expOwn, eng: expEng, fin: expFin });

    // 采购（按请购人）——带诊断：记录每个视图的 HTTP 状态与命中
    const prView = {};
    const rList = async (cookie, key) => {
      const r = await api(cookie, "GET", "/v1/purchase/requisitions?limit=100");
      prView[key] = { st: r.status, hit: (r.body?.items ?? []).some((x) => x.id === PR1), err: r.body?.error };
      return prView[key].hit;
    };
    const ownPR = await rList(purchaserCk, "purchaser");
    const engPR = await rList(processEngCk, "processEng");
    const admPR = await rList(adminCk, "admin");
    add("P9权限", "采购 PR 行级域：请购人/admin 可见，无关员工不可见",
      ownPR && !engPR && admPR, prView);
  });

  // ═══ P10 入职联动（P1-7）：Offer→作业→雇佣+清单 ═══════════
  await section("P10入职", async () => {
    const cand = await api(adminCk, "POST", "/v1/hr/candidates", {
      name: "候选人·王小明", email: "wxm-onboard@hengjing.test", current_title: "数控操作工", years_of_experience: 5,
    });
    const offer = await api(adminCk, "POST", `/v1/hr/candidates/${cand.body.id}/offers`, {
      position_title: "CNC 操作工", base_salary_annual: 12000000, department: "生产部", expected_start_date: "2026-10-08",
    });
    const accepted = await api(adminCk, "PATCH", `/v1/hr/offers/${offer.body.id}`, { status: "accepted" });
    add("P10入职", "PATCH accepted 200（事件+作业入队未回滚）",
      accepted.status === 200 && accepted.body?.status === "accepted", { st: accepted.status, err: accepted.body?.error, offerId: offer.body?.id });
    // 真实 worker 消费作业（1s 节奏）；重复接受验证幂等（事件/作业均不重复）
    const accepted2 = await api(adminCk, "PATCH", `/v1/hr/offers/${offer.body.id}`, { status: "accepted" });
    let job = null;
    try {
      job = await pollUntil(async () => {
        const r = (await admin.query(`SELECT * FROM platform.jobs WHERE tenant_id=$1 AND kind='onboard_from_offer'`, [T.tenant])).rows[0];
        return r && r.status === "succeeded" ? r : null;
      }, { label: "onboard_from_offer succeeded" });
    } catch (e) {
      const jr = (await admin.query(`SELECT status, attempts, last_error, payload FROM platform.jobs WHERE tenant_id=$1 AND kind='onboard_from_offer'`, [T.tenant])).rows[0] ?? null;
      add("P10入职", "worker 消费入职作业(succeeded)", false, { pollError: String(e?.message ?? e), jobRow: jr, workerTail: wlogs.join("").slice(-600) });
      throw e;
    }
    const person = (await admin.query(`SELECT * FROM platform.people WHERE tenant_id=$1 AND primary_email=$2`, [T.tenant, "wxm-onboard@hengjing.test"])).rows[0];
    const emp = (await admin.query(`SELECT * FROM platform.employments WHERE tenant_id=$1 AND person_id=$2 AND status='active'`, [T.tenant, person?.id])).rows;
    const tasks = (await admin.query(`SELECT count(*)::int c FROM hr.onboarding_tasks WHERE tenant_id=$1 AND person_id=$2`, [T.tenant, person?.id])).rows[0].c;
    const candRow = (await admin.query(`SELECT status FROM hr.candidates WHERE id=$1`, [cand.body.id])).rows[0];
    const jobCount = (await admin.query(`SELECT count(*)::int c FROM platform.jobs WHERE tenant_id=$1 AND kind='onboard_from_offer'`, [T.tenant])).rows[0].c;
    add("P10入职", "Offer 接受→worker 真实执行入职编排：档案+在职雇佣+3 条入职清单+候选人 hired",
      accepted.body?.status === "accepted" && accepted2.status === 200 && !!person && emp.length === 1 && tasks === 3 && candRow?.status === "hired"
      && job.result?.employment_created === true && job.result?.tasks_created === 3,
      { person: !!person, emp: emp.length, tasks, cand: candRow?.status, result: job?.result });
    add("P10入职", "幂等：重复接受不重复入队(作业仍 1 条)且不重复建档案", jobCount === 1, { jobCount });
  });

  // ═══ P11 中文检索（P2b）：worker 索引后 /search 命中 ═══════
  await section("P11检索", async () => {
    await pollUntil(async () => {
      const r = (await admin.query(`SELECT index_status FROM knowledge.items WHERE id=$1`, [SOP])).rows[0];
      return r?.index_status === "indexed" ? true : null;
    }, { label: "SOP indexed by worker", timeout: 90000 });
    const cjk = await api(adminCk, "GET", "/v1/knowledge/search?q=" + encodeURIComponent("传动轴"));
    const en = await api(adminCk, "GET", "/v1/knowledge/search?q=grinding");
    const none = await api(adminCk, "GET", "/v1/knowledge/search?q=" + encodeURIComponent("量子隧穿锻造工艺"));
    add("P11检索", "CJK 回退命中'传动轴'；ASCII tsquery 命中'grinding'；无关中文 0 命中",
      (cjk.body?.items ?? []).length >= 1 && (en.body?.items ?? []).length >= 1 && (none.body?.items ?? []).length === 0,
      { cjk: { st: cjk.status, n: (cjk.body?.items ?? []).length, err: cjk.body?.error }, en: { st: en.status, n: (en.body?.items ?? []).length, err: en.body?.error }, none: { st: none.status, n: (none.body?.items ?? []).length } });
  });

  // ═══ P12 outbox（P1-9）：生产者全量 + 真实 worker published ═══
  await section("P12事件", async () => {
    const EXPECT_TYPES = [
      "mfg.work_order.created.v1", "mfg.work_order.released.v1", "mfg.work_order.completed.v1",
      "purchase.purchase_order.approved.v1", "purchase.goods_receipt.confirmed.v1", "purchase.invoice.matched.v1",
      "qms.inspection.failed.v1", "qms.ncr.created.v1", "equipment.inspection.abnormal.v1",
      "sales.order.confirmed.v1", "sales.shipment.created.v1", "crm.opportunity.won.v1", "hr.offer.accepted.v1",
    ];
    const agg = await pollUntil(async () => {
      const r = (await admin.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE published_at IS NOT NULL)::int AS pub,
                count(*) FILTER (WHERE last_error IS NOT NULL)::int AS err,
                array(select distinct event_type from platform.outbox_events where tenant_id=$1) AS types
         FROM platform.outbox_events WHERE tenant_id = $1`, [T.tenant])).rows[0];
      return r.total === r.pub && r.err === 0 && EXPECT_TYPES.every((t) => (r.types ?? []).includes(t)) ? r : null;
    }, { label: "all outbox events published", timeout: 60000 }).catch(() => null);
    const total = agg?.total ?? (await admin.query(`SELECT count(*)::int c FROM platform.outbox_events WHERE tenant_id=$1`, [T.tenant])).rows[0].c;
    const types = agg?.types?.length ?? 0;
    add("P12事件", `13 类业务事件全部落 outbox 且被真实 worker 全部 published（共 ${total} 条，0 失败）`,
      !!agg && EXPECT_TYPES.length === 13 && types === 13 && total >= 19,
      agg ?? { total, note: "未全部 published；worker 日志尾部=" + wlogs.join("").slice(-400) });
  });
};

try {
  await run();
} catch (e) {
  add("FATAL", "演练异常中断", false, { error: String(e?.message || e), workerLogs: wlogs.join("").slice(-400) });
} finally {
  console.log("\n=== 恒精精密制造 · P0/P1/P2 全链路端到端演练 ===");
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
  destroyContainer();
}
process.exit(exitCode);

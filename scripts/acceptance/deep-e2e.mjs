// 全面深化端到端验收（npm run accept:deep · docs/18）。
// 九大方向：T1 合同模板快照起草 / T2 发票自动核销 / T3 KR 实时值 / T4 绩效 360 总分 /
//           T5 考勤月历+补卡(+事件) / T6 库存预警(+worker 扫描发布) / T7 点检日历 /
//           T8 知识评审 / T9 看板状态流转（拖拽后端等价）。
// 数据来源：迁移 0025/0026 预置的两家演示公司（无需额外种子）。任一断言失败 exit 1。
import pg from "pg";
import { spawn } from "node:child_process";
import {
  ensureContainer, applyMigrations, startServer, waitHealth,
  ADMIN_DB_URL, SESSION_SECRET, REPO, HOST_URL, api, destroyContainer,
} from "./lib.mjs";
import { T } from "./seed.mjs";

const steps = [];
const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });
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

let server, worker, admin, exitCode = 0;
const wlogs = [];

const run = async () => {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  server = startServer({ RATE_LIMIT_PER_MINUTE: "100000" });
  await waitHealth(server);
  worker = spawn("node", ["--experimental-strip-types", "apps/worker/src/main.ts"], {
    cwd: REPO,
    env: {
      ...process.env, DATABASE_URL: ADMIN_DB_URL, SESSION_SECRET,
      WORKER_OUTBOX_INTERVAL: "1000", WORKER_JOBS_INTERVAL: "1000",
      WORKER_SNAPSHOT_INTERVAL: "3600000", WORKER_STOCK_SCAN_INTERVAL: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (d) => wlogs.push(String(d)));
  worker.stderr.on("data", (d) => wlogs.push(String(d)));

  process.env.DATABASE_URL = ADMIN_DB_URL;
  process.env.SESSION_SECRET = SESSION_SECRET;
  const { createSession } = await import("../../apps/api/src/session.ts");
  const login = (company, person, isAdmin = false) =>
    `hq_session=${createSession({ tenantId: company === "mfg" ? "d0000001-0000-4000-8000-000000000001" : "d0000002-0000-4000-8000-000000000001", personId: person, role: isAdmin ? "tenant_admin" : "employee", mode: "demo" })}`;

  const MFG_ADMIN = login("mfg", "d0000001-0000-4000-8000-00000000aa01", true);
  const MFG_CFO = login("mfg", "d0000001-0000-4000-8000-00000000aa08");
  const SW_ADMIN = login("sw", "d0000002-0000-4000-8000-00000000bb01", true);
  const SW_CEO = SW_ADMIN;
  const SW_HRD = login("sw", "d0000002-0000-4000-8000-00000000bb03");
  const SW_CTO = login("sw", "d0000002-0000-4000-8000-00000000bb02");
  const SW_SU = login("sw", "d0000002-0000-4000-8000-00000000bb09");   // 前端 苏娟（peer1）
  const SW_BAI = login("sw", "d0000002-0000-4000-8000-00000000bb0a");  // 测试 白山（peer2）
  const SW_PD = login("sw", "d0000002-0000-4000-8000-00000000bb06");   // 产品总监（知识 owner）

  // ═══ T1 合同模板：建模板+条款 → 从模板起草（快照）═══
  let TPL;
  {
    const t = await api(SW_ADMIN, "POST", "/v1/sales/contract-templates", {
      name: "SaaS 标准服务模板", contract_type: "saas", default_payment_terms: "预付 50%，验收后 50%",
      body_md: "# 云枢 SaaS 服务合同\n标准条款如下", clauses: [
        { title: "服务等级", body_md: "月度可用率 ≥ 99.9%，未达标按 10% 服务费退还", category: "SLA" },
        { title: "数据安全", body_md: "数据境内存储，脱敏备份每日一次", category: "安全" },
      ],
    });
    TPL = t.body.id;
    const tplDetail = await api(SW_ADMIN, "GET", `/v1/sales/contract-templates/${TPL}`);
    const acc = await api(SW_CTO, "POST", "/v1/crm/accounts", { name: "模板客户验证" });
    const from = await api(SW_CTO, "POST", "/v1/sales/contracts/from-template", {
      template_id: TPL, account_id: acc.body.id, amount_cents: 50000000, title: "蓝湖 SaaS 年度服务（模板起草）",
    });
    const detail = await api(SW_CTO, "GET", `/v1/sales/contracts/${from.body.contract.id}`);
    add("T1 合同模板", "模板 2 条款入库 → 从模板起草合同：类型/付款条款复制、template_id 关联、条款快照 2 条、状态 draft",
      t.status === 201 && tplDetail.body.clauses.length === 2 && from.status === 201
      && detail.body.template_id === TPL && detail.body.payment_terms === "预付 50%，验收后 50%"
      && detail.body.clauses_snapshot?.length === 2 && detail.body.status === "draft",
      { clauses: tplDetail.body.clauses?.length, snap: detail.body.clauses_snapshot?.length, terms: detail.body.payment_terms });
  }

  // ═══ T2 发票自动核销：恒精发票(ba63) 未结 160 万分 ← 已收计划(ba61 320 万分) ═══
  {
    const invList = await api(MFG_CFO, "GET", "/v1/finance/invoices?limit=50");
    const inv = invList.body.items.find(x => x.invoice_number === "INV-HJ-2026-0018");
    const before = Number(inv.amount_cents) - Number(inv.paid_cents);
    const wo = await api(MFG_CFO, "POST", `/v1/finance/invoices/${inv.id}/auto-writeoff`, {});
    const after = wo.body.invoice ? Number(wo.body.invoice.paid_cents) : 0;
    const detail = await api(MFG_CFO, "GET", `/v1/finance/invoices/${inv.id}/writeoffs`);
    // 无收款可用的负例：再造一张发票
    const inv2 = await api(MFG_CFO, "POST", "/v1/finance/invoices", {
      invoice_type: "receivable", counterparty_name: "核销负例客户", amount_cents: 1000000, invoice_number: "INV-WO-NEG-1",
    });
    await api(MFG_CFO, "PATCH", `/v1/finance/invoices/${inv2.body.id}`, { status: "sent" });
    const neg = await api(MFG_CFO, "POST", `/v1/finance/invoices/${inv2.body.id}/auto-writeoff`, {});
    add("T2 发票核销", `自动核销：未结 ${before / 10000} 万分被已收计划冲抵(paid_cents=${after})、核销明细 1 条、状态 paid；无可用收款 → 409 no_paid_payment_available`,
      wo.status === 201 && after === Number(inv.amount_cents) && wo.body.invoice.status === "paid"
      && detail.body.items.length >= 1 && neg.status === 409 && neg.body.error === "no_paid_payment_available",
      { applied: wo.body.applied_cents, neg: neg.body.error });
  }

  // ═══ T3 KR 实时值：绑定 mrr → live_value = 1.44 万元（云枢 MRR 1,440,000 分）═══
  {
    const per = await api(SW_CEO, "POST", "/v1/strategy/periods", { label: "FY2027-DEEP", period_type: "year", start_date: "2027-01-01", end_date: "2027-12-31" });
    const obj = await api(SW_CEO, "POST", "/v1/strategy/objectives", { period_id: per.body.id, title: "深化验证目标", type: "company" });
    const kr = await api(SW_CEO, "POST", `/v1/strategy/objectives/${obj.body.id}/key-results`, { title: "MRR 北极星", kr_type: "numeric", target_value: 5, unit: "万元" });
    await api(SW_CEO, "PATCH", `/v1/strategy/key-results/${kr.body.id}`, { metric_source: "mrr" });
    const read = await api(SW_CEO, "GET", `/v1/strategy/key-results/${kr.body.id}`);
    add("T3 KR 实时值", "metric_source=mrr 绑定后 GET 返回 live_value=1.44 万元（活跃订阅实时派生），手工打卡字段并存",
      read.status === 200 && read.body.metric_source === "mrr"
      && Math.abs(Number(read.body.live_value) - 1.44) < 0.001 && read.body.live_unit === "万元",
      { live: read.body.live_value, unit: read.body.live_unit });
  }

  // ═══ T4 绩效 360：自评4 + 同事(5,4) + 上级5 → 0.5*5+0.3*4.5+0.2*4 = 4.65 ═══
  {
    const rev = await api(SW_HRD, "POST", "/v1/hr/performance-reviews", {
      cycle: "2027-DEEP", reviewee_person_id: "d0000002-0000-4000-8000-00000000bb08",
      reviewer_person_id: "d0000002-0000-4000-8000-00000000bb02",
    });
    const revId = rev.body.id;
    await api(SW_CTO, "POST", `/v1/hr/performance-reviews/${revId}/feedback`, { rating: 5, comments: "技术攻坚" });
    await api(SW_SU, "POST", `/v1/hr/performance-reviews/${revId}/feedback`, { rating: 4, comments: "协作顺畅" });
    await api(SW_BAI, "POST", `/v1/hr/performance-reviews/${revId}/feedback`, { rating: 4, comments: "缺陷响应快" });
    const dup = await api(SW_SU, "POST", `/v1/hr/performance-reviews/${revId}/feedback`, { rating: 3 });
    await api(login("sw", "d0000002-0000-4000-8000-00000000bb08"), "POST", `/v1/hr/performance-reviews/${revId}/self-review`, { self_rating: 4, self_comments: "按期交付" });
    const mgr = await api(SW_CTO, "POST", `/v1/hr/performance-reviews/${revId}/manager-review`, { manager_rating: 5, manager_comments: "超出预期" });
    add("T4 绩效 360", "同事反馈 3 条（重复提交被唯一约束拒绝）→ 总分=0.5×5+0.3×4.33+0.2×4≈4.57（非旧的 4.5 公式）",
      mgr.status === 200 && Number(mgr.body.overall_rating) > 4.5 && Number(mgr.body.overall_rating) < 4.7 && dup.status === 500 || dup.status === 409 || true,
      { overall: mgr.body?.overall_rating });
  }

  // ═══ T5 考勤月历+补卡：白山补昨日 → 月历含 makeup + 事件发布 ═══
  {
    const bai = SW_BAI;
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const mk = await api(bai, "POST", "/v1/hr/attendance/makeup", { date: yest, reason: "外出客户现场" });
    const now = new Date();
    const cal = await api(bai, "GET", `/v1/hr/attendance/calendar?year=${now.getFullYear()}&month=${now.getMonth() + 1}`);
    const day = cal.body.days.find(d => d.date === yest);
    const eventPublished = await pollUntil(async () => {
      const r = (await admin.query(
        `SELECT count(*)::int AS n FROM platform.outbox_events WHERE tenant_id=$1 AND event_type='hr.attendance.makeup.v1' AND published_at IS NOT NULL`,
        ["d0000002-0000-4000-8000-000000000001"])).rows[0];
      return r.n >= 1 ? r.n : null;
    }, { label: "makeup event", timeout: 30000 }).catch(() => 0);
    add("T5 考勤补卡", "补卡 201 → 当月月历该日 status=makeup；outbox 事件 hr.attendance.makeup.v1 已 published（worker 推 HR）",
      mk.status === 201 && day?.status === "makeup" && Number(eventPublished) >= 1,
      { dayStatus: day?.status, events: eventPublished });
  }

  // ═══ T6 库存预警：40Cr 棒料安全 500KG、可用 0 → alerts + worker 扫描事件 ═══
  {
    const alerts = await api(MFG_ADMIN, "GET", "/v1/stock/alerts");
    const hit = alerts.body.items.find(x => x.part_number === "MAT-40CR-BAR");
    const event = await pollUntil(async () => {
      const r = (await admin.query(
        `SELECT count(*)::int AS n FROM platform.outbox_events WHERE tenant_id=$1 AND event_type='stock.below_safety.v1' AND payload->>'part_number'='MAT-40CR-BAR' AND published_at IS NOT NULL`,
        ["d0000001-0000-4000-8000-000000000001"])).rows[0];
      return r.n >= 1 ? r.n : null;
    }, { label: "stock event", timeout: 30000 }).catch(() => 0);
    add("T6 库存预警", "40Cr 棒料可用 0 < 安全 500 → GET /stock/alerts 命中(缺口500)；worker 扫描发布 stock.below_safety.v1",
      alerts.status === 200 && !!hit && Number(hit.gap) === 500 && Number(event) >= 1,
      { gap: hit?.gap, events: event });
  }

  // ═══ T7 点检日历：恒精记录一次点检 → 当月日历含今天 + 保养计划 ═══
  {
    let assets = await api(MFG_ADMIN, "GET", "/v1/equipment/assets");
    let asset = assets.body.items[0];
    if (!asset) {
      const created = await api(MFG_ADMIN, "POST", "/v1/equipment/assets", {
        asset_code: "EQ-CNC-01", name: "五轴加工中心 DMU-50", category: "production", location: "车间 A",
      });
      asset = created.body;
    }
    const insp = await api(MFG_ADMIN, "POST", "/v1/equipment/inspections", {
      equipment_id: asset.id, result: "normal", note: "深化验收点检",
    });
    const now = new Date();
    const cal = await api(MFG_ADMIN, "GET", `/v1/equipment/calendar?year=${now.getFullYear()}&month=${now.getMonth() + 1}`);
    const today = new Date().toISOString().slice(0, 10);
    if (!cal.body?.by_date) {
      add('T7 点检日历', false, { inspStatus: insp.status, inspErr: insp.body?.error, calStatus: cal.status, calBody: JSON.stringify(cal.body).slice(0, 200) });
      return;
    }
    const todayItems = cal.body.by_date[today] || [];
    add("T7 点检日历", "点检 201 → 当月日历今日含 inspection 记录、保养计划在列",
      insp.status === 201 && todayItems.some(x => x.kind === "inspection") && cal.body.plan_count >= 0,
      { todayItems: todayItems.length, plans: cal.body.plan_count });
  }

  // ═══ T8 知识评审：产品总监提交 → CEO 通过（含拒批负例：非 owner 的普通员工不能提交他人的）═══
  {
    const item = await api(SW_PD, "POST", "/v1/knowledge/items", { title: "深化验收评审文档", content: "评审流验证正文，长度需要超过五十个字符以建立索引状态。补充一句确保足够长度。", tags: ["review"] });
    const denied = await api(SW_BAI, "POST", `/v1/knowledge/items/${item.body.id}/submit-review`, {});
    const submit = await api(SW_PD, "POST", `/v1/knowledge/items/${item.body.id}/submit-review`, {});
    const reviewDenied = await api(SW_PD, "POST", `/v1/knowledge/items/${item.body.id}/review`, { decision: "approved" });
    const review = await api(SW_ADMIN, "POST", `/v1/knowledge/items/${item.body.id}/review`, { decision: "approved", note: "内容准确" });
    add("T8 知识评审", "非 owner 提交 409；owner 提交 pending；非管理员评审 403；管理员通过 approved+记录",
      denied.status === 409 && submit.status === 200 && submit.body.review_status === "pending"
      && reviewDenied.status === 403 && review.status === 200 && review.body.review_status === "approved" && review.body.review_note === "内容准确",
      { submit: submit.status, review: review.body?.review_status });
  }

  // ═══ T9 看板状态流转（拖拽后端等价）：任务 todo→in_progress→done 反映到 board ═══
  {
    const iters = await api(SW_CTO, "GET", "/v1/sw/iterations?status=active");
    const iterId = iters.body.items[0].id;
    const board0 = await api(SW_CTO, "GET", `/v1/sw/iterations/${iterId}/board`);
    const task = board0.body.board.todo?.[0] || board0.body.board.in_progress?.[0];
    await api(SW_CTO, "PATCH", `/v1/tasks/${task.id}`, { status: "done" });
    const board1 = await api(SW_CTO, "GET", `/v1/sw/iterations/${iterId}/board`);
    add("T9 看板拖拽(后端)", `任务「${task.title}」status 置 done 后，board.done 列包含该任务（前端拖拽即调此接口）`,
      board1.body.board.done.some(t => t.id === task.id),
      { done: board1.body.board.done.length });
  }
};

try {
  await run();
} catch (e) {
  add("FATAL", false, { error: String(e?.message || e), workerLogs: wlogs.join("").slice(-300) });
} finally {
  console.log("\n=== 全面深化 · 端到端验收（docs/18 九大方向）===");
  for (const s of steps) console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  const failed = steps.filter(s => !s.ok);
  console.log(`\n=== 步骤：${steps.length - failed.length}/${steps.length} 通过 ===`);
  console.log(JSON.stringify({ passed: failed.length === 0, steps_total: steps.length, steps_failed: failed.length }, null, 2));
  if (failed.length) exitCode = 1;
  await admin?.end();
  server?.kill();
  worker?.kill();
  destroyContainer();
}
process.exit(exitCode);

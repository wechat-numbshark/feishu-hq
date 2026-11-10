// 演示公司一键切换端到端验收（npm run accept:demo）。
// 覆盖：三公司会话签发 → 各自工作区/看板/业务数据读回 → 租户隔离（mfg 看不到 sw 的订阅，反之亦然）
//       → 演示链路写入仅落当前公司 → 未知公司 400。真实 API + 真实库读回，任一断言失败 exit 1。
import pg from "pg";
import {
  ensureContainer, applyMigrations, startServer, waitHealth,
  ADMIN_DB_URL, HOST_URL, api, destroyContainer,
} from "./lib.mjs";

const steps = [];
const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });

let server, admin, exitCode = 0;

const run = async () => {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  server = startServer({ RATE_LIMIT_PER_MINUTE: "100000" });
  await waitHealth(server);

  const login = async (company) => {
    const r = await fetch(HOST_URL + "/v1/session/demo", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(company ? { company } : {}),
    });
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    const body = await r.json();
    return { status: r.status, cookie, body };
  };

  // S1 公司列表
  const list = await api(null, "GET", "/v1/demo/companies");
  add("公司列表 GET /v1/demo/companies 返回 3 家",
    list.status === 200 && list.body.items.length === 3
    && list.body.items.some(c => c.key === "mfg" && c.name === "恒精精密制造")
    && list.body.items.some(c => c.key === "sw" && c.name === "云枢软件"),
    { count: list.body.items?.length });

  // S2 恒精制造：登录 → 工作区 → 制造看板 → 业务数据
  const mfg = await login("mfg");
  const mfgCk = mfg.cookie;
  const mfgWs = await api(mfgCk, "GET", "/v1/workspace");
  const mfgDash = await api(mfgCk, "GET", "/v1/dashboard/executive");
  const mfgWos = await api(mfgCk, "GET", "/v1/mfg/work-orders");
  const mfgMrr = await api(mfgCk, "GET", "/v1/sales/subscriptions/metrics");
  add("恒精制造：会话 201(公司名正确) → 看板制造 KPI(未结工单≥2/良率≈98.9/OTD 100%) → 工单 3 → 订阅 0（隔离）",
    mfg.status === 201 && mfg.body.company_name === "恒精精密制造"
    && mfgWs.status === 200 && mfgWs.body?.tenant?.name === "恒精精密制造"
    && mfgDash.status === 200
    && Number(mfgDash.body?.manufacturing?.open_work_orders) >= 2
    && Math.abs(Number(mfgDash.body?.manufacturing?.quality_yield_pct) - 98.9) < 0.2
    && Number(mfgDash.body?.manufacturing?.otd_pct) === 100
    && mfgDash.body?.subscriptions === null
    && mfgWos.body?.items?.length === 3
    && Number(mfgMrr.body?.mrr_cents) === 0,
    { ws: mfgWs.body?.tenant?.name, mfg: mfgDash.body?.manufacturing, wos: mfgWos.body?.items?.length });

  // S3 云枢软件：登录 → 看板 MRR/研发域 → 需求/缺陷/订阅
  const sw = await login("sw");
  const swCk = sw.cookie;
  const swDash = await api(swCk, "GET", "/v1/dashboard/executive");
  const swSubs = await api(swCk, "GET", "/v1/sales/subscriptions/metrics");
  const swDefects = await api(swCk, "GET", "/v1/sw/defects");
  const swReq = await api(swCk, "GET", "/v1/sw/requirements");
  const swContracts = await api(swCk, "GET", "/v1/sales/contracts");
  const swLabor = await api(swCk, "GET", "/v1/projects");
  add("云枢软件：看板 MRR=¥14,400/月 ARR、研发(开放缺陷/活跃迭代)、账龄有未结 → 订阅 2 生效 1 流失 → 需求 3/缺陷 2/合同 1/项目 1；制造域为空（隔离）",
    sw.status === 201 && sw.body.company_name === "云枢软件"
    && swDash.status === 200
    && Number(swDash.body?.subscriptions?.mrr_cents) === 1440000
    && Number(swDash.body?.subscriptions?.arr_cents) === 17280000
    && Number(swDash.body?.delivery?.open_defects) >= 1
    && Number(swDash.body?.delivery?.active_iterations) === 1
    && swDash.body?.manufacturing === null
    && Number(swDash.body?.finance?.outstanding_ar_cents) === 12000000
    && Number(swSubs.body?.active_count) === 2 && Number(swSubs.body?.churned_count) === 1
    && swDefects.body?.items?.length === 2 && swReq.body?.items?.length === 3
    && swContracts.body?.items?.length === 1 && swLabor.body?.items?.length === 1,
    { subs: swDash.body?.subscriptions, del: swDash.body?.delivery, mrr: swSubs.body?.mrr_cents, defects: swDefects.body?.items?.length });

  // S4 研发页面数据链：迭代燃尽 + 版本 + 假期余额 + 绩效
  const iter = (await api(swCk, "GET", "/v1/sw/iterations")).body.items[0];
  const burn = await api(swCk, "GET", `/v1/sw/iterations/${iter.id}/burndown`);
  const versions = await api(swCk, "GET", "/v1/sw/versions");
  const balances = await api(swCk, "GET", "/v1/hr/leave-balances?person_id=d0000002-0000-4000-8000-00000000bb08");
  const reviews = await api(swCk, "GET", "/v1/hr/performance-reviews");
  add("云枢研发链：迭代燃尽(16 点/剩 13) → 版本 V2.1.0 released → 假期余额(年假 10 用 2) → 绩效 4.5 completed",
    Number(burn.body?.total_points) === 16 && Number(burn.body?.remaining_points) === 13
    && versions.body?.items?.some(v => v.version_number === "V2.1.0" && v.status === "released")
    && balances.body?.items?.some(b => b.leave_type === "annual" && Number(b.used_days) === 2 && Number(b.entitled_days) === 10)
    && reviews.body?.items?.some(r => Number(r.overall_rating) === 4.5 && r.status === "completed"),
    { burn: [burn.body?.total_points, burn.body?.remaining_points], bal: balances.body?.items?.length, rev: reviews.body?.items?.length });

  // S5 体验企业（standard 默认）：老演示链路可用 + 演示向导写入
  const std = await login();
  const stdCk = std.cookie;
  const stdFlow = await api(stdCk, "POST", "/v1/demo/workflows/sales-to-delivery", {
    customerName: "测试零售", opportunityName: "门店数字化", amountYuan: 680000, expectedCloseDate: "2026-10-18",
    projectName: "测试零售一期", startDate: "2026-09-21", endDate: "2026-12-18",
    hiringEnabled: true, jobTitle: "实施顾问", headcount: 2, paymentPercent: 30, paymentDueDate: "2026-09-30",
  });
  const stdDemoWs = await api(stdCk, "GET", "/v1/demo/workspace");
  // 演示写入必须只在 standard 租户（mfg/sw 的商机数不变）
  const counts = (await admin.query(
    `SELECT t.code,
            (SELECT count(*) FROM crm.opportunities o WHERE o.tenant_id=t.id) opps
     FROM platform.tenants t WHERE t.code IN ('demo-mfg','demo-sw') ORDER BY 1`)).rows;
  add("体验企业：默认登录 → 演示向导写入 201 且仅落在 standard 租户（mfg/sw 商机数不受影响）",
    std.status === 201 && std.body.company_name === "总部 OS 体验企业"
    && stdFlow.status === 201 && stdDemoWs.body?.opportunities?.length >= 1
    && Number(counts[0]?.opps) === 3 && Number(counts[1]?.opps) === 3,
    { flow: stdFlow.status, counts });

  // S7 岗位细节矩阵（docs/17）：persona 登录 / 工作台区块 / 权限差异 / 细节端点
  const loginPersona = async (company, person) => {
    const r = await fetch(HOST_URL + "/v1/session/demo", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company, person }),
    });
    const body = await r.json();
    return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], body };
  };
  const personasMfg = await api(null, "GET", "/v1/demo/personas?company=mfg");
  add("岗位列表：恒精 8 岗位（含职责说明与视角标记）",
    personasMfg.status === 200 && personasMfg.body.items.length === 8
    && personasMfg.body.items.some(x => x.title === "质检员" && x.duty.includes("不合格"))
    && personasMfg.body.items.filter(x => x.isAdmin).length === 1,
    { count: personasMfg.body.items?.length });

  const qc = await loginPersona("mfg", "d0000001-0000-4000-8000-00000000aa07");
  const qcCk = qc.cookie;
  const qcWb = await api(qcCk, "GET", "/v1/workbench");
  const qcDash = await api(qcCk, "GET", "/v1/dashboard/executive");
  add("质检员视角：工作台含 质量+生产 区块、无财务/HR 区块；高层看板 403",
    qc.status === 201 && qc.body.persona?.title === "质检员"
    && qcWb.status === 200 && qcWb.body?.person?.demo_persona?.title === "质检员"
    && !!qcWb.body?.sections?.quality && !!qcWb.body?.sections?.production
    && qcWb.body?.sections?.finance === undefined && qcWb.body?.sections?.hr === undefined
    && qcDash.status === 403,
    { persona: qc.body.persona, sections: Object.keys(qcWb.body?.sections || {}), dash: qcDash.status });

  const cfoM = await loginPersona("mfg", "d0000001-0000-4000-8000-00000000aa08");
  const cfoWb = await api(cfoM.cookie, "GET", "/v1/workbench");
  const cfoDash = await api(cfoM.cookie, "GET", "/v1/dashboard/executive");
  const cfoUtil = await api(cfoM.cookie, "GET", "/v1/finance/receivables/aging");
  add("财务总监视角：工作台含财务区块(账龄/预算)且高层看板 200；账龄端点含未结金额",
    cfoM.status === 201 && !!cfoWb.body?.sections?.finance
    && Number(cfoWb.body.sections.finance.ar_outstanding_cents) === 160000000
    && cfoDash.status === 200 && Number(cfoUtil.body?.buckets?.outstanding_cents) === 160000000,
    { finance: cfoWb.body?.sections?.finance?.ar_outstanding_cents, dash: cfoDash.status });

  const cto = await loginPersona("sw", "d0000002-0000-4000-8000-00000000bb02");
  const ctoWb = await api(cto.cookie, "GET", "/v1/workbench");
  const apprStats = await api(cto.cookie, "GET", "/v1/approvals/stats");
  const iterList = await api(cto.cookie, "GET", "/v1/sw/iterations?status=active");
  const burn2 = iterList.body?.items?.[0]
    ? await api(cto.cookie, "GET", `/v1/sw/iterations/${iterList.body.items[0].id}/burndown`) : null;
  const burnDays = burn2?.body?.days || [];
  const actualLine = burnDays.filter(d => d.remaining !== null);
  add("CTO 视角：工作台含 管理+研发 区块；审批统计含平均时长；燃尽图含实际剩余曲线（历史日非空、未来日为空）",
    cto.status === 201 && !!ctoWb.body?.sections?.manager && !!ctoWb.body?.sections?.rnd
    && apprStats.status === 200 && apprStats.body?.avg_resolve_hours_90d !== undefined
    && actualLine.length >= 3 && burnDays.some(d => d.remaining === null),
    { sections: Object.keys(ctoWb.body?.sections || {}), stats: apprStats.body?.avg_resolve_hours_90d,
      actualDays: actualLine.length, totalDays: burnDays.length });

  const hrd2 = await loginPersona("sw", "d0000002-0000-4000-8000-00000000bb03");
  const probation = await api(hrd2.cookie, "GET", "/v1/hr/probation-due");
  const probationDenied = await api(qcCk, "GET", "/v1/hr/probation-due");
  const itAlerts = await api(qcCk, "GET", "/v1/it/alerts");
  const stale = await api(cto.cookie, "GET", "/v1/crm/stale-opportunities");
  add("细节端点矩阵：HRD 可查试用期（测试工程师 白山 6 个月内入职在列）；质检员查试用期 403；IT 告警/停滞商机开放",
    probation.status === 200 && (probation.body?.items || []).some(x => x.display_name === "白山")
    && probationDenied.status === 403
    && itAlerts.status === 200 && Array.isArray(itAlerts.body?.licenses_expiring_60d)
    && stale.status === 200 && Array.isArray(stale.body?.items),
    { probation: (probation.body?.items || []).map(x => x.display_name), denied: probationDenied.status,
      alerts: itAlerts.body?.licenses_expiring_60d?.length, stale: stale.body?.items?.length });

  const fallback = await loginPersona("mfg", "not-a-person");
  add("未知岗位回退公司管理员（persona=总经理）", fallback.status === 201 && fallback.body.persona?.title === "总经理",
    { persona: fallback.body?.persona });

  // S6 负例：未知公司 400
  const bad = await login("nope");
  add("未知公司 → 400 unknown_demo_company", bad.status === 400 && bad.body?.error === "unknown_demo_company",
    { status: bad.status, err: bad.body?.error });
};

try {
  await run();
} catch (e) {
  add("FATAL", false, { error: String(e?.message || e) });
} finally {
  console.log("\n=== 演示公司一键切换 · 端到端验收 ===");
  for (const s of steps) console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  const failed = steps.filter(s => !s.ok);
  console.log(`\n=== 步骤：${steps.length - failed.length}/${steps.length} 通过 ===`);
  console.log(JSON.stringify({ passed: failed.length === 0, steps_total: steps.length, steps_failed: failed.length }, null, 2));
  if (failed.length) exitCode = 1;
  await admin?.end();
  server?.kill();
  destroyContainer();
}
process.exit(exitCode);

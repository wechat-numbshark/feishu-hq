// M3 验收：三条业务链端到端真实集成（隔离库 + 真实 HTTP + 真实 RLS）。
// 链1 商机 -> 项目 -> 回款；链2 需求 -> 入职 -> 资产；链3 费用 -> 审批 -> 财务。
// 每条链跨模块写入后，用独立 GET 读回断言"关联真的落了库"，而非仅 2xx。
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

const uid = () => Math.floor(Math.random() * 1e9);

// 步骤累加器：记录每步 name/ok/detail，并保留产出供后续步引用。
function tracker() {
  const steps = [];
  return {
    steps,
    add(name, ok, detail) { steps.push({ name, ok: !!ok, detail }); return steps[steps.length - 1]; },
    get passed() { return steps.length > 0 && steps.every((s) => s.ok); },
  };
}

// ── 链1：商机 -> 项目立项 -> 回款计划 ──────────────────────
async function chain1(cookies) {
  const t = tracker();
  const cust = `验收客户-${uid()}`;
  // 1 员工创建商机
  const opp = await call(cookies.employee, "POST", "/v1/crm/opportunities",
    { name: `商机-${uid()}`, customer_name: cust, amount_cents: 2000000 });
  t.add("链1·步骤1 创建商机", opp.status === 201 && opp.payload.id, { status: opp.status, id: opp.payload?.id });
  // 2 商机赢单
  const won = await call(cookies.employee, "PATCH", `/v1/crm/opportunities/${opp.payload.id}`, { stage: "won" });
  t.add("链1·步骤2 商机标记赢单", won.status === 200 && won.payload.stage === "won", { stage: won.payload?.stage });
  // 3 由商机立项
  const prj = await call(cookies.manager, "POST", "/v1/projects",
    { name: `交付项目-${uid()}`, customer_name: cust, budget_cents: 2000000, source_opportunity_id: opp.payload.id });
  t.add("链1·步骤3 商机转立项(带 source_opportunity_id)", prj.status === 201 && prj.payload.source_opportunity_id === opp.payload.id,
    { status: prj.status, source: prj.payload?.source_opportunity_id });
  // 4 建回款计划挂在项目上
  const pay = await call(cookies.finance, "POST", "/v1/finance/payments",
    { project_id: prj.payload.id, customer_name: cust, amount_cents: 2000000, due_date: "2026-12-31", milestone: "验收" });
  t.add("链1·步骤4 建回款计划(挂项目)", pay.status === 201 && pay.payload.project_id === prj.payload.id,
    { status: pay.status, project_id: pay.payload?.project_id });
  // 读回断言（admin）
  const rbOpp = await call(cookies.admin, "GET", `/v1/crm/opportunities/${opp.payload.id}`);
  const rbPrj = await call(cookies.admin, "GET", `/v1/projects/${prj.payload.id}`);
  const rbPay = await call(cookies.admin, "GET", "/v1/finance/payments");
  t.add("链1·读回 商机 stage=won", rbOpp.payload?.stage === "won", { stage: rbOpp.payload?.stage });
  t.add("链1·读回 项目 source_opportunity_id 落库", rbPrj.payload?.source_opportunity_id === opp.payload.id,
    { source: rbPrj.payload?.source_opportunity_id });
  t.add("链1·读回 回款计划关联项目落库",
    (rbPay.payload?.items ?? []).some((p) => p.id === pay.payload.id && p.project_id === prj.payload.id), {});
  return t;
}

// ── 链2：招聘需求 -> 入职 -> 资产分配 ─────────────────────
async function chain2(cookies) {
  const t = tracker();
  const empName = `新员工-${uid()}`;
  // 1 创建招聘需求
  const req = await call(cookies.hr, "POST", "/v1/hr/requisitions",
    { title: `后端工程师-${uid()}`, headcount: 1, reason: "M3 业务链验收" });
  t.add("链2·步骤1 创建招聘需求", req.status === 201 && req.payload.id, { status: req.status, id: req.payload?.id });
  // 2 审批通过需求
  const appr = await call(cookies.hr, "PATCH", `/v1/hr/requisitions/${req.payload.id}`, { status: "approved" });
  t.add("链2·步骤2 需求审批通过", appr.status === 200 && appr.payload.status === "approved", { status: appr.payload?.status });
  // 3 入职（建人 + 雇佣）
  const hire = await call(cookies.hr, "POST", "/v1/hr/employees",
    { display_name: empName, primary_email: `hire-${uid()}@acceptance.test`, employee_number: `HIRE-${uid()}`,
      manager_person_id: null, status: "active" });
  const personId = hire.payload?.person_id;
  t.add("链2·步骤3 入职生成员工(person+employment)", hire.status === 201 && !!personId,
    { status: hire.status, person_id: personId });
  // 4 给新员工分配资产
  const asset = await call(cookies.admin, "POST", "/v1/it/assets",
    { name: `MacBook-${uid()}`, category: "hardware", status: "in_use", assigned_person_id: personId });
  t.add("链2·步骤4 分配资产给新员工", asset.status === 201 && asset.payload.assigned_person_id === personId,
    { status: asset.status, assigned: asset.payload?.assigned_person_id });
  // 读回断言（admin）
  const rbReq = await call(cookies.admin, "GET", `/v1/hr/requisitions/${req.payload.id}`);
  const rbMembers = await call(cookies.admin, "GET", "/v1/rbac/members");
  const rbAssets = await call(cookies.admin, "GET", "/v1/it/assets");
  t.add("链2·读回 需求 status=approved 落库", rbReq.payload?.status === "approved", { status: rbReq.payload?.status });
  t.add("链2·读回 新员工出现在成员名册",
    (rbMembers.payload?.items ?? []).some((m) => m.id === personId), {});
  t.add("链2·读回 资产 assigned_person_id=新员工 落库",
    (rbAssets.payload?.items ?? []).some((a) => a.id === asset.payload.id && a.assigned_person_id === personId), {});
  return t;
}

// ── 链3：费用报销 -> 审批引擎 -> 财务处理 ─────────────────
async function chain3(cookies) {
  const t = tracker();
  const amount = 1_000_000; // > 阈值 500000，触发审批
  // 1 员工提交报销（自动生成审批实例，step1=直属上级 manager）
  const exp = await call(cookies.employee, "POST", "/v1/finance/expenses",
    { category: "travel", amount_cents: amount, expense_date: "2026-03-01", description: "M3 差旅" });
  t.add("链3·步骤1 提交超标报销并触发审批", exp.status === 201 && exp.payload.needs_approval === true,
    { status: exp.status, needs_approval: exp.payload?.needs_approval });
  // 找到该报销对应的审批实例
  const list = await call(cookies.admin, "GET", "/v1/approvals");
  const items = list.payload?.items ?? [];
  const inst = items.find((a) => a.resource_id === exp.payload?.id);
  if (!inst) {
    t.add("链3·步骤2 审批实例已生成(pending)", false,
      { exp_status: exp.status, needs_approval: exp.payload?.needs_approval, list_status: list.status,
        approvals_count: items.length, resource_ids: items.map((a) => a.resource_id).slice(0, 5),
        exp_payload: exp.payload });
    return t;
  }
  t.add("链3·步骤2 审批实例已生成(pending)", !!inst && inst.status === "pending", { instance: inst?.id, status: inst?.status });
  // 3 直属上级在审批引擎里批准 step1 -> 推进到 step2(role)
  const decided = await call(cookies.manager, "POST", `/v1/approvals/${inst.id}/decide`,
    { decision: "approved", comment: "上级同意" });
  t.add("链3·步骤3 上级经审批引擎批准 step1", decided.status === 200 && decided.payload.newStatus === "pending",
    { status: decided.status, newStatus: decided.payload?.newStatus });
  // 4 财务对报销单作终审批准（职责分离：非提交人）
  const fin = await call(cookies.finance, "POST", `/v1/finance/expenses/${exp.payload.id}/approve`, { approved: true });
  t.add("链3·步骤4 财务终审批准报销单", fin.status === 200 && fin.payload.status === "approved",
    { status: fin.status, exp_status: fin.payload?.status });
  // 5 财务登记付款/回款记录
  const pay = await call(cookies.finance, "POST", "/v1/finance/payments",
    { customer_name: `员工报销-${uid()}`, amount_cents: amount, due_date: "2026-03-31", milestone: "差旅报销出账" });
  t.add("链3·步骤5 登记财务出账计划", pay.status === 201, { status: pay.status });
  // 读回断言（admin）
  const rbInst = await call(cookies.admin, "GET", `/v1/approvals/${inst.id}`);
  const step1 = (rbInst.payload?.actions ?? []).find((a) => a.step_order === 1);
  const rbExp = await call(cookies.admin, "GET", `/v1/finance/expenses/${exp.payload.id}`);
  const rbPay = await call(cookies.admin, "GET", "/v1/finance/payments");
  t.add("链3·读回 审批实例 step1=approved 且已推进到 step2",
    step1?.status === "approved" && rbInst.payload?.current_step === 2,
    { step1: step1?.status, current_step: rbInst.payload?.current_step });
  t.add("链3·读回 报销单 status=approved 落库", rbExp.payload?.status === "approved", { status: rbExp.payload?.status });
  t.add("链3·读回 出账计划落库",
    (rbPay.payload?.items ?? []).some((p) => p.id === pay.payload.id), {});
  return t;
}

async function main() {
  await ensureContainer({ fresh: true });
  const mig = await applyMigrations();
  await runSeed("./seed.mjs");
  const server = startServer();
  let exitCode = 0;
  try {
    await waitHealth(server);
    const cookies = await makeCookies();
    const chains = {
      "链1 商机->项目->回款": await chain1(cookies),
      "链2 需求->入职->资产": await chain2(cookies),
      "链3 费用->审批->财务": await chain3(cookies),
    };
    const allSteps = Object.values(chains).flatMap((c) => c.steps);
    const failed = allSteps.filter((s) => !s.ok);
    const report = {
      migrations: mig,
      chains: Object.fromEntries(Object.entries(chains).map(([k, c]) => [k, { passed: c.passed, steps: c.steps }])),
      chains_passed: Object.values(chains).filter((c) => c.passed).length,
      chains_total: Object.keys(chains).length,
      total_steps: allSteps.length,
      failed_steps: failed.length,
      passed: Object.values(chains).every((c) => c.passed),
    };
    console.log("=== M3 三条业务链端到端 ===");
    for (const [name, c] of Object.entries(chains)) {
      console.log(`\n[${c.passed ? "PASS" : "FAIL"}] ${name}`);
      for (const s of c.steps) {
        console.log(`  ${s.ok ? "OK " : "BAD"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
      }
    }
    console.log("\n" + JSON.stringify(report, null, 2));
    if (!report.passed) exitCode = 1;
  } finally {
    server.kill("SIGTERM");
  }
  process.exit(exitCode);
}

main().catch((err) => { console.error("M3 harness error:", err); process.exit(2); });

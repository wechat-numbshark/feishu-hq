// A2 回归（npm run accept:a2）：真实验证 finance→审批 原子性 fail-closed。
// 纪律：全部断言基于真实 HTTP 响应 + 真实 DB 读回；失败即 exit 1，绝不打印假 PASS。
// 断言链：
//   A) 活跃 expense 流程 + 超标报销 -> 201，费用行与审批实例同事务落库（原子成功）。
//   B) 关闭 expense 流程 -> createApprovalInstance 返回 null -> finance throw -> withTenant ROLLBACK：
//      期望非 2xx(400 approval_flow_unavailable)，且费用行数不增加（证明不落“孤儿费用”，绝非旧担忧的 201）。
//   C) 流程仍关闭下提交“未超标”报销 -> 201（needs_approval=false），费用行 +1：
//      证明 B 的拒绝严格归因于审批创建失败，而非把整个端点打死，回滚范围精确。
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth,
  makeCookies, HOST_URL, REPO, dockerExecSql,
} from "./lib.mjs";

const TENANT = "10000000-0000-4000-8000-000000000001"; // seed 中活跃 expense 流程所属租户

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

const psqlInt = (sql) => {
  const out = dockerExecSql(sql);
  const m = out.match(/^\s*(-?\d+)\s*$/m); // psql 对齐输出中的纯数字数据行
  if (!m) throw new Error(`psql 未解析到整数，原始输出：\n${out}`);
  return Number(m[1]);
};
const expenseCount = () =>
  psqlInt(`SELECT count(*)::int FROM finance.expenses WHERE tenant_id='${TENANT}';`);
const instanceCount = () =>
  psqlInt(`SELECT count(*)::int FROM platform.approval_instances WHERE tenant_id='${TENANT}' AND resource_type='expense';`);

const steps = [];
function add(name, ok, detail) { steps.push({ name, ok: !!ok, detail }); }

let server;
let exitCode = 0;
try {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  await runSeed("./seed.mjs");
  server = startServer();
  await waitHealth(server);
  const cookies = await makeCookies();

  // A) 正常超标报销：流程活跃 -> 201，费用 + 实例原子落库
  const cA0 = expenseCount(), iA0 = instanceCount();
  const expA = await call(cookies.employee, "POST", "/v1/finance/expenses",
    { category: "travel", amount_cents: 1_000_000, expense_date: "2026-03-01", description: "A2 正常超标" });
  const cA1 = expenseCount(), iA1 = instanceCount();
  add("A 超标报销成功 201", expA.status === 201 && expA.payload?.needs_approval === true,
    { status: expA.status, needs_approval: expA.payload?.needs_approval });
  add("A 费用行与审批实例同事务落库（各 +1）",
    cA1 === cA0 + 1 && iA1 === iA0 + 1, { expense_delta: cA1 - cA0, instance_delta: iA1 - iA0 });

  // B) 关闭 expense 流程：模拟审批创建失败 -> fail-closed（非 2xx 且不落费用）
  dockerExecSql(`UPDATE platform.approval_flows SET is_active = false WHERE tenant_id='${TENANT}' AND code='expense';`);
  const cB0 = expenseCount(), iB0 = instanceCount();
  const expB = await call(cookies.employee, "POST", "/v1/finance/expenses",
    { category: "travel", amount_cents: 2_000_000, expense_date: "2026-03-02", description: "A2 审批不可用" });
  const cB1 = expenseCount(), iB1 = instanceCount();
  add("B 审批创建失败时返回非 2xx(400)",
    expB.status >= 400 && expB.status < 500 && expB.payload?.error === "approval_flow_unavailable",
    { status: expB.status, error: expB.payload?.error });
  add("B 费用未落库、无审批孤儿（回滚生效）",
    cB1 === cB0 && iB1 === iB0, { expense_delta: cB1 - cB0, instance_delta: iB1 - iB0 });

  // C) 流程仍关闭但“未超标”报销 -> 201（不需审批），回滚范围精确，端点未被整体打死
  const cC0 = expenseCount();
  const expC = await call(cookies.employee, "POST", "/v1/finance/expenses",
    { category: "meals", amount_cents: 100_000, expense_date: "2026-03-03", description: "A2 未超标" });
  const cC1 = expenseCount();
  add("C 未超标报销仍 201 且落库", expC.status === 201 && expC.payload?.needs_approval === false && cC1 === cC0 + 1,
    { status: expC.status, error: expC.payload?.error, needs_approval: expC.payload?.needs_approval, expense_delta: cC1 - cC0 });

  const failed = steps.filter((s) => !s.ok);
  console.log("=== A2 finance→审批 原子性 fail-closed ===");
  for (const s of steps) console.log(`  ${s.ok ? "OK " : "BAD"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  console.log("\n" + JSON.stringify({
    passed: failed.length === 0, total_steps: steps.length, failed_steps: failed.length,
    final_expense_rows: expenseCount(), final_expense_instances: instanceCount(),
  }, null, 2));
  if (failed.length) exitCode = 1;
} catch (e) {
  console.log(JSON.stringify({ RESULT: "FAIL", error: String(e && e.message || e) }));
  exitCode = 1;
} finally {
  server?.kill("SIGTERM");
}
process.exit(exitCode);

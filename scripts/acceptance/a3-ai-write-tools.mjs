// P2a 回归（npm run accept:a3）：AI 受控写工具扩展——真实 DB 读回 + 越权拒绝无副作用。
// 纪律：全部经 executeTool 真实执行（两阶段事务 + 审计），断言基于真实行读回；失败即 exit 1。
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  ensureContainer, applyMigrations, runSeed, ADMIN_DB_URL, SESSION_SECRET,
} from "./lib.mjs";

const T = (await import("./seed.mjs")).T;

const steps = [];
const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });

let admin;
let exitCode = 0;
try {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  await runSeed("./seed.mjs");
  process.env.DATABASE_URL = ADMIN_DB_URL;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.MODEL_API_KEY = "";
  const { executeTool } = await import("../../apps/api/src/ai.ts");

  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();

  // 真实夹具：一条商机（qualified）
  const OPP = randomUUID();
  await admin.query(
    `INSERT INTO crm.opportunities (id, tenant_id, name, customer_name, amount_cents, stage)
     VALUES ($1,$2,'A3 商机','客户A',800000,'qualified')`, [OPP, T.tenant]);

  const adminIdentity = { tenantId: T.tenant, personId: T.admin, role: "tenant_admin", mode: "feishu" };
  const empIdentity = { tenantId: T.tenant, personId: T.employee, role: "employee", mode: "feishu" };
  const expCount = async () => (await admin.query(`SELECT count(*)::int c FROM finance.expenses WHERE tenant_id=$1`, [T.tenant])).rows[0].c;
  const instCount = async () => (await admin.query(`SELECT count(*)::int c FROM platform.approval_instances WHERE tenant_id=$1 AND resource_type='expense'`, [T.tenant])).rows[0].c;
  const reqCount = async () => (await admin.query(`SELECT count(*)::int c FROM hr.job_requisitions WHERE tenant_id=$1`, [T.tenant])).rows[0].c;

  // 1) update_opportunity_stage：推进阶段并真实回写
  await executeTool("update_opportunity_stage", { opportunity_id: OPP, stage: "proposal", win_probability: 70 }, adminIdentity, { traceId: randomUUID() });
  const opp = (await admin.query(`SELECT stage, win_probability FROM crm.opportunities WHERE id=$1`, [OPP])).rows[0];
  add("1 update_opportunity_stage 真实回写 stage/win_probability",
    opp.stage === "proposal" && Number(opp.win_probability) === 70, { stage: opp.stage, wp: opp.win_probability });

  // 2) create_expense 低于阈值：落库、不需审批、无审批实例
  const e0 = await expCount(), i0 = await instCount();
  const rExpLow = await executeTool("create_expense", { category: "meals", amount_cents: 100000, expense_date: "2026-04-01", description: "A3 低额" }, adminIdentity, { traceId: randomUUID() });
  const e1 = await expCount(), i1 = await instCount();
  add("2 create_expense 低于阈值→201/needs_approval=false，费用+1、实例+0",
    rExpLow.created === true && rExpLow.needs_approval === false && e1 === e0 + 1 && i1 === i0,
    { needs_approval: rExpLow.needs_approval, expense_delta: e1 - e0, instance_delta: i1 - i0 });

  // 3) create_expense 超阈值：与审批同事务原子落库（走 A2 fail-closed 路径）
  const e2 = await expCount(), i2 = await instCount();
  const rExpHigh = await executeTool("create_expense", { category: "travel", amount_cents: 1000000, expense_date: "2026-04-02", description: "A3 超标" }, adminIdentity, { traceId: randomUUID() });
  const e3 = await expCount(), i3 = await instCount();
  add("3 create_expense 超阈值→needs_approval=true，费用与审批实例各+1（原子）",
    rExpHigh.needs_approval === true && e3 === e2 + 1 && i3 === i2 + 1,
    { needs_approval: rExpHigh.needs_approval, expense_delta: e3 - e2, instance_delta: i3 - i2 });

  // 4) create_requisition：真实创建招聘需求
  const q0 = await reqCount();
  const rReq = await executeTool("create_requisition", { title: "A3 工程师", headcount: 2, reason: "扩张" }, adminIdentity, { traceId: randomUUID() });
  const q1 = await reqCount();
  add("4 create_requisition 真实落库招聘需求",
    rReq.created === true && q1 === q0 + 1, { requisition_id: rReq.requisition?.id, delta: q1 - q0 });

  // 5) 受控：普通员工未获 create_expense 授权 → 拒绝且无任何副作用
  const before = await expCount();
  let denied = false, derr = "";
  try { await executeTool("create_expense", { category: "meals", amount_cents: 5000, expense_date: "2026-04-03", description: "A3 越权" }, empIdentity, { traceId: randomUUID() }); }
  catch (e) { denied = /permission_denied/.test(String(e.message || e)); derr = String(e.message || e); }
  const after = await expCount();
  add("5 员工无授权调用 create_expense(L2) 被拒且费用零新增",
    denied && after === before, { error: derr, delta: after - before });

  const failed = steps.filter((s) => !s.ok);
  console.log("=== P2a AI 受控写工具扩展 端到端 ===");
  for (const s of steps) console.log(`  ${s.ok ? "OK " : "BAD"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  console.log("\n" + JSON.stringify({ passed: failed.length === 0, total_steps: steps.length, failed_steps: failed.length }, null, 2));
  if (failed.length) exitCode = 1;
} catch (e) {
  console.log(JSON.stringify({ RESULT: "FAIL", error: String(e && e.message || e) }));
  exitCode = 1;
} finally {
  await admin?.end();
}
process.exit(exitCode);

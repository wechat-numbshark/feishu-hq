// P2b 回归（npm run accept:q1）：持久作业队列——可恢复/重试/死信/AI 入队/幂等，真实 PG 端到端。
// 纪律：worker 与测试共用 packages/domain/src/job-queue.ts 同一实现；断言基于真实行状态读回；失败即 exit 1。
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  ensureContainer, applyMigrations, runSeed, ADMIN_DB_URL, REPO, SESSION_SECRET,
} from "./lib.mjs";
import { enqueueJob, processDueJobs } from "../../packages/domain/src/job-queue.ts";

const T = (await import("./seed.mjs")).T;

const steps = [];
const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });
const jobState = async (admin, id) =>
  (await admin.query(`SELECT status, attempts, last_error, result FROM platform.jobs WHERE id=$1`, [id])).rows[0];

let admin;
let exitCode = 0;
try {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  await runSeed("./seed.mjs");

  process.env.DATABASE_URL = ADMIN_DB_URL;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.MODEL_API_KEY = "";
  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();

  // A) 成功：入队周报作业 → 处理 → succeeded 且 result 含真实聚合键
  const jobA = await enqueueJob(admin, { tenantId: T.tenant, kind: "generate_weekly_report", payload: {}, maxAttempts: 3 });
  const resA = await processDueJobs(admin, { limit: 50 });
  const stA = await jobState(admin, jobA.id);
  const resultKeys = stA.result ? Object.keys(stA.result) : [];
  add("A 周报作业处理为 succeeded 且 result 含 projects/crm/hr/finance",
    stA.status === "succeeded" && ["projects","crm","hr","finance"].every((k) => resultKeys.includes(k)),
    { status: stA.status, resultKeys });
  void resA;

  // B) 重试→死信：未知 kind、max_attempts=2、退避 0；两次处理第一次重排、第二次转 dead
  const jobB = await enqueueJob(admin, { tenantId: T.tenant, kind: "no_such_kind", payload: {}, maxAttempts: 2 });
  await processDueJobs(admin, { limit: 50, backoffSeconds: 0 });
  const stB1 = await jobState(admin, jobB.id);
  await processDueJobs(admin, { limit: 50, backoffSeconds: 0 });
  const stB2 = await jobState(admin, jobB.id);
  add("B 失败作业首次重排(queued,attempts=1)、再次达上限转 dead 且记 last_error",
    stB1.status === "queued" && Number(stB1.attempts) === 1 && stB2.status === "dead" && /no_handler/.test(stB2.last_error || ""),
    { first: { status: stB1.status, attempts: stB1.attempts }, second: { status: stB2.status, attempts: stB2.attempts, err: stB2.last_error } });

  // C) 崩溃恢复：一条 running 且租约已过期的作业应被 processDueJobs 重新领取并处理至 succeeded
  const jobCId = randomUUID();
  await admin.query(
    `INSERT INTO platform.jobs (id, tenant_id, kind, payload, status, attempts, max_attempts, lease_until, available_at)
     VALUES ($1,$2,'generate_weekly_report','{}'::jsonb,'running',1,3, now() - interval '1 minute', now())`,
    [jobCId, T.tenant]);
  const resC = await processDueJobs(admin, { limit: 50 });
  const stC = await jobState(admin, jobCId);
  add("C 租约过期的 running 作业被重新领取并恢复处理至 succeeded(attempts 1→2)",
    resC.some((r) => r.id === jobCId) && stC.status === "succeeded" && Number(stC.attempts) === 2,
    { reclaimed: resC.some((r) => r.id === jobCId), final: stC.status, attempts: stC.attempts });

  // D) AI 受控写工具入队：tenant_admin 经 executeTool 排入队列，worker 侧真实执行
  const { executeTool } = await import("../../apps/api/src/ai.ts");
  const adminIdentity = { tenantId: T.tenant, personId: T.admin, role: "tenant_admin", mode: "feishu" };
  const dRes = await executeTool("queue_weekly_report", {}, adminIdentity, { traceId: randomUUID() });
  const aiJobId = dRes?.job_id;
  const stBefore = aiJobId ? await jobState(admin, aiJobId) : null;
  await processDueJobs(admin, { limit: 50 });
  const stD = aiJobId ? await jobState(admin, aiJobId) : null;
  add("D AI queue_weekly_report 真实入队(platform.jobs)并被处理为 succeeded",
    dRes?.queued === true && stBefore?.status === "queued" && stD?.status === "succeeded",
    { queued: dRes?.queued, job_id: aiJobId, before: stBefore?.status, after: stD?.status });

  // E) 幂等：同 idempotencyKey 两次入队只一行、返回同一 id
  const key = `idem:${randomUUID()}`;
  const e1 = await enqueueJob(admin, { tenantId: T.tenant, kind: "generate_weekly_report", idempotencyKey: key });
  const e2 = await enqueueJob(admin, { tenantId: T.tenant, kind: "generate_weekly_report", idempotencyKey: key });
  const eCount = (await admin.query(`SELECT count(*)::int c FROM platform.jobs WHERE tenant_id=$1 AND idempotency_key=$2`, [T.tenant, key])).rows[0].c;
  add("E 幂等入队：同 key 两次仅一行且返回同一 job id",
    eCount === 1 && e1.id === e2.id, { count: eCount, same: e1.id === e2.id });

  const failed = steps.filter((s) => !s.ok);
  console.log("=== P2b 持久作业队列 端到端 ===");
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

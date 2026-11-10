// 端到端真实验收编排器（Windows + Docker Desktop）。
// 隔离库 -> 迁移 -> 种子 -> 桩模型 -> 真实 API 子进程 -> M1~M4 真实 HTTP + 真实库读回 -> 真实退出码。
// 用法：node --experimental-strip-types scripts/acceptance/run.mjs [--keep]
//   --keep：跑完后保留容器与 API，便于人工复验（默认跑完销毁）。
import pg from "pg";
import { T } from "./seed.mjs";
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth, makeCookies,
  startStubModel, destroyContainer, api, ADMIN_DB_URL, MODEL_BASE_URL, STUB_PORT,
} from "./lib.mjs";

const results = [];
function check(suite, name, pass, detail = "") {
  results.push({ suite, name, pass: !!pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail && !pass ? " — " + detail : ""}`);
}

async function readBack(sql, values = []) {
  const c = new pg.Client({ connectionString: ADMIN_DB_URL });
  await c.connect();
  try { const { rows } = await c.query(sql, values); return { rows }; }
  finally { await c.end(); }
}
async function dbExpectError(sql, values = []) {
  const c = new pg.Client({ connectionString: ADMIN_DB_URL });
  await c.connect();
  try { await c.query(sql, values); return ""; }
  catch (e) { return String(e.message || e); }
  finally { await c.end().catch(() => {}); }
}

let child, stub;
async function main() {
  console.log("== 验收 harness：隔离库 + 真实 API + 真实 HTTP ==");
  await ensureContainer({ fresh: true });
  const mig = await applyMigrations();
  console.log(`✓ 容器就绪，迁移 ${mig.applied} 个`);
  await runSeed("./seed.mjs");
  console.log("✓ 5 角色 + 跨租户种子完成");

  stub = await startStubModel();
  console.log(`✓ 桩模型 :${STUB_PORT}`);
  child = startServer({
    MODEL_API_KEY: "stub-key",
    MODEL_BASE_URL,
    MODEL_NAME: "stub-model",
  });
  const health = await waitHealth(child);
  console.log(`✓ API 健康 status=${health.status} database=${health.database}`);

  const cookies = await makeCookies();
  const ctx = { api, cookies, readBack, dbExpectError, check, T };

  const allSuites = [
    ["M1", "./suite-m1.mjs"],
    ["M2", "./suite-m2.mjs"],
    ["M3", "./suite-m3.mjs"],
    ["M4", "./suite-m4.mjs"],
  ];
  // 允许按里程碑筛选运行：node run.mjs M1 / M2 M3 / M4 ...（缺省跑全部）。
  const selected = process.argv.slice(2).filter((a) => /^M[1-4]$/i.test(a)).map((a) => a.toUpperCase());
  const suites = selected.length ? allSuites.filter(([label]) => selected.includes(label)) : allSuites;
  for (const [label, mod] of suites) {
    console.log(`\n—— ${label} ——`);
    const fn = (await import(mod)).default;
    try { await fn(ctx); }
    catch (e) { check(label, `${label} 套件异常`, false, String(e?.stack || e)); }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n==== 验收汇总：${passed}/${results.length} 通过，${failed} 失败 ====`);
  for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL [${r.suite}] ${r.name} ${r.detail}`);

  if (!process.argv.includes("--keep")) { try { child?.kill("SIGKILL"); } catch {} stub?.close(); destroyContainer(); }
  else { console.log("（--keep：保留容器/API，手动清理：docker rm -f hq-acceptance-db）"); try { child?.kill("SIGKILL"); } catch {} stub?.close(); }
  process.exit(failed === 0 && results.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS_ERROR:", e?.stack || e);
  try { child?.kill("SIGKILL"); } catch {}
  stub?.close();
  if (!process.argv.includes("--keep")) destroyContainer();
  process.exit(1);
});

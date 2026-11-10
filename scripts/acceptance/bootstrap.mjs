// 地基自检（t2）：真实隔离库 + 真实迁移 + 5 角色种子 + 真实 API 子进程 + 真实会话读回。
// 只用真实命令与真实 HTTP/DB，任何一步失败即非零退出，绝不打印假 PASS。
// 运行：node --experimental-strip-types scripts/acceptance/bootstrap.mjs
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth,
  makeCookies, HOST_URL, destroyContainer,
} from "./lib.mjs";

let child;
const cleanup = () => { try { child?.kill("SIGKILL"); } catch {} destroyContainer(); };
process.on("SIGINT", () => { cleanup(); process.exit(130); });

try {
  console.log("== [1] 启动隔离 Postgres 容器 ==");
  await ensureContainer({ fresh: true });
  console.log("  ✓ 容器就绪 localhost:15434");

  console.log("== [2] 应用全部迁移 ==");
  const mig = await applyMigrations();
  console.log(`  ✓ 迁移应用：${mig.applied} 个，schema_migrations 行数=${mig.count}`);

  console.log("== [3] 种子 5 角色 + 跨租户 ==");
  const { default: seedPath } = { default: "./seed.mjs" };
  await runSeed(seedPath);
  console.log("  ✓ 种子完成");

  console.log("== [4] 启动真实 API 子进程 ==");
  child = startServer();
  const health = await waitHealth(child);
  console.log(`  ✓ /health status=${health.status} database=${health.database} version=${health.version}`);

  console.log("== [5] 真实会话读回 ==");
  const cookies = await makeCookies();
  const sess = await fetch(`${HOST_URL}/v1/session`, { headers: { cookie: cookies.admin }, redirect: "manual" });
  const body = await sess.json();
  console.log(`  admin GET /v1/session -> ${sess.status} authenticated=${body.authenticated} user=${body.user?.displayName ?? body.user?.display_name ?? "?"}`);
  const ws = await fetch(`${HOST_URL}/v1/workspace`, { headers: { cookie: cookies.employee }, redirect: "manual" });
  console.log(`  employee GET /v1/workspace -> ${ws.status}`);

  const ok = health.status === "ok" && health.database === "connected" && sess.status === 200 && body.authenticated === true && ws.status === 200;
  console.log(ok ? "\nBOOTSTRAP_RESULT: PASS" : "\nBOOTSTRAP_RESULT: FAIL");
  cleanup();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("\nBOOTSTRAP_ERROR:", e?.stack || e);
  cleanup();
  process.exit(1);
}

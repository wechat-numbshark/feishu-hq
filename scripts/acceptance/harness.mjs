// 真实端到端验收 harness。
// 运行位置：必须在能直连 compose Postgres 的网络内（见 deploy/compose/docker-compose.acceptance.yml）。
// 流程：建隔离库 -> 应用全部迁移 -> 种子 5 角色租户 -> 起桩模型 + 起真实 API 子进程 ->
//       用真实 HTTP/fetch 跑 M1/M2/M3/M4 套件并读回数据库 -> 汇总打真实退出码。
//
// 关键纪律：任何断言都基于真实响应/真实库记录；失败即 exit 1，绝不打印假 PASS。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const ENV = {
  adminUrl: process.env.ACCEPT_ADMIN_URL || "postgresql://hq_admin:change_me@postgres:5432/postgres",
  db: process.env.ACCEPT_DB || "feishu_hq_accept",
  apiPort: Number(process.env.API_PORT || 3000),
  stubPort: Number(process.env.STUB_MODEL_PORT || 3900),
  sessionSecret: process.env.SESSION_SECRET || "acceptance-harness-secret-please-change-32",
};

// ── 结果收集 ──
const results = [];
function check(suite, name, pass, detail = "") {
  results.push({ suite, name, pass: !!pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? " — " + detail : ""}`);
}

// ── Postgres：建库 + 迁移 + 种子 ──
async function adminClient(database = "postgres") {
  const cfg = parseUrl(ENV.adminUrl);
  const c = new pg.Client({ ...cfg, database });
  await c.connect();
  return c;
}
function parseUrl(u) {
  const m = new URL(u);
  return {
    host: m.hostname,
    port: Number(m.port || 5432),
    user: decodeURIComponent(m.username),
    password: decodeURIComponent(m.password),
    ssl: false,
  };
}
function appUrl(dbName) {
  const base = new URL(ENV.adminUrl);
  return `${base.protocol}//${base.username}:${base.password}@${base.host}:${base.port || 5432}/${dbName}`;
}

async function provision() {
  const admin = await adminClient("postgres");
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [ENV.db]);
  await admin.query(`DROP DATABASE IF EXISTS "${ENV.db}"`);
  await admin.query(`CREATE DATABASE "${ENV.db}"`);
  await admin.end();
  console.log(`✓ 已创建隔离库 ${ENV.db}`);

  const db = await adminClient(ENV.db);
  const migDir = resolve(REPO, "database/migrations");
  const files = (await readdir(migDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = await readFile(resolve(migDir, f), "utf8");
    try {
      await db.query(sql);
    } catch (e) {
      console.error(`✗ 迁移 ${f} 失败：`, e.message);
      throw e;
    }
  }
  console.log(`✓ 已应用 ${files.length} 个迁移`);

  const { buildSeedStatements } = await import("./seed.mjs");
  for (const { sql, values } of buildSeedStatements()) {
    await db.query(sql, values);
  }
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM platform.people WHERE tenant_id = $1`, [appTenant()]);
  console.log(`✓ 已种子验收租户（${rows[0].n} 人）`);
  await db.end();
  return { migrations: files.length };
}
function appTenant() {
  return "10000000-0000-4000-8000-000000000001";
}

async function readBack(sql, values = []) {
  const db = await adminClient(ENV.db);
  try {
    const { rows } = await db.query(sql, values);
    return rows;
  } finally {
    await db.end();
  }
}

// ── 桩模型：OpenAI 兼容 /chat/completions，按用户消息里的 [[...]] 指令确定性返回 ──
// 指令语法：[[tool:NAME:JSONARGS]] 触发一次工具调用；[[status:NNN]] 让端点返回该 HTTP 码（模拟超时/5xx）。
function startStubModel() {
  return new Promise((res) => {
    const server = createServer((req, response) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!req.url.endsWith("/chat/completions")) {
          response.writeHead(404).end("{}");
          return;
        }
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        const messages = parsed.messages || [];
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const text = typeof lastUser?.content === "string" ? lastUser.content : "";

        const statusMatch = text.match(/\[\[status:(\d+)\]\]/);
        if (statusMatch) {
          response.writeHead(Number(statusMatch[1]), { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "stub_forced_error" }));
          return;
        }
        // 若最近一条已是 tool 结果，则给最终总结（结束工具循环）
        const lastIsTool = messages[messages.length - 1]?.role === "tool";
        const toolMatch = text.match(/\[\[tool:([a-zA-Z_]+):([\s\S]*?)\]\]/);
        if (toolMatch && !lastIsTool) {
          const [, name, rawArgs] = toolMatch;
          let args = {};
          try { args = JSON.parse(rawArgs || "{}"); } catch {}
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            choices: [{ message: {
              content: `我将调用 ${name}。`,
              tool_calls: [{ id: "call_" + Math.random().toString(36).slice(2, 8), type: "function", function: { name, arguments: JSON.stringify(args) } }],
            } }],
            usage: { total_tokens: 1 },
          }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: "已完成分析（桩模型确定性回复）。" } }],
          usage: { total_tokens: 1 },
        }));
      });
    });
    server.listen(ENV.stubPort, "127.0.0.1", () => {
      console.log(`✓ 桩模型监听 http://127.0.0.1:${ENV.stubPort}/v1`);
      res(server);
    });
  });
}

// ── 起真实 API 子进程 ──
function startApi() {
  const child = spawn(process.execPath, ["--experimental-strip-types", "apps/api/src/main.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(ENV.apiPort),
      HOST: "127.0.0.1",
      DATABASE_URL: appUrl(ENV.db),
      SESSION_SECRET: ENV.sessionSecret,
      MODEL_API_KEY: "stub-key",
      MODEL_BASE_URL: `http://127.0.0.1:${ENV.stubPort}/v1`,
      MODEL_NAME: "stub-model",
      APP_BASE_URL: `http://127.0.0.1:${ENV.apiPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("[api] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[api:err] " + d));
  return child;
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${ENV.apiPort}/health`);
      const j = await r.json();
      if (j.status === "ok" && j.database === "connected") {
        console.log("✓ API 健康检查通过（数据库已连接）");
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API 未在超时内就绪");
}

// ── HTTP 辅助（真实 fetch，带会话 cookie）──
const BASE = () => `http://127.0.0.1:${ENV.apiPort}`;
async function api(cookie, method, path, body) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE() + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let json = null;
  const t = await r.text();
  try { json = t ? JSON.parse(t) : null; } catch { json = { raw: t }; }
  return { status: r.status, body: json };
}

export { ENV, REPO, results, check, adminClient, appUrl, provision, readBack, startStubModel, startApi, waitForHealth, api, appTenant };

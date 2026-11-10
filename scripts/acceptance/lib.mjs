// 验收测试共享 harness：隔离 Postgres 容器 + 真实 API 服务器 + 真实会话。
// 约束：自建临时容器、不碰演示/正式库、不改 .env、不部署正式环境。
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../..");

// ── 隔离环境常量（仅测试用，非任何正式凭据）──
export const CONTAINER = "hq-acceptance-db";
export const HOST_PORT = 15434;
export const DB_NAME = "feishu_hq";
export const DB_USER = "hq_admin"; // 容器超级用户（POSTGRES_USER），迁移/种子/API 连接均用它
export const DB_PASS = "acceptance_local_pw";
export const SESSION_SECRET = "acceptance-test-secret-0123456789abcdef0123456789abcdef";
export const API_PORT = 3199;
export const STUB_PORT = Number(process.env.STUB_MODEL_PORT || 3900);
export const HOST_URL = `http://127.0.0.1:${API_PORT}`;
export const MODEL_BASE_URL = `http://127.0.0.1:${STUB_PORT}/v1`;
export const ADMIN_DB_URL = `postgresql://${DB_USER}:${DB_PASS}@localhost:${HOST_PORT}/${DB_NAME}`;

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", cwd: REPO, ...opts });
}

export function dockerExecSql(sql) {
  const r = sh("docker", ["exec", "-i", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", DB_USER, "-d", DB_NAME], { input: sql });
  if (r.status !== 0) throw new Error(`psql failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function ensureContainer({ fresh = true } = {}) {
  if (fresh) sh("docker", ["rm", "-f", CONTAINER]);
  const running = sh("docker", ["ps", "--format", "{{.Names}}"]).stdout || "";
  if (!running.split("\n").includes(CONTAINER)) {
    const r = sh("docker", ["run", "-d", "--name", CONTAINER,
      "-e", `POSTGRES_USER=${DB_USER}`, "-e", `POSTGRES_PASSWORD=${DB_PASS}`,
      "-e", `POSTGRES_DB=${DB_NAME}`, "-p", `${HOST_PORT}:5432`, "postgres:16-alpine"]);
    if (r.status !== 0) throw new Error(`docker run failed:\n${r.stderr || r.stdout}`);
  }
  for (let i = 0; i < 60; i++) {
    const p = sh("docker", ["exec", CONTAINER, "pg_isready", "-U", DB_USER, "-d", DB_NAME]);
    // pg_isready 会看到 initdb 引导期的临时服务（随后进入 shutting down），
    // 因此再用一次真实 SELECT 1 确认数据库已正常接受连接。
    if (p.status === 0) {
      const probe = sh("docker", ["exec", "-i", CONTAINER, "psql", "-X", "-t", "-Ac", "SELECT 1", "-U", DB_USER, "-d", DB_NAME]);
      if (probe.status === 0 && probe.stdout.includes("1")) return;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("postgres not ready in time");
}

export async function applyMigrations() {
  const dir = resolve(REPO, "database/migrations");
  const files = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  const crypto = await import("node:crypto");
  for (const f of files) {
    const sql = await readFile(resolve(dir, f), "utf8");
    dockerExecSql(sql);
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    dockerExecSql(`INSERT INTO platform.schema_migrations(version, checksum) VALUES ('${f.replaceAll("'", "''")}', '${checksum}')
      ON CONFLICT (version) DO NOTHING;`);
  }
  const count = dockerExecSql("SELECT count(*) FROM platform.schema_migrations;");
  return { applied: files.length, count: count.match(/\d+/)?.[0] };
}

export async function runSeed(seedModule) {
  const { buildSeedStatements } = await import(seedModule);
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    for (const { sql, values } of buildSeedStatements()) {
      await client.query(sql, values);
    }
  } finally {
    await client.end();
  }
  return true;
}

export function startServer(extraEnv = {}) {
  const env = {
    ...process.env,
    DATABASE_URL: ADMIN_DB_URL,
    SESSION_SECRET,
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(API_PORT),
    ...extraEnv,
  };
  const child = spawn("node", ["--experimental-strip-types", "apps/api/src/main.ts"],
    { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));
  child._logs = logs;
  return child;
}

export async function waitHealth(child, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${HOST_URL}/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    if (child.exitCode != null) throw new Error(`server exited early:\n${child._logs.join("")}`);
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`server health timeout:\n${child._logs.join("")}`);
}

export async function makeCookies() {
  // 在同一进程内设置 SESSION_SECRET 后 import session.ts，签名与服务器一致。
  process.env.SESSION_SECRET = SESSION_SECRET;
  const { createSession } = await import("../../apps/api/src/session.ts");
  const { T } = await import("./seed.mjs");
  const mk = (personId, role) => `hq_session=${createSession({ tenantId: T.tenant, personId, role, mode: "feishu" })}`;
  return {
    admin: mk(T.admin, "tenant_admin"),
    manager: mk(T.manager, "employee"),
    hr: mk(T.hr, "employee"),
    finance: mk(T.finance, "employee"),
    employee: mk(T.employee, "employee"),
    adminB: `hq_session=${createSession({ tenantId: T.tenantB, personId: T.personB, role: "employee", mode: "feishu" })}`,
  };
}

export function destroyContainer() {
  sh("docker", ["rm", "-f", CONTAINER]);
}

// ── HTTP 辅助（真实 fetch，带会话 cookie）──
export async function api(cookie, method, path, body) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(HOST_URL + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let json = null;
  const t = await r.text();
  try { json = t ? JSON.parse(t) : null; } catch { json = { raw: t }; }
  return { status: r.status, body: json };
}

// ── 桩模型：OpenAI 兼容 /chat/completions，按用户消息里的 [[...]] 指令确定性返回 ──
// 指令语法：[[tool:NAME:JSONARGS]] 触发一次工具调用；[[status:NNN]] 强制该 HTTP 码（模拟模型故障）。
export function startStubModel(port = STUB_PORT) {
  return new Promise((res) => {
    const server = createServer((req, response) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!req.url.endsWith("/chat/completions")) { response.writeHead(404).end("{}"); return; }
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
    server.listen(port, "127.0.0.1", () => res(server));
  });
}

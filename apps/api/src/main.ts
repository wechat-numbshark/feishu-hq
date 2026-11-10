import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { config } from "./config.ts";
import { assertMutationMediaType, assertTrustedOrigin, clientIp, isMutation, securityHeaders } from "./security.ts";
import { enforcePolicy } from "./policy.ts";
import { assertCapability } from "./authz.ts";
import { withTenant } from "./db.ts";
import { databaseHealth, getFeishuTenantKey, getWorkspace, syncFeishuOrganization, upsertFeishuLogin } from "./database.ts";
import { createAuthorizeRequest, exchangeOAuthCode, fetchFeishuOrganization, feishuStatus, getFeishuUser } from "./feishu.ts";
import { createDemoFlow, getDemoWorkspace, resetDemoWorkspace, resolveDemoCompany, listDemoCompanies, resolveDemoPersona, listDemoPersonas, DEMO_PERSONAS } from "./demo.ts";
import {
  createOAuthState, createSession, createSessionRecord, expiredOAuthStateCookie,
  expiredSessionCookie, oauthStateCookie, readOAuthState, readSession, sessionCookie
} from "./session.ts";
import { isSessionActive, registerSession, revokeAllSessions, revokeSession } from "./sessions-store.ts";
import { recordRequest, renderMetrics } from "./metrics.ts";
import { authorize, baselinePolicies, type AuthorizationRequest } from "../../../packages/authz/src/index.ts";
import { dispatch, readBody, json } from "./router.ts";

// ── 注册所有模块路由（import 会自动执行 get/post/patch/del 注册）
import "./modules/projects.ts";
import "./modules/crm.ts";
import "./modules/hr.ts";
import "./modules/finance.ts";
import "./modules/it.ts";
import "./modules/knowledge.ts";
import "./modules/strategy.ts";
import "./modules/integrations.ts";
import "./modules/settings.ts";
import "./modules/approvals.ts";
import "./modules/manufacturing.ts";
import "./modules/supplychain.ts";
import "./modules/quality.ts";
import "./modules/equipment.ts";
import "./modules/sales.ts";
import "./modules/contracts.ts";
import "./modules/sw.ts";
import "./modules/dashboard.ts";
import "./modules/notifications-center.ts";
import "./modules/search.ts";
import "./modules/audit.ts";
import "./modules/exports.ts";
import "./modules/imports.ts";
import "./modules/workbench.ts";
import "./modules/deep.ts";
import "./modules/people.ts";
import "./modules/org.ts";
import "./ai.ts";

import { handleFeishuWebhook } from "./feishu-webhook.ts";

// ── 配置
const port = config.port;
const host = config.host;
const webRoot = resolve(process.cwd(), "apps/web");

// ── IP 速率限制（简单内存实现，每 IP 默认 120 请求/分钟；RATE_LIMIT_PER_MINUTE 可调，长链路验收/批量集成场景可调高）
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120);
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX_KEYS = 20_000;
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  // 防止伪造 IP 撑爆内存：超过上限时先清过期项，仍超限则拒绝新 key（fail-closed）。
  if (rateLimitMap.size >= RATE_LIMIT_MAX_KEYS && !rateLimitMap.has(ip)) {
    for (const [k, v] of rateLimitMap) { if (now > v.resetAt) rateLimitMap.delete(k); }
    if (rateLimitMap.size >= RATE_LIMIT_MAX_KEYS) return false;
  }
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_PER_MINUTE) return false;
  entry.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) { if (now > v.resetAt) rateLimitMap.delete(k); }
}, 60_000);

// ── 静态文件服务
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"]
]);

// gzip 产物缓存（docs/20）：文件 rarely 变更，避免每请求同步压缩阻塞事件循环
const gzipCache = new Map<string, Buffer>();
async function staticFile(response: import("node:http").ServerResponse, pathname: string, request?: import("node:http").IncomingMessage): Promise<boolean> {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^[a-zA-Z0-9._/-]+$/.test(relativePath) || relativePath.includes("..")) return false;
  try {
    const filePath = resolve(webRoot, relativePath);
    const body = await readFile(filePath);
    const fileStat = await stat(filePath);
    const contentType = contentTypes.get(extname(relativePath)) ?? "application/octet-stream";
    const versioned = /[?&]v=/.test(request?.url ?? "");
    const headers: Record<string, string> = {
      "content-type": contentType,
      // index.html 始终回源；带 ?v= 的前端资源可长缓存，发版时只改版本号。
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "no-cache",
    };
    const acceptEncoding = request?.headers["accept-encoding"] ?? "";
    const acceptsBrotli = /\bbr\b/.test(acceptEncoding);
    const acceptsGzip = acceptEncoding.includes("gzip");
    const textLike = contentType.startsWith("text/") || contentType === "application/javascript";
    // 统一安全响应头（HTML/JS/CSS 与 API json() 一致）
    Object.assign(headers, securityHeaders());
    if ((acceptsBrotli || acceptsGzip) && textLike && body.length > 1024) {
      // 缓存键必须带文件 mtime/size：否则发版后浏览器拿到的仍是旧压缩内容。
      const encoding = acceptsBrotli ? "br" : "gzip";
      const cacheKey = `${relativePath}:${fileStat.mtimeMs}:${fileStat.size}:${encoding}`;
      let compressed = gzipCache.get(cacheKey);
      if (!compressed || compressed.length === 0) {
        const zlib = await import("node:zlib");
        compressed = encoding === "br"
          ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
          : zlib.gzipSync(body);
        if (gzipCache.size > 80) gzipCache.clear();
        gzipCache.set(cacheKey, compressed);
      }
      headers["content-encoding"] = encoding;
      headers["vary"] = "accept-encoding";
      response.writeHead(200, headers);
      response.end(compressed);
    } else {
      response.writeHead(200, headers);
      response.end(body);
    }
    return true;
  } catch {
    return false;
  }
}

// ── 主服务器
const server = createServer(async (request, response) => {
  const requestStartedAt = Date.now();
  response.on("finish", () => recordRequest(request.method ?? "GET", response.statusCode, Date.now() - requestStartedAt));
  const ip = clientIp(request);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const traceId = request.headers["x-trace-id"]?.toString() ?? crypto.randomUUID();

  response.setHeader("x-trace-id", traceId);
  for (const [k, v] of Object.entries(securityHeaders())) response.setHeader(k, v);

  // CORS：生产只回显白名单；开发环境允许 localhost 工具，但不反射任意站点。
  const origin = request.headers.origin ?? "";
  const allowedOrigins = config.corsOrigins;
  const devOrigins = ["http://localhost:3000", "http://127.0.0.1:3000", `http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const originAllowed = origin && (allowedOrigins.includes(origin) || (!config.isProduction && devOrigins.includes(origin)));
  if (originAllowed) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type,authorization,x-trace-id");
    response.setHeader("vary", "origin");
  }

  if (request.method === "OPTIONS") {
    if (origin && !originAllowed) { response.writeHead(403); return response.end(); }
    response.writeHead(204); return response.end();
  }

  // 速率限制
  if (!checkRateLimit(ip)) {
    return json(response, 429, { error: "rate_limit_exceeded", traceId });
  }

  // CSRF：所有 /v1 写请求（Webhook 由自身验签）必须同源 + JSON/multipart。
  try {
    if (isMutation(request.method ?? "GET") && url.pathname.startsWith("/v1/") && url.pathname !== "/v1/feishu/webhook") {
      assertTrustedOrigin(request);
      assertMutationMediaType(request);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "bad_request";
    return json(response, message === "csrf_origin_mismatch" ? 403 : 415, { error: message, traceId });
  }

  // 服务端会话校验：被撤销/过期/旧版无 sid 的 Cookie 一律 401。
  const sessionForCheck = readSession(request.headers.cookie);
  if (sessionForCheck && !(await isSessionActive(sessionForCheck))) {
    return json(response, 401, { error: "authentication_required", traceId }, { "set-cookie": expiredSessionCookie() });
  }

  try {
    // ── 飞书 Webhook（需要在 body 解析前处理原始流）
    if (url.pathname === "/v1/feishu/webhook" || url.pathname === "/v1/webhook/feishu") {
      return await handleFeishuWebhook(request, response);
    }

    // ── 平台核心端点
    if (request.method === "GET" && url.pathname === "/health") {
      const database = await databaseHealth();
      const ok = database === "connected" || database === "not_configured";
      return json(response, ok ? 200 : 503, {
        status: ok ? "ok" : "degraded", service: "feishu-hq-api", version: "1.2.1",
        database, timestamp: new Date().toISOString()
      });
    }

    if (request.method === "GET" && url.pathname === "/ready") {
      const database = await databaseHealth();
      return json(response, database === "connected" ? 200 : 503, { ready: database === "connected", database });
    }

    if (request.method === "GET" && url.pathname === "/metrics") {
      const database = await databaseHealth();
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
      return response.end(renderMetrics(database));
    }

    if (request.method === "GET" && url.pathname === "/v1/auth/status") {
      return json(response, 200, { demoMode: config.demoMode, feishu: feishuStatus() });
    }

    // 演示相关端点：未启用 DEMO_MODE 时统一 404（生产默认关闭）。
    if (!config.demoMode && (url.pathname === "/v1/session/demo" || url.pathname.startsWith("/v1/demo/"))) {
      return json(response, 404, { error: "not_found", traceId });
    }

    if (request.method === "POST" && url.pathname === "/v1/session/demo") {
      // 一键换公司：body.company ∈ standard|mfg|sw（缺省 standard=体验企业）
      const body = await readBody(request) as { company?: string; person?: string };
      const company = resolveDemoCompany(body?.company);
      if (!company) return json(response, 400, { error: "unknown_demo_company", traceId });
      // 岗位登录（docs/17）：body.person=岗位对应 personId；缺省=该公司管理员
      const persona = resolveDemoPersona(company, body?.person);
      const { token, record } = createSessionRecord({
        tenantId: company.tenantId, personId: persona.personId,
        role: persona.isAdmin ? "tenant_admin" : "employee", mode: "demo",
      });
      await registerSession(record, request);
      const newSession = readSession(sessionCookie(token));
      const workspace = newSession ? await getWorkspace(newSession) : null;
      return json(response, 201, {
        authenticated: true, mode: "demo", company: company.key, company_name: company.name,
        persona: { personId: persona.personId, name: persona.name, title: persona.title },
        workspace,
      }, { "set-cookie": sessionCookie(token) });
    }

    if (request.method === "GET" && url.pathname === "/v1/demo/companies") {
      return json(response, 200, { items: listDemoCompanies() });
    }

    if (request.method === "GET" && url.pathname === "/v1/demo/personas") {
      const companyKey = url.searchParams.get("company") ?? "standard";
      const company = resolveDemoCompany(companyKey);
      if (!company || !DEMO_PERSONAS[company.key]) return json(response, 400, { error: "unknown_demo_company", traceId });
      return json(response, 200, { company: company.key, company_name: company.name, items: listDemoPersonas(company.key) });
    }

    if (request.method === "DELETE" && url.pathname === "/v1/session") {
      const current = readSession(request.headers.cookie);
      if (current) await revokeSession(current);
      return json(response, 200, { authenticated: false }, { "set-cookie": expiredSessionCookie() });
    }

    if (request.method === "POST" && url.pathname === "/v1/session/logout-all") {
      const current = readSession(request.headers.cookie);
      if (!current) return json(response, 401, { error: "authentication_required", traceId });
      const revoked = await revokeAllSessions(current.tenantId, current.personId);
      return json(response, 200, { ok: true, revoked }, { "set-cookie": expiredSessionCookie() });
    }

    if (request.method === "GET" && url.pathname === "/v1/session") {
      const identity = readSession(request.headers.cookie);
      if (!identity) return json(response, 401, { authenticated: false });
      const workspace = await getWorkspace(identity);
      // 一次返回完整工作区，避免首屏 session + workspace 两次往返。
      return json(response, 200, { authenticated: true, mode: identity.mode, session_id: identity.sid, user: workspace.user, tenant: workspace.tenant, workspace });
    }

    if (request.method === "GET" && url.pathname === "/v1/workspace") {
      const identity = readSession(request.headers.cookie);
      if (!identity) return json(response, 401, { error: "authentication_required", traceId });
      return json(response, 200, await getWorkspace(identity));
    }

    if (request.method === "GET" && url.pathname === "/v1/demo/workspace") {
      const identity = readSession(request.headers.cookie);
      if (!identity) return json(response, 401, { error: "authentication_required", traceId });
      return json(response, 200, await getDemoWorkspace(identity));
    }

    if (request.method === "POST" && url.pathname === "/v1/demo/workflows/sales-to-delivery") {
      const identity = readSession(request.headers.cookie);
      if (!identity) return json(response, 401, { error: "authentication_required", traceId });
      return json(response, 201, await createDemoFlow(identity, await readBody(request), traceId));
    }

    if (request.method === "POST" && url.pathname === "/v1/demo/reset") {
      const identity = readSession(request.headers.cookie);
      if (!identity) return json(response, 401, { error: "authentication_required", traceId });
      return json(response, 200, await resetDemoWorkspace(identity, traceId));
    }

    if (request.method === "GET" && url.pathname === "/v1/feishu/login") {
      const authorization = createAuthorizeRequest();
      response.writeHead(302, {
        location: authorization.url,
        "set-cookie": oauthStateCookie(createOAuthState(authorization.state, authorization.verifier)),
        "cache-control": "no-store"
      });
      return response.end();
    }

    if (request.method === "GET" && url.pathname === "/v1/feishu/callback") {
      const oauthState = readOAuthState(request.headers.cookie);
      if (url.searchParams.get("error")) throw new Error("feishu_authorization_denied");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!oauthState || !code || !state || state !== oauthState.state) throw new Error("invalid_oauth_state");
      const accessToken = await exchangeOAuthCode(code, oauthState.verifier);
      const user = await getFeishuUser(accessToken);
      const identity = await upsertFeishuLogin(user, feishuStatus().allowFirstAdmin);
      const { token, record } = createSessionRecord({ ...identity, mode: "feishu" });
      await registerSession(record, request);
      response.writeHead(302, {
        location: "/?oauth=connected#settings",
        "set-cookie": [sessionCookie(token), expiredOAuthStateCookie()],
        "cache-control": "no-store"
      });
      return response.end();
    }

    if (request.method === "POST" && url.pathname === "/v1/integrations/feishu/sync") {
      const identity = readSession(request.headers.cookie);
      if (!identity) return json(response, 401, { error: "authentication_required", traceId });
      try {
        await withTenant(identity, (db) => assertCapability(db, identity, "integrations.manage"));
      } catch {
        return json(response, 403, { error: "administrator_required", traceId });
      }
      if (!feishuStatus().configured) return json(response, 503, { error: "feishu_oauth_not_configured", traceId });
      const externalTenantKey = await getFeishuTenantKey(identity);
      if (!externalTenantKey) return json(response, 409, { error: "feishu_identity_not_linked", traceId });
      const organization = await fetchFeishuOrganization();
      return json(response, 200, { status: "completed", ...(await syncFeishuOrganization(identity, externalTenantKey, organization, traceId)) });
    }

    if (request.method === "GET" && url.pathname === "/v1/platform/capabilities") {
      return json(response, 200, {
        architecture: "modular-monolith",
        modules: ["platform", "strategy", "project", "crm", "hr", "it", "finance", "knowledge", "manufacturing", "supply-chain", "quality", "equipment", "sales"],
        sharedCapabilities: ["identity", "authorization", "audit", "workflow", "events", "agent-tools", "ai"],
        version: "1.2.1",
        aiEnabled: Boolean(process.env.MODEL_API_KEY),
        feishuEnabled: Boolean(process.env.FEISHU_APP_ID)
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/authz/explain") {
      if (!readSession(request.headers.cookie)) return json(response, 401, { error: "authentication_required", traceId });
      const body = await readBody(request) as AuthorizationRequest;
      if (!body?.subject || !body?.resource || !body?.action || !body?.context) {
        return json(response, 400, { error: "invalid_authorization_request", traceId });
      }
      body.context.traceId = body.context.traceId || traceId;
      return json(response, 200, authorize(body, baselinePolicies));
    }

    // ── 组织与用户端点
    if (request.method === "GET" && url.pathname === "/v1/people") {
      const identity = readSession(request.headers.cookie);
      if (!identity) return json(response, 401, { error: "authentication_required", traceId });
      const { withTenant } = await import("./db.ts");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const search = url.searchParams.get("search");
      const rows = await withTenant(identity, async (db) => {
        const { rows } = await db.query(
          `SELECT p.id, p.display_name, p.primary_email, p.avatar_url,
                  ei.external_subject AS feishu_open_id,
                  e.employee_number, ou.name AS org_unit_name, pos.name AS position_name
           FROM platform.people p
           LEFT JOIN platform.external_identities ei ON ei.tenant_id = p.tenant_id AND ei.person_id = p.id AND ei.provider = 'feishu'
           LEFT JOIN platform.employments e ON e.tenant_id = p.tenant_id AND e.person_id = p.id AND e.status = 'active' AND e.deleted_at IS NULL
           LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
           LEFT JOIN platform.positions pos ON pos.tenant_id = e.tenant_id AND pos.id = e.position_id
           WHERE p.tenant_id = platform.current_tenant_id() AND p.status = 'active' AND p.deleted_at IS NULL
             AND ($1::text IS NULL OR p.display_name ILIKE '%' || $1 || '%' OR p.primary_email ILIKE '%' || $1 || '%')
           ORDER BY p.display_name LIMIT $2`,
          [search ?? null, limit]
        );
        return rows;
      });
      return json(response, 200, { items: rows });
    }

    if (request.method === "GET" && url.pathname === "/v1/org-units") {
      const identity = readSession(request.headers.cookie);
      if (!identity) return json(response, 401, { error: "authentication_required", traceId });
      const { withTenant } = await import("./db.ts");
      const rows = await withTenant(identity, async (db) => {
        const { rows } = await db.query(
          `SELECT ou.id, ou.code, ou.name, ou.type, ou.parent_id, ou.status,
                  pe.display_name AS manager_name,
                  (SELECT count(*) FROM platform.employments e WHERE e.org_unit_id = ou.id AND e.status = 'active') AS member_count
           FROM platform.org_units ou
           LEFT JOIN platform.people pe ON pe.tenant_id = ou.tenant_id AND pe.id = ou.manager_person_id
           WHERE ou.tenant_id = platform.current_tenant_id() AND ou.status = 'active' AND ou.deleted_at IS NULL
           ORDER BY ou.type, ou.name`
        );
        return rows;
      });
      return json(response, 200, { items: rows });
    }

    // ── 读取请求体（模块路由需要）
    const body = await readBody(request);
    (request as unknown as { body: unknown }).body = body;

    // ── 统一能力校验（在业务 handler 之前；缺省写操作拒绝）
    const method = request.method ?? "GET";
    const policyIdentity = readSession(request.headers.cookie);
    if (policyIdentity) {
      await enforcePolicy(policyIdentity, method, url.pathname);
    }

    // ── 动态路由分发（所有模块路由）
    const matched = dispatch(method, url.pathname);
    if (matched) {
      const ctx = { traceId, url, params: matched.params };
      const augmented = Object.assign(request, { params: matched.params, body });
      return await matched.handler(augmented as Parameters<typeof matched.handler>[0], response, ctx);
    }

    // ── 静态文件
    if (request.method === "GET" && await staticFile(response, url.pathname, request)) return;

    return json(response, 404, { error: "not_found", traceId });

  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    // 可安全回传给客户端的业务错误；其余一律 500 + 通用文案，避免泄露 SQL/堆栈。
    const CLIENT_ERRORS = new Set([
      "request_too_large", "unsupported_media_type", "csrf_origin_mismatch",
      "authentication_required", "permission_denied", "self_approval_forbidden",
      "tenant_bootstrap_disabled", "demo_session_required", "not_found",
      "invalid_request", "invalid_body", "validation_failed", "no_fields_to_update",
      "unknown_demo_company", "feishu_identity_not_linked", "feishu_oauth_not_configured",
      "database_not_configured", "approval_flow_unavailable", "insufficient_stock",
      "already_processed", "conflict",
    ]);
    const known = CLIENT_ERRORS.has(message) || message.startsWith("invalid_") || message.endsWith("_required");
    const status = message === "request_too_large" ? 413
      : message === "unsupported_media_type" ? 415
      : message === "csrf_origin_mismatch" ? 403
      : message === "feishu_oauth_not_configured" || message === "database_not_configured" ? 503
      : message === "tenant_bootstrap_disabled" || message === "demo_session_required" ? 403
      : message === "authentication_required" ? 401
      : message === "permission_denied" || message === "self_approval_forbidden" ? 403
      : message === "not_found" ? 404
      : message === "conflict" || message === "already_processed" ? 409
      : error instanceof Error && error.name === "FeishuApiError" ? 502
      : known ? 400 : 500;

    console.error(JSON.stringify({
      service: "feishu-hq-api", level: status >= 500 ? "error" : "warn", traceId,
      message: status >= 500 ? message : message, ts: new Date().toISOString(),
    }));
    return json(response, status, {
      error: status >= 500 ? "internal_error" : message,
      traceId,
    });
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    service: "feishu-hq-api", status: "listening",
    url: `http://${host}:${port}`,
    modules: ["platform","strategy","project","crm","hr","it","finance","knowledge","manufacturing","supply-chain","quality","equipment","sales","ai"],
    feishu: Boolean(process.env.FEISHU_APP_ID),
    ai: Boolean(process.env.MODEL_API_KEY),
    database: Boolean(process.env.DATABASE_URL)
  }));
});

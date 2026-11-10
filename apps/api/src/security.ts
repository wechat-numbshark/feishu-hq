import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.ts";

// ──────────────────────────────────────────────────────────────
// HTTP 安全工具：客户端 IP、CSRF/Origin、媒体类型、安全响应头、飞书验签
// ──────────────────────────────────────────────────────────────

export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** HTTP 方法是否需要 CSRF 防护。 */
export function isMutation(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function allowedOrigins(): string[] {
  const origins = new Set<string>();
  for (const item of config.corsOrigins) {
    try { origins.add(new URL(item).origin); } catch { /* ignore malformed */ }
  }
  try { origins.add(new URL(config.appBaseUrl).origin); } catch { /* ignore */ }
  return [...origins];
}

/**
 * CSRF 防线 1：浏览器跨站写请求必须携带 Origin，且必须与站点同源。
 * 非浏览器客户端（curl/服务端）没有 Origin，放行但依赖 SameSite + 鉴权。
 */
export function assertTrustedOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin?.toString();
  if (!origin) return;
  if (!allowedOrigins().includes(origin)) {
    throw new Error("csrf_origin_mismatch");
  }
  const fetchSite = req.headers["sec-fetch-site"]?.toString();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    throw new Error("csrf_origin_mismatch");
  }
}

/**
 * CSRF 防线 2：写请求只要有 body，必须是 JSON 或 multipart。
 * 这样 text/plain 表单无法构造可被 JSON.parse 接受的内容。
 */
export function assertMutationMediaType(req: IncomingMessage): void {
  const length = Number(req.headers["content-length"] ?? 0);
  const hasBody = length > 0 || Boolean(req.headers["transfer-encoding"]);
  if (!hasBody) return;
  const type = (req.headers["content-type"] ?? "").toString().toLowerCase();
  if (type.startsWith("application/json") || type.startsWith("multipart/form-data")) return;
  throw new Error("unsupported_media_type");
}

/** 统一安全响应头（CSP 允许本站脚本；style 因现有内联样式多暂允许 inline）。 */
export function securityHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  };
}

// ── 飞书请求签名 ─────────────────────────────────────────────
// 飞书事件/卡片回调：X-Lark-Signature = sha256(timestamp + nonce + encryptKey + rawBody)
export function verifyFeishuSignature(
  req: IncomingMessage,
  rawBody: string,
  encryptKey: string
): boolean {
  const signature = req.headers["x-lark-signature"]?.toString();
  const timestamp = req.headers["x-lark-request-timestamp"]?.toString();
  const nonce = req.headers["x-lark-request-nonce"]?.toString();
  if (!signature || !timestamp || !nonce) return false;
  const expected = createHash("sha256")
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
    .digest("hex");
  const a = Buffer.from(signature.toLowerCase());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 校验 body 中的 verification token（未加密事件）。 */
export function verifyFeishuToken(body: Record<string, unknown>, expectedToken: string): boolean {
  if (!expectedToken) return false;
  const actual =
    (body.token as string | undefined) ??
    ((body.header as Record<string, unknown> | undefined)?.token as string | undefined);
  if (!actual) return false;
  const a = Buffer.from(String(actual));
  const b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

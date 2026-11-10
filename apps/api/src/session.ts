import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

export type SessionIdentity = {
  tenantId: string;
  personId: string;
  role: "tenant_admin" | "employee";
  mode: "demo" | "feishu";
  feishuOpenId?: string; // 飞书登录时写入真实 open_id；非飞书会话为空，下游回退 personId
  sid?: string;          // 服务端会话 id（platform.sessions.id），用于撤销
  issuedAt?: number;
  expiresAt: number;
};

const cookieName = config.cookieSecure ? "__Host-hq_session" : "hq_session";
const oauthCookieName = "hq_oauth";
const configuredSecret = process.env.SESSION_SECRET;
if (config.isProduction && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error("SESSION_SECRET must contain at least 32 characters in production");
}
const secret = configuredSecret || "local-development-session-secret-please-change";

function sign(value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

export function createSessionRecord(identity: Omit<SessionIdentity, "expiresAt" | "sid">): {
  token: string;
  record: { id: string; tenantId: string; personId: string; expiresAt: number };
} {
  const ttl = identity.mode === "demo" ? config.demoSessionTtlMs : config.sessionTtlMs;
  const sid = randomUUID();
  const expiresAt = Date.now() + ttl;
  const payload: SessionIdentity = { ...identity, sid, issuedAt: Date.now(), expiresAt };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `${encoded}.${sign(encoded)}`,
    record: { id: sid, tenantId: identity.tenantId, personId: identity.personId, expiresAt },
  };
}

export function createSession(identity: Omit<SessionIdentity, "expiresAt" | "sid">): string {
  return createSessionRecord(identity).token;
}

export function readSession(cookieHeader: string | undefined): SessionIdentity | null {
  const token = parseCookies(cookieHeader).get(cookieName);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const identity = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionIdentity;
    if (!identity.tenantId || !identity.personId || identity.expiresAt < Date.now()) return null;
    // demo 会话生产环境一律拒绝（即使旧 Cookie 被复用）
    if (!config.demoMode && identity.mode === "demo") return null;
    return identity;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`;
}

export function expiredSessionCookie(): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

type OAuthState = { state: string; verifier: string; expiresAt: number };

export function createOAuthState(state: string, verifier: string): string {
  const encoded = Buffer.from(JSON.stringify({ state, verifier, expiresAt: Date.now() + 10 * 60 * 1000 })).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function readOAuthState(cookieHeader: string | undefined): OAuthState | null {
  const token = parseCookies(cookieHeader).get(oauthCookieName);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    return state.state && state.verifier && state.expiresAt >= Date.now() ? state : null;
  } catch { return null; }
}

export function oauthStateCookie(token: string): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${oauthCookieName}=${token}; Path=/v1/feishu/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
}

export function expiredOAuthStateCookie(): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${oauthCookieName}=; Path=/v1/feishu/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export const demoIdentity = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  personId: "20000000-0000-4000-8000-000000000001",
  role: "tenant_admin" as const,
  mode: "demo" as const
};

import { createHash, randomBytes } from "node:crypto";

const authorizeEndpoint = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const oauthTokenEndpoint = "https://accounts.feishu.cn/oauth/v3/token";
const apiOrigin = "https://open.feishu.cn";
const requiredScopes = [
  "contact:contact.base:readonly",
  "contact:department.organize:readonly",
  "contact:department.base:readonly",
  "contact:user.base:readonly",
  "contact:user.department:readonly",
  "contact:user.employee:readonly"
];

function configuration() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const redirectUri = process.env.FEISHU_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) throw new Error("feishu_oauth_not_configured");
  return { appId, appSecret, redirectUri };
}

async function feishuFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (typeof body.code === "number" && body.code !== 0)) {
    const error = new Error(body.error_description || body.msg || `feishu_http_${response.status}`);
    error.name = "FeishuApiError";
    throw error;
  }
  return body;
}

export function feishuStatus() {
  return {
    configured: Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_REDIRECT_URI),
    redirectUri: process.env.FEISHU_REDIRECT_URI || null,
    requiredScopes,
    allowFirstAdmin: process.env.FEISHU_ALLOW_FIRST_ADMIN === "true"
  };
}

export function createAuthorizeRequest() {
  const { appId, redirectUri } = configuration();
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(authorizeEndpoint);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", requiredScopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state, verifier };
}

export async function exchangeOAuthCode(code: string, verifier: string) {
  const { appId, appSecret, redirectUri } = configuration();
  const token = await feishuFetch(oauthTokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: appId, client_secret: appSecret, code, redirect_uri: redirectUri, code_verifier: verifier })
  });
  if (!token.access_token) throw new Error("feishu_access_token_missing");
  return token.access_token as string;
}

export async function getFeishuUser(accessToken: string) {
  const response = await feishuFetch(`${apiOrigin}/open-apis/authen/v1/user_info`, { headers: { authorization: `Bearer ${accessToken}` } });
  const data = response.data ?? response;
  if (!data.open_id || !data.tenant_key || !data.name) throw new Error("feishu_user_identity_incomplete");
  return data;
}

let tenantTokenCache: { token: string; expiresAt: number } | null = null;
async function getTenantToken() {
  if (tenantTokenCache && tenantTokenCache.expiresAt > Date.now() + 60_000) return tenantTokenCache.token;
  const { appId, appSecret } = configuration();
  const result = await feishuFetch(`${apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  if (!result.tenant_access_token) throw new Error("feishu_tenant_token_missing");
  tenantTokenCache = { token: result.tenant_access_token, expiresAt: Date.now() + Number(result.expire || 7200) * 1000 };
  return tenantTokenCache.token;
}

async function collectPages(path: string, parameters: Record<string, string>) {
  const token = await getTenantToken();
  const items: any[] = [];
  let pageToken = "";
  for (let page = 0; page < 200; page += 1) {
    const url = new URL(`${apiOrigin}${path}`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    url.searchParams.set("page_size", "50");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await feishuFetch(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    items.push(...(response.data?.items ?? []));
    if (!response.data?.has_more) break;
    pageToken = response.data.page_token;
    if (!pageToken) break;
  }
  return items;
}

export async function fetchFeishuOrganization() {
  const departments = await collectPages("/open-apis/contact/v3/departments/0/children", { department_id_type: "open_department_id", user_id_type: "open_id", fetch_child: "true" });
  const departmentIds = ["0", ...departments.map(department => department.open_department_id).filter(Boolean)];
  const users = new Map<string, any>();
  for (const departmentId of departmentIds) {
    const members = await collectPages("/open-apis/contact/v3/users/find_by_department", { department_id: departmentId, department_id_type: "open_department_id", user_id_type: "open_id" });
    for (const member of members) if (member.open_id) users.set(member.open_id, member);
  }
  return { departments, users: [...users.values()] };
}

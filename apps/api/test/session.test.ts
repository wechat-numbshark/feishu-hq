import test from "node:test";
import assert from "node:assert/strict";
import {
  createOAuthState,
  createSession,
  demoIdentity,
  oauthStateCookie,
  readOAuthState,
  readSession,
  sessionCookie
} from "../src/session.ts";

test("体验会话可以验证且篡改后失效", () => {
  const token = createSession(demoIdentity);
  const cookie = sessionCookie(token);
  assert.equal(readSession(cookie)?.tenantId, demoIdentity.tenantId);
  const tampered = cookie.replace(/hq_session=([^;]+)/, (_match, value) => `hq_session=${value.slice(0, -1)}x`);
  assert.equal(readSession(tampered), null);
});

test("OAuth state cookie 保存 PKCE verifier 且篡改后失效", () => {
  const token = createOAuthState("state-value", "verifier-value");
  const cookie = oauthStateCookie(token);
  assert.deepEqual(readOAuthState(cookie)?.state, "state-value");
  const tampered = cookie.replace(/hq_oauth=([^;]+)/, (_match, value) => `hq_oauth=${value.slice(0, -1)}x`);
  assert.equal(readOAuthState(tampered), null);
});

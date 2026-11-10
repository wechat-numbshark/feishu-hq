import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorizeRequest, feishuStatus } from "../src/feishu.ts";

test("飞书授权链接包含 state、PKCE S256、回调与最小只读权限", () => {
  process.env.FEISHU_APP_ID = "cli_test";
  process.env.FEISHU_APP_SECRET = "secret_for_test_only";
  process.env.FEISHU_REDIRECT_URI = "https://example.test/v1/feishu/callback";
  const request = createAuthorizeRequest();
  const url = new URL(request.url);
  assert.equal(url.origin, "https://accounts.feishu.cn");
  assert.equal(url.searchParams.get("client_id"), "cli_test");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), process.env.FEISHU_REDIRECT_URI);
  assert.equal(url.searchParams.get("state"), request.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok((url.searchParams.get("code_challenge") ?? "").length >= 43);
  assert.match(url.searchParams.get("scope") ?? "", /contact:department\.base:readonly/);
  assert.equal(feishuStatus().configured, true);
});

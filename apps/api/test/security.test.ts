import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { assertMutationMediaType, assertTrustedOrigin, verifyFeishuSignature } from "../src/security.ts";
import { policyFor } from "../src/policy.ts";
import { hasCapability } from "../src/authz.ts";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("能力矩阵：管理员全量，主管可管项目，员工不可建项目", () => {
  assert.equal(hasCapability(["tenant_admin"], "settings.manage"), true);
  assert.equal(hasCapability(["manager"], "project.manage"), true);
  assert.equal(hasCapability(["manager"], "settings.manage"), false);
  assert.equal(hasCapability(["employee"], "project.manage"), false);
  assert.equal(hasCapability(["employee"], "project.write"), true);
  assert.equal(hasCapability(["finance_manager"], "purchase.approve"), true);
  assert.equal(hasCapability(["manager"], "purchase.approve"), false);
});

test("路由策略：高风险写操作必须声明能力，未知写操作默认拒绝", () => {
  assert.deepEqual(policyFor("POST", "/v1/projects"), ["project.manage"]);
  assert.deepEqual(policyFor("PATCH", "/v1/people/abc"), "authenticated");
  assert.deepEqual(policyFor("POST", "/v1/purchase/orders/abc/approve"), ["purchase.approve"]);
  assert.deepEqual(policyFor("POST", "/v1/finance/expenses"), "authenticated");
  assert.deepEqual(policyFor("PATCH", "/v1/finance/expenses/abc/approve"), ["finance.approve"]);
  assert.deepEqual(policyFor("POST", "/v1/session/demo"), "public");
  assert.equal(policyFor("POST", "/v1/unknown/write"), null);
  // 读接口默认放行
  assert.equal(policyFor("GET", "/v1/projects"), null);
});

test("CSRF：跨站 Origin 拒绝，同源放行，无 Origin 的非浏览器请求放行", () => {
  assert.doesNotThrow(() => assertTrustedOrigin(req({})));
  assert.doesNotThrow(() => assertTrustedOrigin(req({ origin: "http://localhost:3000" })));
  assert.throws(() => assertTrustedOrigin(req({ origin: "https://evil.example" })), /csrf_origin_mismatch/);
  assert.throws(
    () => assertTrustedOrigin(req({ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" })),
    /csrf_origin_mismatch/
  );
});

test("写请求媒体类型：JSON/multipart 放行，text/plain 拒绝，空 body 放行", () => {
  assert.doesNotThrow(() => assertMutationMediaType(req({})));
  assert.doesNotThrow(() => assertMutationMediaType(req({ "content-length": "2", "content-type": "application/json" })));
  assert.doesNotThrow(() => assertMutationMediaType(req({ "content-length": "2", "content-type": "multipart/form-data; boundary=x" })));
  assert.throws(
    () => assertMutationMediaType(req({ "content-length": "2", "content-type": "text/plain" })),
    /unsupported_media_type/
  );
});

test("飞书验签：正确签名通过，篡改 body 拒绝", () => {
  const body = JSON.stringify({ type: "event_callback" });
  const timestamp = "1700000000";
  const nonce = "abc123";
  const encryptKey = "test-encrypt-key";
  const signature = createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${body}`).digest("hex");
  const headers = {
    "x-lark-signature": signature,
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
  };
  assert.equal(verifyFeishuSignature(req(headers), body, encryptKey), true);
  assert.equal(verifyFeishuSignature(req(headers), body + "x", encryptKey), false);
  assert.equal(verifyFeishuSignature(req({}), body, encryptKey), false);
});

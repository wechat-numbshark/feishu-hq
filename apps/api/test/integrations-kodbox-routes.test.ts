import test from "node:test";
import assert from "node:assert/strict";
import type { Handler } from "../src/router.ts";

// Route-level Kodbox tests: real authorization + mock DB boundary.
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://localhost/kodbox_route_test";
const { pool } = await import("../src/db.ts");
await import("../src/modules/integrations.ts");
const { dispatch } = await import("../src/router.ts");
const { createSession } = await import("../src/session.ts");
if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = previousDatabaseUrl;

const tenantId = "10000000-0000-4000-8000-000000000001";
const personId = "20000000-0000-4000-8000-000000000001";

async function invokeRoute(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
  query?: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>,
  roles: string[] = [],
): Promise<{
  status: number;
  response: unknown;
  queries: Array<{ sql: string; values: unknown[] }>;
  error?: unknown;
}> {
  const matched = dispatch(method, path.split("?")[0]);
  assert.ok(matched, `route not found: ${method} ${path}`);
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const connectMock = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (/SELECT DISTINCT r\.code/.test(sql)) return { rows: roles.map((code) => ({ code })) };
      return query ? query(sql, values) : { rows: [] };
    },
    release: () => undefined,
  };
  const connect = test.mock.method(pool!, "connect", async () => connectMock);
  let status = 0;
  let response: unknown;
  let error: unknown;
  const req = {
    headers: { cookie: cookie ?? "" },
    body,
    params: matched.params,
  } as Parameters<Handler>[0];
  const res = {
    writeHead: (value: number) => { status = value; },
    end: (text: string) => { response = JSON.parse(text); },
  } as unknown as Parameters<Handler>[1];
  try {
    await matched.handler(req, res, {
      traceId: "kodbox-route-test",
      url: new URL(`http://localhost${path}`),
      params: matched.params,
    });
  } catch (err) {
    error = err;
  } finally {
    connect.mock.restore();
  }
  return { status, response, queries, error };
}

test("Kodbox GET /permission-rules requires authentication", async () => {
  const result = await invokeRoute("GET", "/v1/integrations/kodbox/permission-rules?instanceId=inst_1");
  assert.equal(result.status, 401);
});

test("Kodbox GET /permission-rules returns 200 for tenant_admin with mock rows", async () => {
  const cookie = `hq_session=${createSession({ tenantId, personId, role: "tenant_admin", mode: "feishu" })}`;
  const result = await invokeRoute("GET", "/v1/integrations/kodbox/permission-rules?instanceId=inst_1", undefined, cookie, async () => ({ rows: [{ id: "rule_1", permission: "read" }] }), ["tenant_admin"]);
  assert.equal(result.status, 200);
  assert.ok(Array.isArray((result.response as any).items));
  assert.equal(result.queries.filter(q => q.sql.includes("SELECT * FROM integrations.kodbox_permission_rules")).length, 1);
});

test("Kodbox GET /sync-runs requires authentication", async () => {
  const result = await invokeRoute("GET", "/v1/integrations/kodbox/sync-runs?instanceId=inst_1");
  assert.equal(result.status, 401);
});

test("Kodbox GET /permission-audit requires authentication", async () => {
  const result = await invokeRoute("GET", "/v1/integrations/kodbox/permission-audit?instanceId=inst_1");
  assert.equal(result.status, 401);
});

const adminCookie = `hq_session=${createSession({ tenantId, personId, role: "tenant_admin", mode: "feishu" })}`;
const employeeCookie = `hq_session=${createSession({ tenantId, personId: "20000000-0000-4000-8000-000000000002", role: "employee", mode: "feishu" })}`;

const kodboxRouteCases = [
  { name: "PATCH instance", method: "PATCH", path: "/v1/integrations/kodbox/instances/inst_1", body: { name: "renamed" }, expectedStatus: 200, forbiddenSql: "UPDATE integrations.kodbox_instances" },
  { name: "download file", method: "GET", path: "/v1/integrations/kodbox/files/download?instanceId=inst_1&path=%2Fdocs", expectedStatus: 200, forbiddenSql: "SELECT * FROM integrations.kodbox_instances" },
  { name: "share file", method: "POST", path: "/v1/integrations/kodbox/files/share", body: { instanceId: "inst_1", path: "/docs" }, expectedStatus: 200, forbiddenSql: "INSERT INTO integrations.kodbox_shares" },
  { name: "revoke share", method: "POST", path: "/v1/integrations/kodbox/files/revoke-share", body: { instanceId: "inst_1", shareId: "share_1" }, expectedStatus: 200, forbiddenSql: "UPDATE integrations.kodbox_shares" },
  { name: "list files", method: "GET", path: "/v1/integrations/kodbox/files/list?instanceId=inst_1&path=%2Fdocs", expectedStatus: 200, forbiddenSql: "SELECT * FROM integrations.kodbox_file_metadata" },
  { name: "list permission rules", method: "GET", path: "/v1/integrations/kodbox/permission-rules?instanceId=inst_1", expectedStatus: 200, forbiddenSql: "SELECT * FROM integrations.kodbox_permission_rules" },
  { name: "create permission rule", method: "POST", path: "/v1/integrations/kodbox/permission-rules", body: { instanceId: "inst_1", feishu_department_id: "dept_1", kodbox_path: "/docs", permission: "read" }, expectedStatus: 201, forbiddenSql: "INSERT INTO integrations.kodbox_permission_rules" },
  { name: "delete permission rule", method: "DELETE", path: "/v1/integrations/kodbox/permission-rules/rule_1", expectedStatus: 200, forbiddenSql: "DELETE FROM integrations.kodbox_permission_rules" },
  { name: "list sync runs", method: "GET", path: "/v1/integrations/kodbox/sync-runs?instanceId=inst_1", expectedStatus: 200, forbiddenSql: "SELECT * FROM integrations.kodbox_sync_runs" },
  { name: "list permission audit", method: "GET", path: "/v1/integrations/kodbox/permission-audit?instanceId=inst_1", expectedStatus: 200, forbiddenSql: "SELECT * FROM integrations.kodbox_permission_audit" },
] as const;

for (const routeCase of kodboxRouteCases) {
  test(`Kodbox ${routeCase.name} denies a non-admin before route work`, async () => {
    const result = await invokeRoute(
      routeCase.method,
      routeCase.path,
      routeCase.body,
      employeeCookie,
      async (sql) => sql.includes("SELECT DISTINCT r.code") ? { rows: [] } : { rows: [] },
    );

    assert.equal(result.status, 0);
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, "permission_denied");
    assert.ok(result.queries.some((q) => q.sql === "ROLLBACK"));
    assert.equal(result.queries.filter((q) => q.sql.includes(routeCase.forbiddenSql)).length, 0);
  });

  test(`Kodbox ${routeCase.name} runs for tenant_admin inside a tenant transaction`, async () => {
    const result = await invokeRoute(
      routeCase.method,
      routeCase.path,
      routeCase.body,
      adminCookie,
      async () => ({ rows: [{ id: "inst_1", base_url: "https://kodbox.test" }] }),
      ["tenant_admin"],
    );

    assert.equal(result.status, routeCase.expectedStatus, JSON.stringify(result.response));
    assert.equal(result.error, undefined);
    assert.ok(result.queries.some((q) => q.sql === "BEGIN"));
    assert.ok(result.queries.some((q) => q.sql === "COMMIT"));
    assert.ok(result.queries.some((q) => q.sql.includes(routeCase.forbiddenSql)));
  });
}


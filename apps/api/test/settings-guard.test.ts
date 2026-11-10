import test from "node:test";
import assert from "node:assert/strict";
import type { Handler } from "../src/router.ts";

// Only the database boundary is stubbed; dispatch, sessions, authorization and
// the settings route execute real application code. No network is contacted.
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://localhost/settings_route_test";
const { pool } = await import("../src/db.ts");
await import("../src/modules/settings.ts");
const { dispatch } = await import("../src/router.ts");
const { createSession } = await import("../src/session.ts");
if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = previousDatabaseUrl;

const tenantId = "10000000-0000-4000-8000-000000000001";
const personId = "20000000-0000-4000-8000-000000000001";

for (const scenario of [
  { name: "employee cannot change settings", role: "employee", roles: [], allowed: false },
  { name: "HR manager cannot change tenant settings", role: "employee", roles: ["hr_manager"], allowed: false },
  { name: "session administrator without DB binding cannot save settings", role: "tenant_admin", roles: [], allowed: false },
  { name: "database-assigned administrator can save settings", role: "employee", roles: ["tenant_admin"], allowed: true },
  { name: "anonymous request cannot change settings", role: null, roles: [], allowed: false },
] as const) {
  test(scenario.name, async (t) => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    let released = false;
    assert.ok(pool);
    t.mock.method(pool, "connect", async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        return { rows: sql.includes("SELECT DISTINCT r.code") ? scenario.roles.map(code => ({ code })) : [] };
      },
      release: () => { released = true; },
    }));
    const matched = dispatch("PATCH", "/v1/settings/finance");
    assert.ok(matched);
    let status = 0;
    let response: unknown;
    const req = {
      headers: scenario.role ? { cookie: `hq_session=${createSession({ tenantId, personId, role: scenario.role, mode: "feishu" })}` } : {},
      body: { approval_threshold_cents: 250000 },
      params: matched.params,
    } as Parameters<Handler>[0];
    const res = {
      writeHead: (value: number) => { status = value; },
      end: (body: string) => { response = JSON.parse(body); },
    } as unknown as Parameters<Handler>[1];
    const run = () => matched.handler(req, res, {
      traceId: "settings-test", url: new URL("http://localhost/v1/settings/finance"), params: matched.params,
    });
    if (!scenario.allowed && scenario.role) {
      // main.ts maps this error to HTTP 403.
      await assert.rejects(run, { message: "permission_denied" });
      assert.ok(queries.some(q => q.sql === "ROLLBACK"));
    } else {
      await run();
      assert.equal(status, scenario.allowed ? 200 : 401);
    }
    const writes = queries.filter(q => q.sql.includes("INSERT INTO platform.tenant_settings"));
    assert.equal(writes.length, scenario.allowed ? 1 : 0);
    if (scenario.allowed) {
      assert.deepEqual(writes[0].values, ["finance", "approval_threshold_cents", "250000"]);
      assert.deepEqual(response, { ok: true, namespace: "finance" });
      assert.ok(queries.some(q => q.sql === "COMMIT"));
    }
    assert.equal(released, scenario.role !== null);
    if (!scenario.role) assert.equal(queries.length, 0);
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import type { Handler } from "../src/router.ts";

// Route-level tests: the database boundary is stubbed, while settings and
// finance route handlers execute real application code. No network or database
// connection is used.
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://localhost/settings_finance_route_test";
const { pool } = await import("../src/db.ts");
await import("../src/modules/settings.ts");
await import("../src/modules/finance.ts");
const { dispatch } = await import("../src/router.ts");
const { createSession } = await import("../src/session.ts");
if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = previousDatabaseUrl;

const tenantId = "10000000-0000-4000-8000-000000000001";
const personId = "20000000-0000-4000-8000-000000000001";
const cookie = `hq_session=${createSession({ tenantId, personId, role: "tenant_admin", mode: "feishu" })}`;

type Query = { sql: string; values: unknown[] };

async function invokeRoute(
  method: string,
  path: string,
  body: unknown,
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>,
): Promise<{ status: number; response: unknown; queries: Query[] }> {
  const matched = dispatch(method, path);
  assert.ok(matched, `route not found: ${method} ${path}`);
  const queries: Query[] = [];
  const connectMock = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return query(sql, values);
    },
    release: () => undefined,
  };
  const connect = test.mock.method(pool!, "connect", async () => connectMock);
  let status = 0;
  let response: unknown;
  const req = {
    headers: { cookie },
    body,
    params: matched.params,
  } as Parameters<Handler>[0];
  const res = {
    writeHead: (value: number) => { status = value; },
    end: (text: string) => { response = JSON.parse(text); },
  } as unknown as Parameters<Handler>[1];
  try {
    await matched.handler(req, res, {
      traceId: "settings-finance-test",
      url: new URL(`http://localhost${path}`),
      params: matched.params,
    });
  } finally {
    connect.mock.restore();
  }
  return { status, response, queries };
}

const settingsRows = [
  { key: "approval_threshold_cents", value: 250000 },
  { key: "expense_deadline_day", value: 25 },
];

test("GET settings returns the registry schema and stored values", async () => {
  const result = await invokeRoute("GET", "/v1/settings/finance", undefined, async (sql) => {
    if (sql.includes("SELECT key, value")) return { rows: settingsRows };
    return { rows: [] };
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.response, {
    namespace: "finance",
    schema: {
      approval_threshold_cents: {
        type: "integer",
        key: "approval_threshold_cents",
        defaultValue: 500000,
        min: 0,
        unit: "cents",
        description: "报销单审批阈值（分），超过此金额需要额外审批",
        consumer: "finance.expense.approval",
        effective: "immediate",
      },
      expense_deadline_day: {
        type: "integer",
        key: "expense_deadline_day",
        defaultValue: 25,
        min: 1,
        max: 28,
        unit: "day",
        description: "报销提交截止日（每月几号）",
        consumer: "finance.expense.submission",
        effective: "immediate",
      },
      invoice_expiry_warn_days: {
        type: "integer",
        key: "invoice_expiry_warn_days",
        defaultValue: 7,
        min: 1,
        unit: "days",
        description: "发票到期提醒提前天数",
        consumer: "finance.invoice.expiry",
        effective: "immediate",
      },
    },
    settings: {
      approval_threshold_cents: 250000,
      expense_deadline_day: 25,
    },
  });
});

test("PATCH settings rejects unknown keys without writing", async () => {
  const result = await invokeRoute("PATCH", "/v1/settings/finance", {
    approval_threshold_cents: 300000,
    unknown_key: true,
  }, async () => ({ rows: [] }));

  assert.equal(result.status, 400);
  assert.equal((result.response as { error?: string }).error, "invalid_settings");
  assert.equal(result.queries.filter(q => q.sql.includes("INSERT INTO platform.tenant_settings")).length, 0);
});

test("PATCH settings rejects values that violate the registry schema", async () => {
  const result = await invokeRoute("PATCH", "/v1/settings/finance", {
    approval_threshold_cents: "300000",
  }, async () => ({ rows: [] }));

  assert.equal(result.status, 400);
  assert.equal((result.response as { error?: string }).error, "invalid_setting_value");
  assert.equal(result.queries.filter(q => q.sql.includes("INSERT INTO platform.tenant_settings")).length, 0);
});

async function createExpense(amountCents: number, storedThreshold: number | undefined) {
  return invokeRoute("POST", "/v1/finance/expenses", {
    category: "差旅",
    amount_cents: amountCents,
    expense_date: "2026-09-18",
  }, async (sql) => {
    if (sql.includes("INSERT INTO finance.expenses")) {
      return { rows: [{ id: "expense-1", amount_cents: amountCents, status: "submitted" }] };
    }
    if (sql.includes("SELECT manager_person_id")) return { rows: [] };
    if (sql.includes("SELECT value FROM platform.tenant_settings")) {
      return { rows: storedThreshold === undefined ? [] : [{ value: storedThreshold }] };
    }
    if (sql.includes("SELECT id, steps") && sql.includes("approval_flows")) {
      return { rows: [{ id: "flow-expense", steps: [{ order: 1, type: "manager", label: "直属上级" }] }] };
    }
    return { rows: [] };
  });
}

test("finance creates an approval instance only when amount is above the threshold", async () => {
  const result = await createExpense(500001, 500000);

  assert.equal(result.status, 201);
  assert.ok(result.queries.some(q => q.sql.includes("INSERT INTO platform.approval_instances")));
});

test("finance does not create an approval instance at the threshold", async () => {
  const result = await createExpense(500000, 500000);

  assert.equal(result.status, 201);
  assert.equal(result.queries.filter(q => q.sql.includes("INSERT INTO platform.approval_instances")).length, 0);
});

test("finance uses the registry default when the threshold setting is absent", async () => {
  const result = await createExpense(500001, undefined);

  assert.equal(result.status, 201);
  assert.ok(result.queries.some(q => q.sql.includes("INSERT INTO platform.approval_instances")));
});

test("finance fails closed when the required approval flow is unavailable", async () => {
  await assert.rejects(
    invokeRoute("POST", "/v1/finance/expenses", {
      category: "travel",
      amount_cents: 500001,
      expense_date: "2026-09-18",
    }, async (sql) => {
      if (sql.includes("INSERT INTO finance.expenses")) {
        return { rows: [{ id: "expense-1", amount_cents: 500001, status: "submitted" }] };
      }
      if (sql.includes("SELECT manager_person_id")) return { rows: [] };
      if (sql.includes("SELECT value FROM platform.tenant_settings")) {
        return { rows: [{ value: 500000 }] };
      }
      if (sql.includes("SELECT id, steps") && sql.includes("approval_flows")) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
    /approval_flow_unavailable/,
  );
});

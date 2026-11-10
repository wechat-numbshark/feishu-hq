import pg from "pg";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createSession } from "../apps/api/src/session.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

// Load DATABASE_URL from .env.example (credentials redacted in logs)
const fs = await import("node:fs/promises");
const envPath = resolve(projectRoot, ".env.example");
const envContent = await fs.readFile(envPath, "utf8");
const envLines = envContent.split("\n");
let databaseUrl = "";
for (const line of envLines) {
  if (line.startsWith("DATABASE_URL=")) {
    databaseUrl = line.slice("DATABASE_URL=".length).trim();
    break;
  }
}
if (!databaseUrl) throw new Error("DATABASE_URL not found in .env.example");
// Replace DB name with integration DB
databaseUrl = databaseUrl.replace(/\/[^/?]+(\?|$)/, "/feishu_hq_integration$1");

// Set env BEFORE importing modules that read it
process.env.DATABASE_URL = databaseUrl;

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

// Import modules that register routes
await import("../apps/api/src/modules/settings.ts");
await import("../apps/api/src/modules/finance.ts");
await import("../apps/api/src/modules/approvals.ts");
const { dispatch } = await import("../apps/api/src/router.ts");

// Helper to invoke route with real DB
async function invoke(method, path, body, cookie) {
  const matched = dispatch(method, path);
  if (!matched) throw new Error(`Route not found: ${method} ${path}`);
  let status = 0;
  let responseBody = null;
  const req = {
    headers: { cookie },
    body,
    params: matched.params,
  };
  const res = {
    writeHead: (s) => { status = s; },
    end: (text) => { responseBody = JSON.parse(text); },
  };
  await matched.handler(req, res, { traceId: "integ-test", url: new URL(`http://localhost${path}`), params: matched.params });
  return { status, body: responseBody };
}

const tenantId = "10000000-0000-4000-8000-000000000001";
const personId = "20000000-0000-4000-8000-000000000001";
const cookie = `hq_session=${createSession({ tenantId, personId, role: "tenant_admin", mode: "feishu" })}`;

console.log("=== Test 1: GET settings/finance ===");
let r = await invoke("GET", "/v1/settings/finance", undefined, cookie);
console.log("Status:", r.status);
console.log("Body:", JSON.stringify(r.body, null, 2));
if (r.status !== 200) throw new Error("GET settings failed");

console.log("\n=== Test 2: PATCH settings/finance (valid) ===");
r = await invoke("PATCH", "/v1/settings/finance", { approval_threshold_cents: 500000 }, cookie);
console.log("Status:", r.status);
console.log("Body:", JSON.stringify(r.body, null, 2));
if (r.status !== 200) throw new Error("PATCH settings valid failed");

console.log("\n=== Test 3: PATCH settings/finance (invalid key) ===");
r = await invoke("PATCH", "/v1/settings/finance", { approval_threshold_cents: 500000, unknown_key: true }, cookie);
console.log("Status:", r.status);
console.log("Body:", JSON.stringify(r.body, null, 2));
if (r.status !== 400) throw new Error("PATCH settings invalid key should 400");

console.log("\n=== Test 4: PATCH settings/finance (invalid value type) ===");
r = await invoke("PATCH", "/v1/settings/finance", { approval_threshold_cents: "500000" }, cookie);
console.log("Status:", r.status);
console.log("Body:", JSON.stringify(r.body, null, 2));
if (r.status !== 400) throw new Error("PATCH settings invalid value should 400");

console.log("\n=== Test 5: POST finance/expenses at threshold (no approval) ===");
r = await invoke("POST", "/v1/finance/expenses", { category: "travel", amount_cents: 500000, expense_date: "2026-09-18", description: "threshold-integ" }, cookie);
console.log("Status:", r.status);
console.log("Body:", JSON.stringify(r.body, null, 2));
if (r.status !== 201) throw new Error("Expense at threshold failed");
const expenseAtThreshold = r.body;
if (expenseAtThreshold.status !== "submitted") throw new Error("Expense status should be submitted");

// Verify no approval instance created at the exact threshold.
const checkAtThreshold = await pool.query(`SELECT id FROM platform.approval_instances WHERE resource_type = 'expense' AND resource_id = $1`, [expenseAtThreshold.id]);
if (checkAtThreshold.rowCount !== 0) throw new Error("Approval instance should not exist at the threshold");

console.log("\n=== Test 6: POST finance/expenses above threshold (approval created) ===");
r = await invoke("POST", "/v1/finance/expenses", { category: "travel", amount_cents: 500001, expense_date: "2026-09-18", description: "approval-integ" }, cookie);
console.log("Status:", r.status);
console.log("Body:", JSON.stringify(r.body, null, 2));
if (r.status !== 201) throw new Error("Expense above threshold failed");
const expenseAbove = r.body;

// Read back the expense and its approval instance/action from PostgreSQL.
const readExpense = await pool.query(
  `SELECT id, tenant_id, amount_cents, status FROM finance.expenses WHERE id = $1`,
  [expenseAbove.id]
);
if (readExpense.rowCount !== 1 || readExpense.rows[0].amount_cents !== "500001") {
  throw new Error("Expense readback failed");
}
const checkAbove = await pool.query(
  `SELECT id, flow_id, resource_type, resource_id, status
   FROM platform.approval_instances
   WHERE resource_type = 'expense' AND resource_id = $1`,
  [expenseAbove.id]
);
if (checkAbove.rowCount !== 1) throw new Error("Approval instance should exist for amount above threshold");
const approvalInstance = checkAbove.rows[0];
const checkAction = await pool.query(
  `SELECT id, instance_id, step_order, status
   FROM platform.approval_actions
   WHERE instance_id = $1`,
  [approvalInstance.id]
);
if (checkAction.rowCount !== 1) throw new Error("Approval action should exist for the created instance");
console.log("Approval readback:", { expense: readExpense.rows[0], instance: approvalInstance, action: checkAction.rows[0] });

console.log("\n=== Test 7: Fail-closed - simulate approval failure by removing flow ===");
const failureDescription = "approval-failure-integ";
const failureAmount = 500002;
const beforeExpenseCount = (await pool.query(
  `SELECT count(*)::int AS count FROM finance.expenses WHERE description = $1`,
  [failureDescription]
)).rows[0].count;
const beforeInstanceCount = (await pool.query(
  `SELECT count(*)::int AS count FROM platform.approval_instances WHERE summary->>'description' = $1`,
  [failureDescription]
)).rows[0].count;
const beforeOutboxCount = (await pool.query(
  `SELECT count(*)::int AS count FROM platform.outbox_events
   WHERE aggregate_type = 'expense' AND payload->>'description' = $1`,
  [failureDescription]
)).rows[0].count;

await pool.query(`UPDATE platform.approval_flows SET is_active = false WHERE tenant_id = $1 AND code = 'expense'`, [tenantId]);
let failureError;
try {
  try {
    r = await invoke("POST", "/v1/finance/expenses", {
      category: "travel", amount_cents: failureAmount, expense_date: "2026-09-18", description: failureDescription
    }, cookie);
    throw new Error(`Expense creation unexpectedly succeeded with status ${r.status}`);
  } catch (e) {
    failureError = e;
    console.log("Expected error:", e.message);
    if (!String(e.message).includes("approval_flow_unavailable")) {
      throw new Error(`Unexpected approval failure: ${e.message}`);
    }
  }
} finally {
  await pool.query(`UPDATE platform.approval_flows SET is_active = true WHERE tenant_id = $1 AND code = 'expense'`, [tenantId]);
}

const afterExpenseCount = (await pool.query(
  `SELECT count(*)::int AS count FROM finance.expenses WHERE description = $1`,
  [failureDescription]
)).rows[0].count;
const afterInstanceCount = (await pool.query(
  `SELECT count(*)::int AS count FROM platform.approval_instances WHERE summary->>'description' = $1`,
  [failureDescription]
)).rows[0].count;
const afterOutboxCount = (await pool.query(
  `SELECT count(*)::int AS count FROM platform.outbox_events
   WHERE aggregate_type = 'expense' AND payload->>'description' = $1`,
  [failureDescription]
)).rows[0].count;
if (afterExpenseCount !== beforeExpenseCount) throw new Error("Failed expense should have been rolled back");
if (afterInstanceCount !== beforeInstanceCount) throw new Error("Failed approval write should have been rolled back");
if (afterOutboxCount !== beforeOutboxCount) throw new Error("Failed transaction must not emit an outbox event");

console.log("\n=== All integration tests passed ===");

await pool.end();
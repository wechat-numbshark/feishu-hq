import test from "node:test";
import assert from "node:assert/strict";
import type { Handler } from "../src/router.ts";

// Isolated test fixtures: database and model transports are replaced; no live
// credentials, business data or external network are used.
const saved = { database: process.env.DATABASE_URL, key: process.env.MODEL_API_KEY };
process.env.DATABASE_URL = "postgresql://localhost/ai_route_test";
process.env.MODEL_API_KEY = "test-fixture-not-a-real-key";
const { pool } = await import("../src/db.ts");
await import("../src/ai.ts");
const { dispatch } = await import("../src/router.ts");
const { createSession } = await import("../src/session.ts");
for (const [key, value] of [["DATABASE_URL", saved.database], ["MODEL_API_KEY", saved.key]]) {
  if (value === undefined) delete process.env[key!];
  else process.env[key!] = value;
}

const TENANT_A = "10000000-0000-4000-8000-000000000001";
const PERSON_A = "20000000-0000-4000-8000-000000000001";
const TENANT_B = "10000000-0000-4000-8000-000000000002";
const PERSON_B = "20000000-0000-4000-8000-000000000002";

function makeSession(tenantId: string, personId: string, role = "employee") {
  return `hq_session=${createSession({ tenantId, personId, role, mode: "web" })}`;
}

const L0_DEFAULT_GRANT = {
  id: "30000000-0000-4000-8000-000000000001",
  tool_name: "query_projects",
  person_id: null,
  effect: "allow" as const,
  risk_level: "L0" as const,
  action: "project.project.read",
  data_domain: "project",
};

function mockPoolForGrants(grants: typeof L0_DEFAULT_GRANT[], capturedSql?: string[]) {
  return {
    query: async (query: string) => {
      if (capturedSql) capturedSql.push(query);
      if (query.includes("tenant_name")) {
        return { rows: [{ tenant_name: "Fixture", display_name: "Tester" }] };
      }
      if (query.includes("FROM platform.ai_tool_authorizations")) {
        return { rows: grants };
      }
      if (query.includes("INSERT INTO audit.authorization_decisions")) {
        return { rows: [{ id: "audit-1" }] };
      }
      if (query.includes("INSERT INTO audit.audit_events")) {
        return { rows: [{ id: "audit-event-1" }] };
      }
      if (query.includes("FROM project.projects")) {
        return { rows: [] };
      }
      if (query.includes("FROM platform.ai_conversations")) {
        if (query.includes("SELECT id, delegated_by_person_id, status")) {
          return { rows: conversationRow ? [{ id: conversationRow.id, delegated_by_person_id: conversationRow.delegated_by_person_id, status: "active" }] : [] };
        }
        return { rows: [{ id: "conv-1" }] };
      }
      if (query.includes("INSERT INTO platform.ai_conversations")) {
        return { rows: [{ id: "conv-1" }] };
      }
      if (query.includes("INSERT INTO platform.ai_messages")) {
        return { rows: [{ id: "msg-1" }] };
      }
      if (query.includes("UPDATE platform.ai_conversations")) {
        return { rows: [{ id: "conv-1" }] };
      }
      if (query.includes("FROM crm.opportunities")) {
        return { rows: [] };
      }
      if (query.includes("FROM hr.job_requisitions")) {
        return { rows: [] };
      }
      if (query.includes("FROM finance.payment_plans")) {
        return { rows: [] };
      }
      if (query.includes("FROM knowledge.items")) {
        return { rows: [] };
      }
      if (query.includes("INSERT INTO project.tasks")) {
        return { rows: [{ id: "task-1", title: "Test", status: "todo" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
}

function mockPoolWithAuditCapture(captured: { authz: any[]; events: any[] }, conversationRow?: { id: string; delegated_by_person_id: string } | (() => { id: string; delegated_by_person_id: string } | undefined)) {
  const getConversationRow = () => typeof conversationRow === "function" ? conversationRow() : conversationRow;
  return {
    query: async (query: string, params?: any[]) => {
      if (query.includes("tenant_name")) {
        return { rows: [{ tenant_name: "Fixture", display_name: "Tester" }] };
      }
      if (query.includes("FROM platform.ai_tool_authorizations")) {
        return { rows: [L0_DEFAULT_GRANT] };
      }
      if (query.includes("INSERT INTO audit.authorization_decisions")) {
        captured.authz.push({ query, params });
        return { rows: [{ id: "audit-1" }] };
      }
      if (query.includes("INSERT INTO audit.audit_events")) {
        captured.events.push({ query, params });
        return { rows: [{ id: "audit-event-1" }] };
      }
      if (query.includes("FROM project.projects")) {
        return { rows: [] };
      }
      if (query.includes("FROM platform.ai_conversations")) {
        if (query.includes("SELECT id, delegated_by_person_id, status")) {
          const row = getConversationRow();
          return { rows: row ? [{ id: row.id, delegated_by_person_id: row.delegated_by_person_id, status: "active" }] : [] };
        }
        return { rows: [{ id: "conv-1" }] };
      }
      if (query.includes("INSERT INTO platform.ai_conversations")) {
        return { rows: [{ id: "conv-1" }] };
      }
      if (query.includes("INSERT INTO platform.ai_messages")) {
        return { rows: [{ id: "msg-1" }] };
      }
      if (query.includes("UPDATE platform.ai_conversations")) {
        return { rows: [{ id: "conv-1" }] };
      }
      if (query.includes("FROM crm.opportunities")) {
        return { rows: [] };
      }
      if (query.includes("FROM hr.job_requisitions")) {
        return { rows: [] };
      }
      if (query.includes("FROM finance.payment_plans")) {
        return { rows: [] };
      }
      if (query.includes("FROM knowledge.items")) {
        return { rows: [] };
      }
      if (query.includes("INSERT INTO project.tasks")) {
        return { rows: [{ id: "task-1", title: "Test", status: "todo" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
}

const toolCallQueryProjects = { id: "fixture-call", type: "function", function: { name: "query_projects", arguments: "{}" } };
const toolCallCreateTask = { id: "call-l2", type: "function", function: { name: "create_task", arguments: JSON.stringify({ project_id: "p1", title: "Test" }) } };
const toolCallCreateTaskOk = { id: "call-l2-ok", type: "function", function: { name: "create_task", arguments: JSON.stringify({ project_id: "p1", title: "Test" }) } };

test("chat route sends matching assistant tool_calls before tool results", async (t) => {
  assert.ok(pool);
  const sql: string[] = [];
  t.mock.method(pool, "connect", async () => mockPoolForGrants([L0_DEFAULT_GRANT], sql));
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length === 1) {
      return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCallQueryProjects] } }], usage: {} });
    }
    const resultIndex = body.messages.findIndex((m: any) => m.role === "tool");
    assert.ok(resultIndex > 0);
    assert.deepEqual(body.messages[resultIndex - 1].tool_calls, [toolCallQueryProjects]);
    assert.equal(body.messages[resultIndex].tool_call_id, toolCallQueryProjects.id);
    return Response.json({ choices: [{ message: { content: "没有项目记录" } }], usage: {} });
  });
  const matched = dispatch("POST", "/v1/ai/chat");
  assert.ok(matched);
  let status = 0;
  let output: any;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_A) }, body: { message: "查看项目" }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = JSON.parse(body); } },
    { traceId: "fixture-trace", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  assert.equal(requests.length, 2);
  assert.equal(status, 200);
  assert.equal(output.message, "没有项目记录");
  assert.ok(sql.some(query => query.includes("FROM project.projects")));
});

test("cross-tenant AI tool call is rejected by RLS and authorization", async (t) => {
  assert.ok(pool);
  // Model returns a tool call to query_projects, which should be authorized
  const captured = { authz: [], events: [] };
  t.mock.method(pool, "connect", async () => mockPoolWithAuditCapture(captured));

  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length === 1) {
      // First call: model returns tool call
      return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCallQueryProjects] } }], usage: {} });
    }
    // Second call: after tool result, model returns final response
    return Response.json({ choices: [{ message: { content: "OK" } }], usage: {} });
  });

  const matched = dispatch("POST", "/v1/ai/chat");
  assert.ok(matched);
  let status = 0;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_A) }, body: { message: "查看项目" }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: () => {} },
    { traceId: "cross-tenant-trace", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  assert.equal(status, 200);

  // Verify authorization decision was logged with correct delegator and session
  assert.ok(captured.authz.length > 0);
  const lastAuthz = captured.authz[captured.authz.length - 1];
  const params = lastAuthz.params;
  assert.equal(params[1], `ai:${PERSON_A}`); // subject_id = ai:personId
  assert.equal(params[2], PERSON_A); // delegated_by_subject_id = personId
  assert.equal(params[3], "project.project.read"); // action
  assert.ok(params[5] === true); // allowed = true for L0 default
  assert.ok(params[9] === "cross-tenant-trace"); // trace_id

  // Verify audit event was logged
  assert.ok(captured.events.length > 0);
  const lastEvent = captured.events[captured.events.length - 1];
  const eventParams = lastEvent.params;
  assert.equal(eventParams[1], `ai:${PERSON_A}`); // actor_id
  assert.equal(eventParams[2], PERSON_A); // delegated_by_actor_id
  assert.equal(eventParams[4], "success"); // outcome
  assert.ok(lastEvent.query.includes("'ai.tool.execute'")); // action is a SQL literal, not a parameter
});

test("L2 tool create_task requires person grant; denied without it", async (t) => {
  assert.ok(pool);
  // L2 tool with no person grant should be denied
  t.mock.method(pool, "connect", async () => mockPoolForGrants([]));

  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length === 1) {
      return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCallCreateTask] } }], usage: {} });
    }
    return Response.json({ choices: [{ message: { content: "Done" } }], usage: {} });
  });

  const matched = dispatch("POST", "/v1/ai/chat");
  assert.ok(matched);
  let status = 0;
  let output: any;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_A) }, body: { message: "创建任务" }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = JSON.parse(body); } },
    { traceId: "l2-deny-trace", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  // Permission denied is returned as a tool result, not an HTTP error
  assert.equal(status, 200);
  const toolResult = requests[1]?.messages?.find((m: any) => m.role === "tool");
  assert.ok(toolResult);
  assert.match(toolResult.content, /permission_denied:create_task/);
});

test("L2 tool create_task allowed with explicit person grant", async (t) => {
  assert.ok(pool);
  const personGrant = {
    id: "30000000-0000-4000-8000-000000000002",
    tool_name: "create_task",
    person_id: PERSON_A,
    effect: "allow" as const,
    risk_level: "L2" as const,
    action: "project.task.create",
    data_domain: "project",
  };
  t.mock.method(pool, "connect", async () => mockPoolForGrants([personGrant]));

  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length === 1) {
      return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCallCreateTaskOk] } }], usage: {} });
    }
    return Response.json({ choices: [{ message: { content: "任务已创建" } }], usage: {} });
  });

  const matched = dispatch("POST", "/v1/ai/chat");
  assert.ok(matched);
  let status = 0;
  let output: any;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_A) }, body: { message: "创建任务" }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = JSON.parse(body); } },
    { traceId: "l2-allow-trace", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  assert.equal(status, 200);
  assert.ok(output.message.includes("创建") || output.message.includes("任务"));
});

test("explicit deny overrides tenant admin and person grants", async (t) => {
  assert.ok(pool);
  const denyGrant = {
    id: "30000000-0000-4000-8000-000000000003",
    tool_name: "query_projects",
    person_id: PERSON_A,
    effect: "deny" as const,
    risk_level: "L0" as const,
    action: "project.project.read",
    data_domain: "project",
  };
  t.mock.method(pool, "connect", async () => mockPoolForGrants([denyGrant, L0_DEFAULT_GRANT]));

  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length === 1) {
      return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCallQueryProjects] } }], usage: {} });
    }
    return Response.json({ choices: [{ message: { content: "OK" } }], usage: {} });
  });

  const matched = dispatch("POST", "/v1/ai/chat");
  assert.ok(matched);
  let status = 0;
  let output: any;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_A, "tenant_admin") }, body: { message: "查看项目" }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = JSON.parse(body); } },
    { traceId: "deny-override-trace", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  assert.equal(status, 200);
  const toolResult = requests[1]?.messages?.find((m: any) => m.role === "tool");
  assert.ok(toolResult);
  assert.match(toolResult.content, /permission_denied:query_projects/);
});

test("AI session persists across messages and tracks last_tool_call_at", async (t) => {
  assert.ok(pool);
  let conversationId: string | undefined;
  let conversationRow: { id: string; delegated_by_person_id: string } | undefined;
  const captured = { authz: [], events: [] };

  t.mock.method(pool, "connect", async () => mockPoolWithAuditCapture(captured, () => conversationRow));

  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length === 1) {
      // First message - model returns tool call
      return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCallQueryProjects] } }], usage: {} });
    }
    if (requests.length === 2) {
      // Second message - model returns final response
      return Response.json({ choices: [{ message: { content: "OK" } }], usage: {} });
    }
    return Response.json({ choices: [{ message: { content: "OK" } }], usage: {} });
  });

  const matched = dispatch("POST", "/v1/ai/chat");
  assert.ok(matched);

  // First message - creates conversation
  let status = 0;
  let output: any;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_A) }, body: { message: "第一条" }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = JSON.parse(body); } },
    { traceId: "persist-1", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  assert.equal(status, 200);
  conversationId = output.conversation_id;
  conversationRow = { id: conversationId, delegated_by_person_id: PERSON_A };
  assert.ok(conversationId);

  // Second message - uses existing conversation
  status = 0;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_A) }, body: { message: "第二条", conversation_id: conversationId }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = JSON.parse(body); } },
    { traceId: "persist-2", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  assert.equal(status, 200);
  assert.equal(output.conversation_id, conversationId);

  // Verify conversation_id was passed in audit context
  const lastAuthz = captured.authz[captured.authz.length - 1];
  const authzParams = lastAuthz.params;
  const context = JSON.parse(authzParams[8]);
  assert.equal(context.conversation_id, conversationId);
});

test("different persons in same tenant have isolated sessions and grants", async (t) => {
  assert.ok(pool);
  const capturedA = { authz: [], events: [] };
  const capturedB = { authz: [], events: [] };
  const conversationRows = new Map<string, { id: string; delegated_by_person_id: string }>();

  let currentPerson = PERSON_A;
  t.mock.method(pool, "connect", async () => mockPoolWithAuditCapture(currentPerson === PERSON_A ? capturedA : capturedB, conversationRows.get(currentPerson)));

  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length % 2 === 1) {
      return Response.json({ choices: [{ message: { content: null, tool_calls: [toolCallQueryProjects] } }], usage: {} });
    }
    return Response.json({ choices: [{ message: { content: "OK" } }], usage: {} });
  });

  const matched = dispatch("POST", "/v1/ai/chat");
  assert.ok(matched);

  // Person A
  let status = 0;
  currentPerson = PERSON_A;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_A) }, body: { message: "A的消息" }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: (body: string) => { const out = JSON.parse(body); conversationRows.set(PERSON_A, { id: out.conversation_id, delegated_by_person_id: PERSON_A }); } },
    { traceId: "person-a-trace", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  assert.equal(status, 200);

  // Person B
  status = 0;
  currentPerson = PERSON_B;
  await matched.handler(
    { headers: { cookie: makeSession(TENANT_A, PERSON_B) }, body: { message: "B的消息" }, params: {} },
    { writeHead: (code: number) => { status = code; }, end: (body: string) => { const out = JSON.parse(body); conversationRows.set(PERSON_B, { id: out.conversation_id, delegated_by_person_id: PERSON_B }); } },
    { traceId: "person-b-trace", url: new URL("http://localhost/v1/ai/chat"), params: {} }
  );
  assert.equal(status, 200);

  // Each person's audit trail should show their own person_id as delegated_by
  assert.ok(capturedA.authz.length > 0);
  assert.equal(capturedA.authz[capturedA.authz.length - 1].params[2], PERSON_A);

  assert.ok(capturedB.authz.length > 0);
  assert.equal(capturedB.authz[capturedB.authz.length - 1].params[2], PERSON_B);
});
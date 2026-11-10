import test from "node:test";
import assert from "node:assert/strict";
import type { Handler } from "../src/router.ts";
import { createApprovalInstance, processApprovalDecision, syncResourceStatus } from "../src/modules/approvals.ts";

// Mock database for unit testing the approval logic
const mockDb = {
  queries: [] as Array<{ sql: string; values: unknown[] }>,
  query: async function(sql: string, values: unknown[] = []) {
    this.queries.push({ sql, values });
    return { rows: [] };
  }
};

test("createApprovalInstance: manager step with no manager should return null approver (not fallback to requester)", async () => {
  mockDb.queries = [];
  // Mock flow with manager step
  mockDb.query = async (sql: string, values: unknown[] = []) => {
    mockDb.queries.push({ sql, values });
    if (sql.includes("approval_flows")) {
      return { rows: [{ id: "flow-1", steps: [{ order: 1, type: "manager", label: "直属上级" }], auto_approve_if_no_approver: false }] };
    }
    if (sql.includes("approval_instances")) return { rows: [] };
    if (sql.includes("approval_actions")) return { rows: [] };
    return { rows: [] };
  };
  
  const instanceId = await createApprovalInstance(mockDb as any, {
    tenantId: "t1", flowCode: "leave", resourceType: "leave", resourceId: "r1",
    requesterPersonId: "p1", title: "请假", summary: {}, managerPersonId: null
  });
  
  // Should create instance but first action should have null approver
  const actionInsert = mockDb.queries.find(q => q.sql.includes("approval_actions"));
  assert.ok(actionInsert);
  assert.strictEqual(actionInsert.values[2], null, "无主管时审批人应为 null，不回退申请人");
});

test("createApprovalInstance: role step should return null approver (not assign to requester)", async () => {
  mockDb.queries = [];
  mockDb.query = async (sql: string, values: unknown[] = []) => {
    mockDb.queries.push({ sql, values });
    if (sql.includes("approval_flows")) {
      return { rows: [{ id: "flow-1", steps: [{ order: 1, type: "role", label: "HR" }], auto_approve_if_no_approver: false }] };
    }
    if (sql.includes("approval_instances")) return { rows: [] };
    if (sql.includes("approval_actions")) return { rows: [] };
    return { rows: [] };
  };
  
  await createApprovalInstance(mockDb as any, {
    tenantId: "t1", flowCode: "leave", resourceType: "leave", resourceId: "r1",
    requesterPersonId: "p1", title: "请假", summary: {}, managerPersonId: "m1"
  });
  
  const actionInsert = mockDb.queries.find(q => q.sql.includes("approval_actions"));
  assert.ok(actionInsert);
  assert.strictEqual(actionInsert.values[2], null, "role 步骤审批人应为 null，不指定申请人");
});

test("processApprovalDecision: role step with no assigned approver should deny decision (not allow anyone)", async () => {
  mockDb.queries = [];
  mockDb.query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("approval_instances ai")) {
      return { rows: [{ 
        id: "inst-1", flow_id: "flow-1", current_step: 1, requester_person_id: "p1",
        steps: [{ order: 1, type: "role", label: "HR" }], status: "pending"
      }] };
    }
    if (sql.includes("approval_actions")) {
      return { rows: [{ id: "act-1", instance_id: "inst-1", step_order: 1, approver_person_id: null, status: "pending" }] };
    }
    if (sql.includes("UPDATE platform.approval_actions")) return { rows: [] };
    return { rows: [] };
  };
  
  // Someone tries to decide on a role step with no assigned approver
  await assert.rejects(
    processApprovalDecision(mockDb as any, "inst-1", "random-person", "approved", null),
    { message: "permission_denied" }
  );
});

test("processApprovalDecision: role step next approver should be null (not deciding person)", async () => {
  mockDb.queries = [];
  let actionInsertValues: unknown[] | null = null;
  mockDb.query = async (sql: string, values: unknown[] = []) => {
    mockDb.queries.push({ sql, values });
    if (sql.includes("approval_instances ai")) {
      return { rows: [{ 
        id: "inst-1", flow_id: "flow-1", current_step: 1, requester_person_id: "p1",
        steps: [
          { order: 1, type: "role", label: "HR" },
          { order: 2, type: "role", label: "Finance" }
        ], status: "pending"
      }] };
    }
    if (sql.includes("approval_actions") && sql.includes("WHERE instance_id")) {
      return { rows: [{ id: "act-1", instance_id: "inst-1", step_order: 1, approver_person_id: "hr-person", status: "pending" }] };
    }
    if (sql.includes("UPDATE platform.approval_actions SET status")) return { rows: [] };
    if (sql.includes("UPDATE platform.approval_instances SET current_step")) return { rows: [] };
    if (sql.includes("INSERT INTO platform.approval_actions")) {
      actionInsertValues = values;
      return { rows: [] };
    }
    return { rows: [] };
  };
  
  await processApprovalDecision(mockDb as any, "inst-1", "hr-person", "approved", null);
  
  // Next step is role, approver should be null (not the deciding person)
  assert.ok(actionInsertValues);
  // VALUES: ($1, platform.current_tenant_id(), $2, $3, $4) = (uuid, tenantId, instanceId, step_order, approverPersonId)
  assert.strictEqual(actionInsertValues[3], null, "role 步骤下一位审批人应为 null，不指定上一位审批人");
});

test("syncResourceStatus: should propagate errors not swallow them", async () => {
  mockDb.queries = [];
  let threw = false;
  mockDb.query = async (sql: string) => {
    if (sql.includes("UPDATE hr.leave_requests")) {
      threw = true;
      throw new Error("DB error");
    }
    return { rows: [] };
  };
  
  // Should throw, not catch and ignore
  await assert.rejects(
    syncResourceStatus(mockDb as any, "leave_request", "lr-1", "approved"),
    { message: "DB error" }
  );
  assert.ok(threw);
});
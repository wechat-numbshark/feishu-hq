import test from "node:test";
import assert from "node:assert/strict";
import {
  authorize,
  baselinePolicies,
  type AuthorizationRequest
} from "../src/index.ts";

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    subject: {
      id: "person-1",
      tenantId: "tenant-a",
      actorType: "human",
      roles: ["member"],
      orgUnitIds: ["org-1"]
    },
    action: "project.task.read",
    resource: {
      id: "task-1",
      tenantId: "tenant-a",
      domain: "project",
      type: "task",
      classification: "internal"
    },
    context: {
      relationships: ["subject_is_assignee"],
      traceId: "trace-test"
    },
    ...overrides
  };
}

test("默认拒绝没有允许策略的动作", () => {
  const decision = authorize(request({ action: "finance.invoice.export" }), baselinePolicies);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /default_deny/);
});

test("员工可以查看自己负责的任务", () => {
  const decision = authorize(request(), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.ok(decision.matchedPolicyIds.includes("allow-own-task"));
});

test("项目成员只能通过项目关系获得项目读取权限", () => {
  const decision = authorize(request({
    action: "project.project.read",
    resource: {
      id: "project-1",
      tenantId: "tenant-a",
      domain: "project",
      type: "project",
      classification: "confidential"
    },
    context: { relationships: ["subject_is_project_member"], traceId: "trace-project" }
  }), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.ok(decision.maskFields.includes("customer.contact.mobile"));
});

test("平台管理员不能读取 restricted 人事数据", () => {
  const decision = authorize(request({
    subject: {
      id: "admin-1",
      tenantId: "tenant-a",
      actorType: "human",
      roles: ["platform_admin"],
      orgUnitIds: []
    },
    action: "hr.employee.read",
    resource: {
      id: "employee-1",
      tenantId: "tenant-a",
      domain: "hr",
      type: "employee",
      classification: "restricted"
    },
    context: { relationships: [], traceId: "trace-hr" }
  }), baselinePolicies);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /explicit_deny/);
});

test("访客只能读取明确分享的低敏资源", () => {
  const decision = authorize(request({
    subject: {
      id: "guest-1",
      tenantId: "tenant-a",
      actorType: "human",
      roles: ["guest"],
      orgUnitIds: []
    },
    action: "content.document.read",
    resource: {
      id: "document-1",
      tenantId: "tenant-a",
      domain: "content",
      type: "document",
      classification: "internal"
    },
    context: { relationships: ["subject_has_active_share"], traceId: "trace-guest" }
  }), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.ok(decision.obligations.includes("watermark"));
});

test("AI 代理继承委托人的角色和资源关系", () => {
  const decision = authorize(request({
    subject: {
      id: "agent-session-1",
      tenantId: "tenant-a",
      actorType: "ai_delegate",
      roles: ["member"],
      orgUnitIds: ["org-1"],
      delegatedBySubjectId: "person-1"
    }
  }), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.ok(decision.matchedPolicyIds.includes("allow-own-task"));
});

test("付款申请人即使是审批人也不能审批自己的付款", () => {
  const decision = authorize(request({
    subject: {
      id: "finance-1",
      tenantId: "tenant-a",
      actorType: "human",
      roles: ["finance_approver"],
      orgUnitIds: ["finance"]
    },
    action: "finance.payment.approve",
    resource: {
      id: "payment-1",
      tenantId: "tenant-a",
      domain: "finance",
      type: "payment",
      classification: "restricted"
    },
    context: {
      relationships: ["subject_is_requester", "subject_is_assigned_approver"],
      mfaVerified: true,
      riskLevel: "L3",
      traceId: "trace-payment"
    }
  }), baselinePolicies);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /deny-self-approve-payment/);
});

test("跨租户访问始终拒绝", () => {
  const decision = authorize(request({
    resource: {
      id: "task-other",
      tenantId: "tenant-b",
      domain: "project",
      type: "task",
      classification: "internal"
    }
  }), baselinePolicies);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /cross_tenant/);
});

test("没有明确委托人的 AI 会话不能调用工具", () => {
  const decision = authorize(request({
    subject: {
      id: "orphan-agent",
      tenantId: "tenant-a",
      actorType: "ai_delegate",
      roles: ["member"],
      orgUnitIds: ["org-1"]
    }
  }), baselinePolicies);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /missing_ai_delegator/);
});

test("非申请人的财务审批人通过 MFA 后可以审批", () => {
  const decision = authorize(request({
    subject: {
      id: "finance-2",
      tenantId: "tenant-a",
      actorType: "human",
      roles: ["finance_approver"],
      orgUnitIds: ["finance"]
    },
    action: "finance.payment.approve",
    resource: {
      id: "payment-2",
      tenantId: "tenant-a",
      domain: "finance",
      type: "payment",
      classification: "restricted"
    },
    context: {
      relationships: ["subject_is_assigned_approver"],
      mfaVerified: true,
      riskLevel: "L3",
      traceId: "trace-payment-2"
    }
  }), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.ok(decision.obligations.includes("verify_approval_instance"));
});

// ── P1-A1 数据域 / 字段脱敏：员工档案薪资可见性与手机号脱敏 ──

function employeeRead(roles: string[], relationship: string): AuthorizationRequest {
  return request({
    subject: { id: "p", tenantId: "tenant-a", actorType: "human", roles, orgUnitIds: [] },
    action: "hr.employee.read",
    resource: { id: "e", tenantId: "tenant-a", domain: "hr", type: "employee", classification: "restricted" },
    context: { relationships: [relationship], traceId: "trace-employee" }
  });
}

test("人事管理员可查看员工薪资，不脱敏", () => {
  const decision = authorize(employeeRead(["hr_manager"], "subject_is_colleague"), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.ok(decision.matchedPolicyIds.includes("allow-hr-full-access"));
  assert.equal(decision.hiddenFields.length, 0);
  assert.equal(decision.maskFields.length, 0);
});

test("普通同事查看他人：薪资隐藏 + 手机号脱敏", () => {
  const decision = authorize(employeeRead(["employee"], "subject_is_colleague"), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.ok(decision.hiddenFields.includes("hr.employee.salary"));
  assert.ok(decision.maskFields.includes("hr.employee.mobile"));
});

test("本人查看自己：薪资可见、手机号不脱敏", () => {
  const decision = authorize(employeeRead(["employee"], "subject_is_self"), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.equal(decision.hiddenFields.length, 0);
  assert.equal(decision.maskFields.length, 0);
});

test("财务管理员查看他人薪资同样受限", () => {
  const decision = authorize(employeeRead(["finance_manager"], "subject_is_colleague"), baselinePolicies);
  assert.equal(decision.allowed, true);
  assert.ok(decision.hiddenFields.includes("hr.employee.salary"));
});

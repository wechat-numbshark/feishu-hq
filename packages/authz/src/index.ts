export type PolicyEffect = "allow" | "deny";
export type ActorType = "human" | "ai_delegate" | "service";

export interface AuthorizationSubject {
  id: string;
  tenantId: string;
  actorType: ActorType;
  roles: string[];
  orgUnitIds: string[];
  delegatedBySubjectId?: string;
}

export interface AuthorizationResource {
  id: string;
  tenantId: string;
  domain: string;
  type: string;
  classification: "public" | "internal" | "confidential" | "restricted";
  ownerPersonId?: string;
  ownerOrgUnitId?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface AuthorizationContext {
  relationships: string[];
  mfaVerified?: boolean;
  purpose?: string;
  riskLevel?: "L0" | "L1" | "L2" | "L3";
  traceId: string;
}

export interface PolicyRule {
  id: string;
  description: string;
  effect: PolicyEffect;
  actions: string[];
  subjects?: {
    rolesAny?: string[];
    actorTypesAny?: ActorType[];
    orgUnitIdsAny?: string[];
  };
  resources?: {
    domainsAny?: string[];
    typesAny?: string[];
    classificationsAny?: AuthorizationResource["classification"][];
  };
  relationshipsAny?: string[];
  requireMfa?: boolean;
  fields?: {
    mask?: string[];
    hide?: string[];
  };
  obligations?: string[];
  rowFilter?: Record<string, unknown>;
}

export interface AuthorizationRequest {
  subject: AuthorizationSubject;
  action: string;
  resource: AuthorizationResource;
  context: AuthorizationContext;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
  matchedPolicyIds: string[];
  maskFields: string[];
  hiddenFields: string[];
  obligations: string[];
  rowFilters: Record<string, unknown>[];
  traceId: string;
}

function intersects(left: string[] = [], right: string[] = []): boolean {
  return left.some((item) => right.includes(item));
}

function actionMatches(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return action.startsWith(pattern.slice(0, -1));
  return pattern === action;
}

function applies(rule: PolicyRule, request: AuthorizationRequest): boolean {
  if (request.subject.tenantId !== request.resource.tenantId) return false;
  if (!rule.actions.some((pattern) => actionMatches(pattern, request.action))) return false;

  const subject = rule.subjects;
  if (subject?.rolesAny && !intersects(subject.rolesAny, request.subject.roles)) return false;
  if (subject?.actorTypesAny && !subject.actorTypesAny.includes(request.subject.actorType)) return false;
  if (subject?.orgUnitIdsAny && !intersects(subject.orgUnitIdsAny, request.subject.orgUnitIds)) return false;

  const resource = rule.resources;
  if (resource?.domainsAny && !resource.domainsAny.includes(request.resource.domain)) return false;
  if (resource?.typesAny && !resource.typesAny.includes(request.resource.type)) return false;
  if (resource?.classificationsAny && !resource.classificationsAny.includes(request.resource.classification)) return false;

  if (rule.relationshipsAny && !intersects(rule.relationshipsAny, request.context.relationships)) return false;
  if (rule.requireMfa && request.context.mfaVerified !== true) return false;

  return true;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function authorize(
  request: AuthorizationRequest,
  policies: PolicyRule[]
): AuthorizationDecision {
  if (request.subject.tenantId !== request.resource.tenantId) {
    return {
      allowed: false,
      reason: "hard_deny:cross_tenant",
      matchedPolicyIds: [],
      maskFields: [],
      hiddenFields: [],
      obligations: ["audit_denial", "security_alert"],
      rowFilters: [],
      traceId: request.context.traceId
    };
  }

  if (request.subject.actorType === "ai_delegate" && !request.subject.delegatedBySubjectId) {
    return {
      allowed: false,
      reason: "hard_deny:missing_ai_delegator",
      matchedPolicyIds: [],
      maskFields: [],
      hiddenFields: [],
      obligations: ["audit_denial", "security_alert"],
      rowFilters: [],
      traceId: request.context.traceId
    };
  }

  const matched = policies.filter((rule) => applies(rule, request));
  const denied = matched.filter((rule) => rule.effect === "deny");
  const allowed = matched.filter((rule) => rule.effect === "allow");

  if (denied.length > 0) {
    return {
      allowed: false,
      reason: `explicit_deny:${denied.map((rule) => rule.id).join(",")}`,
      matchedPolicyIds: matched.map((rule) => rule.id),
      maskFields: [],
      hiddenFields: [],
      obligations: unique(denied.flatMap((rule) => rule.obligations ?? ["audit_denial"])),
      rowFilters: [],
      traceId: request.context.traceId
    };
  }

  if (allowed.length === 0) {
    return {
      allowed: false,
      reason: "default_deny:no_allow_policy",
      matchedPolicyIds: [],
      maskFields: [],
      hiddenFields: [],
      obligations: ["audit_denial"],
      rowFilters: [],
      traceId: request.context.traceId
    };
  }

  return {
    allowed: true,
    reason: `allowed_by:${allowed.map((rule) => rule.id).join(",")}`,
    matchedPolicyIds: allowed.map((rule) => rule.id),
    maskFields: unique(allowed.flatMap((rule) => rule.fields?.mask ?? [])),
    hiddenFields: unique(allowed.flatMap((rule) => rule.fields?.hide ?? [])),
    obligations: unique(allowed.flatMap((rule) => rule.obligations ?? ["audit"])),
    rowFilters: allowed.flatMap((rule) => rule.rowFilter ? [rule.rowFilter] : []),
    traceId: request.context.traceId
  };
}

export const baselinePolicies: PolicyRule[] = [
  {
    id: "deny-cross-tenant",
    description: "租户边界由决策器强制执行；此规则用于策略目录说明",
    effect: "deny",
    actions: []
  },
  {
    id: "deny-platform-admin-restricted-hr",
    description: "平台管理员不因管理员身份读取 restricted 人事数据",
    effect: "deny",
    actions: ["hr.employee.read", "hr.employee.export"],
    subjects: { rolesAny: ["platform_admin"] },
    resources: { domainsAny: ["hr"], classificationsAny: ["restricted"] },
    obligations: ["audit_denial", "suggest_break_glass_request"]
  },
  {
    id: "deny-self-approve-payment",
    description: "付款申请人不能审批自己的付款",
    effect: "deny",
    actions: ["finance.payment.approve"],
    relationshipsAny: ["subject_is_requester"],
    obligations: ["audit_denial", "segregation_of_duties"]
  },
  {
    id: "allow-own-task",
    description: "员工和 AI 代理可读写本人任务",
    effect: "allow",
    actions: ["project.task.read", "project.task.update"],
    subjects: { rolesAny: ["member", "project_manager"] },
    resources: { domainsAny: ["project"], typesAny: ["task"] },
    relationshipsAny: ["subject_is_owner", "subject_is_assignee"],
    obligations: ["audit"],
    rowFilter: { relation: "subject_is_owner_or_assignee" }
  },
  {
    id: "allow-project-member",
    description: "项目成员可查看项目范围数据",
    effect: "allow",
    actions: ["project.project.read", "project.task.read", "project.requirement.read"],
    subjects: { rolesAny: ["member", "project_manager"] },
    resources: { domainsAny: ["project"] },
    relationshipsAny: ["subject_is_project_member", "subject_is_project_manager"],
    fields: { mask: ["customer.contact.mobile", "customer.contact.personal_email"] },
    obligations: ["audit"]
  },
  {
    id: "allow-sales-account-team",
    description: "销售按负责人、汇报线和客户团队访问客户",
    effect: "allow",
    actions: ["crm.party.read", "crm.opportunity.read", "crm.opportunity.update"],
    subjects: { rolesAny: ["sales_rep", "sales_manager"] },
    resources: { domainsAny: ["crm"] },
    relationshipsAny: ["subject_is_owner", "subject_manages_owner", "subject_in_account_team"],
    fields: { mask: ["contact.mobile", "contact.personal_email"] },
    obligations: ["audit"]
  },
  {
    id: "allow-explicit-guest-share",
    description: "访客只能访问明确分享的低敏资源",
    effect: "allow",
    actions: ["project.project.read", "project.task.read", "content.document.read"],
    subjects: { rolesAny: ["guest"] },
    resources: { classificationsAny: ["public", "internal"] },
    relationshipsAny: ["subject_has_active_share"],
    obligations: ["audit", "watermark", "disable_global_search"]
  },
  {
    id: "allow-finance-approver-with-mfa",
    description: "财务审批人通过 MFA 后可审批非本人付款",
    effect: "allow",
    actions: ["finance.payment.approve"],
    subjects: { rolesAny: ["finance_approver"] },
    resources: { domainsAny: ["finance"], typesAny: ["payment"] },
    relationshipsAny: ["subject_is_assigned_approver"],
    requireMfa: true,
    obligations: ["audit", "verify_approval_instance"]
  },
  {
    id: "allow-platform-administration",
    description: "平台管理员管理平台配置但不自动读取业务内容",
    effect: "allow",
    actions: ["admin.*"],
    subjects: { rolesAny: ["platform_admin"] },
    resources: { domainsAny: ["platform"] },
    obligations: ["audit", "admin_banner"]
  },
  {
    id: "allow-hr-full-access",
    description: "企业管理员与人事管理员读取员工档案含薪资，不脱敏",
    effect: "allow",
    actions: ["hr.employee.read"],
    subjects: { rolesAny: ["tenant_admin", "hr_manager"] },
    resources: { domainsAny: ["hr"], typesAny: ["employee"] },
    obligations: ["audit"]
  },
  {
    id: "allow-employee-self-read",
    description: "本人可查看自己的完整档案（含薪资）",
    effect: "allow",
    actions: ["hr.employee.read"],
    subjects: { rolesAny: ["employee", "manager", "finance_manager"] },
    resources: { domainsAny: ["hr"], typesAny: ["employee"] },
    relationshipsAny: ["subject_is_self"],
    obligations: ["audit"]
  },
  {
    id: "allow-staff-roster-limited",
    description: "普通同事可查看名册但薪资隐藏、他人手机号脱敏",
    effect: "allow",
    actions: ["hr.employee.read"],
    subjects: { rolesAny: ["employee", "manager", "finance_manager"] },
    resources: { domainsAny: ["hr"], typesAny: ["employee"] },
    relationshipsAny: ["subject_is_colleague"],
    fields: { hide: ["hr.employee.salary"], mask: ["hr.employee.mobile"] },
    obligations: ["audit"]
  }
];

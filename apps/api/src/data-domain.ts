// ──────────────────────────────────────────────────────────────
// 数据域 / 字段策略层（ABAC，接入真实执行链）
// ──────────────────────────────────────────────────────────────
// 分工：RBAC(assertCapability) 决定"能否执行动作"；本层用 packages/authz
// 的 ABAC 决策器决定"能看到哪些行 / 哪些字段"，落地薪资记录级可见性与
// 联系方式脱敏。决策完全来自 baselinePolicies，不在本文件重写规则。
import type { DbClient } from "./db.ts";
import type { SessionIdentity } from "./session.ts";
import { effectiveRoles } from "./authz.ts";
import {
  authorize,
  baselinePolicies,
  type AuthorizationRequest,
} from "../../../packages/authz/src/index.ts";

// 规范字段标识（与 baselinePolicies 中 hide/mask 保持一致）
export const SALARY_FIELD = "hr.employee.salary";
export const MOBILE_FIELD = "hr.employee.mobile";

export interface FieldPolicy {
  hidden: string[];
  mask: string[];
}

// 计算某主体查看某员工档案时的字段策略（隐藏字段 + 需脱敏字段）。
// tenant_admin 走捷径（对应 allow-hr-full-access）；其余从 authz.role_bindings 解析角色。
// 决策器判为不允许时按"最小可见"兜底：隐藏薪资 + 脱敏手机号（fail-closed 于敏感字段，
// 但不改变名册可读性，避免过度收紧既有行为）。
export async function resolveEmployeeFieldPolicy(
  db: DbClient,
  identity: SessionIdentity,
  targetPersonId: string
): Promise<FieldPolicy> {
  const roles = await effectiveRoles(db, identity);
  const subjectRoles = roles.length > 0 ? roles : ["employee"];
  const isSelf = Boolean(targetPersonId) && identity.personId === targetPersonId;

  const request: AuthorizationRequest = {
    subject: {
      id: identity.personId,
      tenantId: identity.tenantId,
      actorType: "human",
      roles: subjectRoles,
      orgUnitIds: [],
    },
    action: "hr.employee.read",
    resource: {
      id: targetPersonId,
      tenantId: identity.tenantId,
      domain: "hr",
      type: "employee",
      classification: "restricted",
    },
    context: {
      relationships: [isSelf ? "subject_is_self" : "subject_is_colleague"],
      traceId: "",
    },
  };

  const decision = authorize(request, baselinePolicies);
  if (!decision.allowed) {
    return { hidden: [SALARY_FIELD], mask: [MOBILE_FIELD] };
  }
  return { hidden: decision.hiddenFields, mask: decision.maskFields };
}

function maskMobile(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value.length <= 5) return "****";
  return `${value.slice(0, 3)}****${value.slice(-2)}`;
}

// 依据策略裁剪 / 脱敏员工档案对象（就地不改原引用，返回浅拷贝）。
export function applyEmployeeFieldPolicy<T extends Record<string, any>>(
  employee: T,
  policy: FieldPolicy
): T {
  const out: Record<string, unknown> = { ...employee };
  if (policy.hidden.includes(SALARY_FIELD)) {
    if (Array.isArray(out.contracts)) {
      out.contracts = (out.contracts as Array<Record<string, unknown>>).map((c) => {
        const clone: Record<string, unknown> = { ...c };
        delete clone.base_salary_cents;
        return clone;
      });
    }
    // 薪资结构（若下游返回）同样移除金额
    if (Array.isArray(out.salary_components)) {
      out.salary_components = (out.salary_components as Array<Record<string, unknown>>).map((c) => {
        const clone: Record<string, unknown> = { ...c };
        delete clone.amount_cents;
        return clone;
      });
    }
  }
  if (policy.mask.includes(MOBILE_FIELD)) out.mobile = maskMobile(out.mobile);
  return out as T;
}

// ── P2c 行级数据域（ABAC row scope）──────────────────────────
// HR 字段策略解决"看到多少字段"，行级域解决"看到哪些行"：
// tenant_admin 与 manager/hr_manager/finance_manager 等特权岗位全量可见；
// 普通员工限定为"本人拥有 / 本人提交 / 参与为成员 / 无明确归属"的行。
// 无归属行保持可见——避免过度收紧历史数据与直插场景（如实记录该兜底）。
export interface RowScope { all: boolean; personId: string }

const PRIVILEGED_ROW_ROLES = new Set(["tenant_admin", "manager", "hr_manager", "finance_manager"]);

// 返回 { all, personId }；all=true 时各列表端点不加行级过滤（传 null）。
export async function resolveRowScope(db: DbClient, identity: SessionIdentity): Promise<RowScope & { sqlParam: string | null }> {
  const roles = await effectiveRoles(db, identity);
  const all = roles.some((r: string) => PRIVILEGED_ROW_ROLES.has(r));
  return { all, personId: identity.personId, sqlParam: all ? null : identity.personId };
}

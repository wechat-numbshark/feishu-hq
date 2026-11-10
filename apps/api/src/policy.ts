// ──────────────────────────────────────────────────────────────
// 统一能力策略：把"哪条路由需要什么能力"集中在一处声明。
// main.ts 在 dispatch 之前调用 enforcePolicy；handler 只负责业务。
// ──────────────────────────────────────────────────────────────
import type { SessionIdentity } from "./session.ts";
import { withTenant } from "./db.ts";
import { assertAnyCapability } from "./authz.ts";

type Cap = string[] | "authenticated" | "public";

interface Rule {
  method: string;
  pattern: RegExp;
  caps: Cap;
}

const r = (method: string, pattern: string, caps: Cap): Rule => ({
  method,
  pattern: new RegExp(`^${pattern}$`),
  caps,
});

// 具体规则在前、模块通配在后；首个命中生效。
const RULES: Rule[] = [
  // ── 公开 / 会话
  r("POST", "/v1/session/demo", "public"),
  r("DELETE", "/v1/session", "authenticated"),
  r("POST", "/v1/feishu/webhook", "public"),
  r("POST", "/v1/authz/explain", "authenticated"),
  r("POST", "/v1/ai/.*", "authenticated"),
  r("PATCH", "/v1/ai/.*", "authenticated"),
  r("GET", "/v1/ai/.*", "authenticated"),

  // ── 自助服务（记录级由 handler 再校验）
  r("POST", "/v1/hr/leave-requests", "authenticated"),
  r("PATCH", "/v1/hr/leave-requests/[^/]+", "authenticated"),
  r("POST", "/v1/hr/attendance/(checkin|checkout|makeup)", "authenticated"),
  r("POST", "/v1/finance/expenses", "authenticated"),
  r("PATCH", "/v1/finance/expenses/[^/]+/approve", ["finance.approve"]),
  r("POST", "/v1/finance/expenses/[^/]+/approve", ["finance.approve"]),
  r("POST", "/v1/tasks/[^/]+/(comments|time-logs)", ["project.write"]),
  r("PATCH", "/v1/tasks/[^/]+", ["project.write"]),
  r("POST", "/v1/projects/[^/]+/tasks", ["project.write"]),
  r("POST", "/v1/projects/[^/]+/risks", ["project.write"]),
  r("POST", "/v1/people/.+", "authenticated"),
  r("PATCH", "/v1/people/[^/]+", "authenticated"),
  r("POST", "/v1/strategy/key-results/[^/]+/checkins", ["project.write"]),
  r("POST", "/v1/approvals/[^/]+/(decide|withdraw|transfer|add-sign)", "authenticated"),

  // ── 知识：贡献开放，管理动作受限
  r("POST", "/v1/knowledge/items", ["knowledge.write"]),
  r("PATCH", "/v1/knowledge/items/[^/]+", ["knowledge.write"]),
  r("DELETE", "/v1/knowledge/items/[^/]+", ["knowledge.write"]),
  r("POST", "/v1/knowledge/items/[^/]+/(ratings|review|submit-review)", ["knowledge.write"]),
  r("POST", "/v1/knowledge/categories", ["settings.manage"]),

  // ── 项目
  r("POST", "/v1/projects", ["project.manage"]),
  r("PATCH", "/v1/projects/[^/]+", ["project.manage"]),
  r("DELETE", "/v1/projects/[^/]+", ["project.manage"]),
  r("POST", "/v1/projects/[^/]+/(members|milestones|change-requests)", ["project.manage"]),
  r("DELETE", "/v1/projects/[^/]+/members/[^/]+", ["project.manage"]),
  r("PATCH", "/v1/(milestones|change-requests|risks)/[^/]+", ["project.manage"]),

  // ── CRM / 合同 / 销售
  r("(POST|PATCH|DELETE)", "/v1/crm/.*", ["crm.manage"]),
  r("(POST|PATCH|DELETE)", "/v1/sales/contracts.*", ["contract.manage"]),
  r("(POST|PATCH|DELETE)", "/v1/sales/subscriptions.*", ["contract.manage"]),
  r("(POST|PATCH|DELETE)", "/v1/sales/contract-templates.*", ["contract.manage"]),
  r("(POST|PATCH|DELETE)", "/v1/sales/orders.*", ["sales.manage"]),

  // ── 财务
  r("(POST|PATCH|DELETE)", "/v1/finance/(budgets|invoices|payments).*", ["finance.manage"]),
  r("POST", "/v1/finance/invoices/[^/]+/auto-writeoff", ["finance.manage"]),

  // ── 采购 / 供应链
  r("POST", "/v1/purchase/(requisitions|orders)/[^/]+/(approve|reject|convert)", ["purchase.approve"]),
  r("(POST|PATCH|DELETE)", "/v1/purchase/.*", ["purchase.write"]),
  r("POST", "/v1/qms/inspections/[^/]+/verdict", ["ops.manage"]),
  r("(POST|PATCH|DELETE)", "/v1/(mfg|stock|qms|equipment)/.*", ["ops.write"]),
  r("(POST|PATCH|DELETE)", "/v1/sw/.*", ["sw.write"]),

  // ── IT / 组织 / 设置
  r("POST", "/v1/it/tickets", ["it.ticket"]),
  r("(POST|PATCH|DELETE)", "/v1/it/.*", ["it.manage"]),
  r("(POST|PATCH|DELETE)", "/v1/org/.*", ["org.manage"]),
  r("POST", "/v1/org-units", ["org.manage"]),
  r("(PATCH|PUT|DELETE)", "/v1/settings/.*", ["settings.manage"]),
  r("(POST|PATCH|PUT|DELETE)", "/v1/rbac/.*", ["people.manage_roles"]),
  r("PATCH", "/v1/approval-flows/.*", ["approval.manage"]),
  r("(POST|PATCH|PUT|DELETE)", "/v1/integrations/.*", ["integrations.manage"]),

  // ── HR（自助与审批规则已在前）
  r("(POST|PATCH|DELETE)", "/v1/hr/.*", ["hr.manage"]),

  // ── 战略
  r("(POST|PATCH|DELETE)", "/v1/strategy/.*", ["strategy.manage"]),

  // ── 导入（handler 内再校验实体能力）
  r("POST", "/v1/import/employees", ["hr.manage"]),
  r("POST", "/v1/import/accounts", ["crm.manage"]),

  // ── 敏感读
  r("GET", "/v1/settings/.*", ["settings.manage"]),
  r("GET", "/v1/rbac/.*", ["people.manage_roles"]),
  r("GET", "/v1/integrations/(kodbox/(instances|sync-runs|permission-audit|permission-rules)|feishu/status).*", ["integrations.manage"]),
  r("GET", "/v1/audit/.*", ["audit.read"]),
];

function match(method: string, pathname: string): Cap | null {
  for (const rule of RULES) {
    const methodMatches =
      rule.method === method ||
      (rule.method.startsWith("(") && new RegExp(`^${rule.method}$`).test(method));
    if (methodMatches && rule.pattern.test(pathname)) return rule.caps;
  }
  return null;
}

/**
 * 执行路由级能力校验。
 * - 未命中规则：读请求放行（已登录）；写请求默认要求 settings.manage（缺省拒绝）。
 * - 这样新增路由若忘记声明，写操作会直接 403，而不是"登录即可写"。
 */
export async function enforcePolicy(
  identity: SessionIdentity,
  method: string,
  pathname: string
): Promise<void> {
  if (method === "OPTIONS" || method === "HEAD") return;
  const caps = match(method, pathname);
  if (caps === "public" || caps === "authenticated") return;
  if (caps === null && !["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
  const required = caps === null ? ["settings.manage"] : caps;
  await withTenant(identity, (db) => assertAnyCapability(db, identity, required));
}

/** 供测试与审计使用：返回某路由的声明能力。 */
export function policyFor(method: string, pathname: string): Cap | null {
  return match(method, pathname);
}

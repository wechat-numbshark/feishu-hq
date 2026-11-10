// ──────────────────────────────────────────────────────────────
// 岗位权限层（RBAC，服务端强制执行）
// ──────────────────────────────────────────────────────────────
// 设计要点：
// - tenant_admin 拥有全部能力；但不再盲信 Cookie 里的 role：
//   正式会话必须能从 authz.role_bindings 解析到 tenant_admin，避免撤职后旧 Cookie 继续放行。
//   演示会话（demo）允许回退到 Cookie 角色，保证体验企业可进入。
// - 其他用户从 authz.role_bindings 实时解析岗位角色，再映射到能力集合。
// - 写操作与敏感读由 policy.ts 统一挂载；职责分离在业务处显式判断。
import type { DbClient } from "./db.ts";
import type { SessionIdentity } from "./session.ts";
import { uuid } from "./db.ts";

// 可分配的岗位角色（管理设置里由管理员授予）
export const ROLE_LABELS: Record<string, string> = {
  tenant_admin: "企业管理员",
  hr_manager: "人事管理员",
  finance_manager: "财务管理员",
  manager: "部门主管",
  employee: "普通员工",
};

// 管理员可授予 / 撤销的角色（employee 为默认基线，不在此列）
export const MANAGEABLE_ROLES = ["tenant_admin", "hr_manager", "finance_manager", "manager"] as const;

// 角色职责说明（用于管理设置界面）
export const ROLE_DESCRIPTIONS: Record<string, string> = {
  tenant_admin: "企业最高权限：管理成员权限、审批流与全部业务数据",
  hr_manager: "人事：员工增改、合同、薪资、职位、请假审批与政策",
  finance_manager: "财务：预算、发票、收款计划、报销审批与采购审批",
  manager: "部门主管：项目/客户/运营管理，审批直属团队的请假与报销",
  employee: "默认权限：自助提交请假/报销、查看本人信息、参与项目任务",
};

// 角色 → 能力映射；"*" 表示全部能力
const CAPABILITIES: Record<string, string[]> = {
  tenant_admin: ["*"],
  hr_manager: [
    "hr.manage",            // 员工增改、合同、职位、请假政策
    "hr.employee.read",     // 员工档案
    "hr.salary.read",       // 读取任意员工薪资
    "hr.salary.write",      // 维护薪资组成
    "hr.leave.approve",     // 审批请假
    "knowledge.write",
    "project.write",
  ],
  finance_manager: [
    "finance.manage",       // 预算 / 发票 / 收款计划
    "finance.read",
    "finance.approve",      // 审批报销
    "contract.manage",      // 合同起草/签署/收款计划
    "contract.read",
    "purchase.approve",     // 采购审批
    "purchase.write",
    "purchase.read",
    "sales.manage",         // 销售订单
    "knowledge.write",
    "project.write",
  ],
  manager: [
    "project.manage",       // 项目创建/成员/里程碑
    "project.write",        // 任务/工时
    "crm.manage",           // 客户/商机
    "ops.manage",           // 制造/供应链/质量/设备/研发
    "strategy.manage",      // OKR
    "it.manage",            // IT 资产/工单
    "hr.employee.read",
    "hr.leave.approve",     // 审批直属团队请假
    "finance.approve",      // 审批直属团队报销
    "finance.read",
    "contract.read",
    "purchase.write",
    "purchase.read",
    "sales.manage",
    "knowledge.write",
  ],
  employee: [
    "project.write",        // 参与项目任务（记录级再校验）
    "knowledge.write",      // 知识贡献
    "purchase.write",       // 提交请购/收货（审批仍需 purchase.approve）
    "ops.write",            // 制造/质量/设备/研发的日常执行
    "sw.write",             // 需求/缺陷/迭代参与
    "it.ticket",            // 提交 IT 工单
    "self.service",         // 请假/报销/打卡/工时等自助
  ],
};

// 仅 tenant_admin 拥有的能力（不下放给任何岗位角色）
const ADMIN_ONLY = new Set([
  "people.manage_roles",
  "approval.manage",
  "settings.manage",
  "integrations.manage",
  "org.manage",
  "audit.read",
]);

export function expandCapabilities(roles: string[]): string[] {
  if (roles.includes("tenant_admin")) return ["*"];
  const caps = new Set<string>();
  for (const code of roles) for (const c of CAPABILITIES[code] ?? []) caps.add(c);
  return [...caps];
}

export function hasCapability(roles: string[], capability: string): boolean {
  if (roles.includes("tenant_admin")) return true;
  if (ADMIN_ONLY.has(capability)) return false;
  return expandCapabilities(roles).includes(capability);
}

/** 解析某人在当前租户下的有效角色代码。 */
export async function resolveRoles(db: DbClient, personId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT r.code
     FROM authz.role_bindings rb
     JOIN authz.roles r ON r.id = rb.role_id AND r.tenant_id = rb.tenant_id
     WHERE rb.tenant_id = platform.current_tenant_id()
       AND rb.subject_type = 'person' AND rb.subject_id = $1
       AND rb.deleted_at IS NULL AND r.status = 'active'`,
    [personId]
  );
  return rows.map((r: { code: string }) => r.code);
}

/**
 * 校验能力；不足则抛 permission_denied（main.ts 映射为 403）。
 * 返回解析到的角色，供后续逻辑复用。
 */
export async function assertCapability(
  db: DbClient,
  identity: SessionIdentity,
  capability: string
): Promise<string[]> {
  const roles = await resolveRoles(db, identity.personId);
  if (roles.length === 0 && identity.mode === "demo" && identity.role === "tenant_admin") {
    return ["tenant_admin"];
  }
  // 没有任何显式岗位绑定的用户按 employee 基线处理（与文档"employee 为默认"一致）。
  const effective = roles.length > 0 ? roles : ["employee"];
  if (!hasCapability(effective, capability)) throw new Error("permission_denied");
  return effective;
}

/** 满足任一能力即可；常用于"管理员或岗位负责人"这类并集。 */
export async function assertAnyCapability(
  db: DbClient,
  identity: SessionIdentity,
  capabilities: string[]
): Promise<string[]> {
  const roles = await resolveRoles(db, identity.personId);
  if (roles.length === 0 && identity.mode === "demo" && identity.role === "tenant_admin") {
    return ["tenant_admin"];
  }
  const effective = roles.length > 0 ? roles : ["employee"];
  if (!capabilities.some((cap) => hasCapability(effective, cap))) throw new Error("permission_denied");
  return effective;
}

/** 解析有效角色：DB 绑定优先；演示管理员回退；无绑定按 employee。 */
export async function effectiveRoles(db: DbClient, identity: SessionIdentity): Promise<string[]> {
  const roles = await resolveRoles(db, identity.personId);
  if (roles.length === 0 && identity.mode === "demo" && identity.role === "tenant_admin") return ["tenant_admin"];
  return roles.length > 0 ? roles : ["employee"];
}

/** 只判断不抛错，用于字段/记录级降级。 */
export async function capabilitiesOf(db: DbClient, identity: SessionIdentity): Promise<string[]> {
  return expandCapabilities(await effectiveRoles(db, identity));
}

// 确保某角色存在于 authz.roles，返回其 id
export async function ensureRole(db: DbClient, code: string): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO authz.roles (id, tenant_id, code, name, description, role_kind, status)
     VALUES ($1, platform.current_tenant_id(), $2, $3, '岗位权限角色', $4, 'active')
     ON CONFLICT (tenant_id, code) DO UPDATE SET status = 'active', name = EXCLUDED.name
     RETURNING id`,
    [uuid(), code, ROLE_LABELS[code] ?? code, code === "tenant_admin" ? "platform" : "business"]
  );
  return rows[0].id;
}

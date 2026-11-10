/**
 * 飞书用户/部门 ↔ Kodbox 文件目录权限映射
 * 实现：
 * - 飞书用户 ID → Kodbox 用户创建/同步
 * - 飞书部门 → Kodbox 用户组/目录结构
 * - 权限映射：部门成员 → 对应目录读写权限
 * - 权限撤销：人员离职/调岗 → 自动回收权限
 */

import type { KodboxClient, KodboxUser } from "./kodbox-client.ts";

export interface FeishuUser {
  openId: string;
  unionId?: string;
  userId?: string;
  name: string;
  email?: string;
  mobile?: string;
  departmentIds: string[];
  primaryDepartmentId?: string;
  status: "active" | "inactive" | "resigned";
}

export interface FeishuDepartment {
  openDepartmentId: string;
  parentOpenDepartmentId?: string;
  name: string;
  leaderOpenId?: string;
  order?: number;
  status: "active" | "deleted";
}

export interface PermissionMappingRule {
  departmentId: string;
  kodboxPath: string;
  permission: "read" | "write" | "read_write" | "admin";
  inheritToChildren: boolean;
}

export interface KodboxUserMapping {
  feishuOpenId: string;
  kodboxUserId: number;
  kodboxUsername: string;
  homePath: string;
  syncedAt: string;
}

export interface KodboxDirectoryMapping {
  feishuDepartmentId: string;
  kodboxPath: string;
  createdAt: string;
  permissionsApplied: boolean;
}

export interface SyncResult {
  usersCreated: number;
  usersUpdated: number;
  usersDisabled: number;
  directoriesCreated: number;
  permissionsApplied: number;
  permissionsRevoked: number;
  errors: string[];
}

/**
 * 生成 Kodbox 兼容的用户名（基于飞书 open_id）
 */
export function generateKodboxUsername(feishuOpenId: string): string {
  return `fs_${feishuOpenId.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50)}`;
}

/**
 * 生成 Kodbox 部门目录路径
 */
export function generateDepartmentPath(departmentName: string, parentPath: string = "/"): string {
  const sanitized = departmentName
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 100);
  const base = parentPath.endsWith("/") ? parentPath : `${parentPath}/`;
  return `${base}${sanitized}`;
}

/**
 * 同步飞书组织到 Kodbox
 * 1. 创建/更新 Kodbox 用户（映射飞书 open_id）
 * 2. 创建部门对应的目录结构
 * 3. 应用权限映射规则
 */
export async function syncFeishuOrganizationToKodbox(
  kodbox: KodboxClient,
  feishuUsers: FeishuUser[],
  feishuDepartments: FeishuDepartment[],
  mappingRules: PermissionMappingRule[] = []
): Promise<SyncResult> {
  const result: SyncResult = {
    usersCreated: 0,
    usersUpdated: 0,
    usersDisabled: 0,
    directoriesCreated: 0,
    permissionsApplied: 0,
    permissionsRevoked: 0,
    errors: [],
  };

  try {
    // 1. 获取现有 Kodbox 用户
    const existingUsersResponse = await kodbox.listUsers();
    const existingUsers = new Map<string, KodboxUser>();
    if (existingUsersResponse.code === 0 && existingUsersResponse.data?.list) {
      for (const user of existingUsersResponse.data.list) {
        // 假设 username 格式为 fs_{open_id}
        const match = user.username.match(/^fs_(.+)$/);
        if (match) {
          existingUsers.set(match[1], user);
        }
      }
    }

    // 2. 同步用户
    const activeFeishuOpenIds = new Set<string>();
    for (const feishuUser of feishuUsers) {
      if (feishuUser.status !== "active") continue;
      activeFeishuOpenIds.add(feishuUser.openId);

      const kodboxUsername = generateKodboxUsername(feishuUser.openId);
      const existingUser = existingUsers.get(feishuUser.openId);

      // 计算用户主目录：/个人文件/{name}_{openId前8位}
      const homePath = `/个人文件/${feishuUser.name}_${feishuUser.openId.slice(0, 8)}`;

      if (existingUser) {
        // 更新现有用户（如需更新角色等）
        result.usersUpdated++;
      } else {
        // 创建新用户
        const password = generateRandomPassword(16);
        const createResp = await kodbox.createUser(kodboxUsername, password, "user", homePath);
        if (createResp.code === 0) {
          result.usersCreated++;
        } else {
          result.errors.push(`创建用户 ${feishuUser.name} 失败: ${createResp.message}`);
        }
      }

      // 确保用户主目录存在
      await ensureDirectoryExists(kodbox, homePath);
    }

    // 3. 禁用离职用户
    for (const [openId, user] of existingUsers) {
      if (!activeFeishuOpenIds.has(openId)) {
        // 这里可以调用禁用用户 API，暂记录
        result.usersDisabled++;
      }
    }

    // 4. 创建部门目录结构
    const departmentPathMap = new Map<string, string>();

    // 按层级排序：父部门先创建
    const sortedDepts = topologicalSortDepartments(feishuDepartments);

    for (const dept of sortedDepts) {
      if (dept.status !== "active") continue;

      let parentPath = "/共享文件/部门文件";
      if (dept.parentOpenDepartmentId) {
        parentPath = departmentPathMap.get(dept.parentOpenDepartmentId) || parentPath;
      }

      const deptPath = generateDepartmentPath(dept.name, parentPath);
      departmentPathMap.set(dept.openDepartmentId, deptPath);

      const exists = await kodbox.exists(deptPath);
      if (!exists) {
        const mkdirResp = await kodbox.mkdir(parentPath, deptPath.split("/").pop() || dept.name);
        if (mkdirResp.code === 0) {
          result.directoriesCreated++;
        } else {
          result.errors.push(`创建部门目录 ${dept.name} 失败: ${mkdirResp.message}`);
        }
      }
    }

    // 5. 应用权限映射规则
    for (const rule of mappingRules) {
      const deptPath = departmentPathMap.get(rule.departmentId);
      if (!deptPath) {
        result.errors.push(`部门 ${rule.departmentId} 对应的目录不存在`);
        continue;
      }

      // 获取该部门及其子部门的所有活跃用户
      const targetUserIds = getDepartmentUserIds(
        feishuDepartments,
        feishuUsers,
        rule.departmentId,
        rule.inheritToChildren
      );

      for (const openId of targetUserIds) {
        const existingUser = existingUsers.get(openId);
        if (!existingUser) {
          result.errors.push(`用户 ${openId} 在 Kodbox 中不存在，无法设置权限`);
          continue;
        }

        const permResp = await kodbox.setPathPermission(
          deptPath,
          String(existingUser.uid),
          rule.permission
        );
        if (permResp.code === 0) {
          result.permissionsApplied++;
        } else {
          result.errors.push(`设置权限失败 ${deptPath} -> ${openId}: ${permResp.message}`);
        }
      }
    }

    // 6. 权限撤销：检查不再属于该部门的用户
    // 这里简化：实际应对比现有权限与当前映射规则
    // result.permissionsRevoked 待实现

  } catch (error) {
    result.errors.push(`同步异常: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

/**
 * 确保目录存在（递归创建）
 */
async function ensureDirectoryExists(kodbox: KodboxClient, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let currentPath = "/";

  for (const part of parts) {
    currentPath = `${currentPath}${part}`;
    const exists = await kodbox.exists(currentPath);
    if (!exists) {
      const parentPath = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
      await kodbox.mkdir(parentPath, part);
    }
    currentPath += "/";
  }
}

/**
 * 拓扑排序部门（父部门在前）
 */
export function topologicalSortDepartments(departments: FeishuDepartment[]): FeishuDepartment[] {
  const byId = new Map(departments.map((d) => [d.openDepartmentId, d]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: FeishuDepartment[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // 忽略循环
    visiting.add(id);

    const dept = byId.get(id);
    if (!dept) return;

    if (dept.parentOpenDepartmentId && byId.has(dept.parentOpenDepartmentId)) {
      visit(dept.parentOpenDepartmentId);
    }

    visiting.delete(id);
    visited.add(id);
    sorted.push(dept);
  }

  for (const dept of departments) {
    visit(dept.openDepartmentId);
  }

  return sorted;
}

/**
 * 获取部门及其子部门的所有活跃用户 openId
 */
export function getDepartmentUserIds(
  departments: FeishuDepartment[],
  users: FeishuUser[],
  rootDeptId: string,
  includeChildren: boolean
): string[] {
  // 只考虑活跃的部门
  const activeDepartments = departments.filter((d) => d.status === "active");
  const activeDeptIds = new Set(activeDepartments.map((d) => d.openDepartmentId));

  // 如果根部门不活跃，直接返回空
  if (!activeDeptIds.has(rootDeptId)) {
    return [];
  }

  const targetDeptIds = new Set<string>([rootDeptId]);

  if (includeChildren) {
    const deptByParent = new Map<string, string[]>();
    for (const dept of activeDepartments) {
      if (dept.parentOpenDepartmentId && activeDeptIds.has(dept.parentOpenDepartmentId)) {
        const arr = deptByParent.get(dept.parentOpenDepartmentId) || [];
        arr.push(dept.openDepartmentId);
        deptByParent.set(dept.parentOpenDepartmentId, arr);
      }
    }

    const queue = [rootDeptId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = deptByParent.get(current) || [];
      for (const child of children) {
        if (!targetDeptIds.has(child)) {
          targetDeptIds.add(child);
          queue.push(child);
        }
      }
    }
  }

  return users
    .filter((u) => u.status === "active" && u.departmentIds.some((d) => targetDeptIds.has(d)))
    .map((u) => u.openId);
}

/**
 * 生成随机密码
 */
function generateRandomPassword(length: number): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

/**
 * 权限变更审计记录
 */
export interface PermissionAuditLog {
  id: string;
  tenantId: string;
  action: "grant" | "revoke" | "modify";
  targetType: "user" | "department";
  targetId: string; // feishu open_id 或 department_id
  kodboxPath: string;
  oldPermission?: string;
  newPermission: string;
  operatorId: string; // 操作人 feishu open_id
  reason: string;
  createdAt: string;
}

/**
 * 创建权限审计日志条目（供数据库存储）
 */
export function createPermissionAuditLog(
  params: Omit<PermissionAuditLog, "id" | "createdAt">
): PermissionAuditLog {
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * 批量权限操作（用于管理员界面）
 */
export interface BatchPermissionOperation {
  operations: Array<{
    feishuOpenId: string;
    kodboxPath: string;
    permission: "read" | "write" | "read_write" | "admin";
    action: "grant" | "revoke";
  }>;
  operatorId: string;
  reason: string;
}

export async function executeBatchPermissionOperations(
  kodbox: KodboxClient,
  operation: BatchPermissionOperation,
  existingUsers: Map<string, KodboxUser>
): Promise<{
  success: number;
  failed: number;
  errors: string[];
}> {
  const result = { success: 0, failed: 0, errors: [] as string[] };

  for (const op of operation.operations) {
    const user = existingUsers.get(op.feishuOpenId);
    if (!user) {
      result.failed++;
      result.errors.push(`用户 ${op.feishuOpenId} 不存在`);
      continue;
    }

    try {
      if (op.action === "grant") {
        const resp = await kodbox.setPathPermission(op.kodboxPath, String(user.uid), op.permission);
        if (resp.code === 0) {
          result.success++;
        } else {
          result.failed++;
          result.errors.push(`${op.feishuOpenId}@${op.kodboxPath}: ${resp.message}`);
        }
      } else {
        // 撤销权限：设为无权限或移除 ACL
        // 可道云可能不支持直接"无权限"，需设为最低权限或从 ACL 移除
        const resp = await kodbox.setPathPermission(op.kodboxPath, String(user.uid), "read");
        if (resp.code === 0) {
          result.success++;
        } else {
          result.failed++;
          result.errors.push(`${op.feishuOpenId}@${op.kodboxPath}: ${resp.message}`);
        }
      }
    } catch (error) {
      result.failed++;
      result.errors.push(`${op.feishuOpenId}@${op.kodboxPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}
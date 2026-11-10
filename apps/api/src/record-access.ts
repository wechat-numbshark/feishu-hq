// ──────────────────────────────────────────────────────────────
// 记录级访问控制（IDOR 防线）
// 列表已经用 resolveRowScope 做过行级过滤；详情/更新/删除必须在同一规则下再校验。
// 无权限时抛 not_found（而非 403），避免通过状态码枚举资源是否存在。
// ──────────────────────────────────────────────────────────────
import type { DbClient } from "./db.ts";
import type { SessionIdentity } from "./session.ts";
import { resolveRowScope } from "./data-domain.ts";

async function scoped(db: DbClient, identity: SessionIdentity): Promise<{ all: boolean; personId: string }> {
  const { all, personId } = await resolveRowScope(db, identity);
  return { all, personId };
}

/** 项目：负责人 / 项目成员 / 无归属（历史数据）可访问；特权岗位全量。 */
export async function assertProjectAccess(
  db: DbClient,
  identity: SessionIdentity,
  projectId: string
): Promise<void> {
  const { all, personId } = await scoped(db, identity);
  if (all) return;
  const { rowCount } = await db.query(
    `SELECT 1 FROM project.projects p
     WHERE p.tenant_id = platform.current_tenant_id() AND p.id = $1
       AND (p.owner_person_id IS NULL OR p.owner_person_id = $2
            OR EXISTS (SELECT 1 FROM project.project_members pm
                       WHERE pm.tenant_id = p.tenant_id AND pm.project_id = p.id
                         AND pm.person_id = $2 AND pm.left_at IS NULL))`,
    [projectId, personId]
  );
  if (!rowCount) throw new Error("not_found");
}

/** 通用"归属人"记录：owner_person_id / created_by / person_id 任一匹配即可。 */
export async function assertOwnerAccess(
  db: DbClient,
  identity: SessionIdentity,
  table: "crm.accounts" | "crm.opportunities" | "knowledge.items",
  id: string
): Promise<void> {
  const { all, personId } = await scoped(db, identity);
  if (all) return;
  const ownerColumns: Record<typeof table, string[]> = {
    "crm.accounts": ["owner_person_id"],
    "crm.opportunities": ["owner_person_id"],
    "knowledge.items": ["owner_person_id"],
  };
  const conditions = ownerColumns[table]
    .map((col) => `t.${col} = $2`)
    .join(" OR ");
  const { rowCount } = await db.query(
    `SELECT 1 FROM ${table} t
     WHERE t.tenant_id = platform.current_tenant_id() AND t.id = $1
       AND (${conditions} OR ${ownerColumns[table].map((col) => `t.${col} IS NULL`).join(" AND ")})`,
    [id, personId]
  );
  if (!rowCount) throw new Error("not_found");
}

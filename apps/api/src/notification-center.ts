// ──────────────────────────────────────────────────────────────
// 站内通知：业务事件 → 统一收件箱（与飞书消息互补）
// 通知失败不阻断主流程；同一 dedupeKey 幂等。
// ──────────────────────────────────────────────────────────────
import type { DbClient } from "./db.ts";
import { uuid } from "./db.ts";

export interface NotificationInput {
  kind: "approval" | "task" | "risk" | "finance" | "hr" | "system" | "ai";
  title: string;
  body?: string;
  link?: string;
  dedupeKey?: string;
}

export async function createNotification(
  db: DbClient,
  personId: string | null | undefined,
  input: NotificationInput
): Promise<void> {
  if (!personId) return;
  try {
    await db.query(
      `INSERT INTO platform.notifications (id, tenant_id, person_id, kind, title, body, link, dedupe_key)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, person_id, dedupe_key) DO NOTHING`,
      [uuid(), personId, input.kind, input.title, input.body ?? null, input.link ?? null, input.dedupeKey ?? null]
    );
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn", message: "notification_insert_failed",
      detail: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function notifyMany(
  db: DbClient,
  personIds: Array<string | null | undefined>,
  input: NotificationInput
): Promise<void> {
  for (const personId of new Set(personIds.filter(Boolean) as string[])) {
    await createNotification(db, personId, input);
  }
}

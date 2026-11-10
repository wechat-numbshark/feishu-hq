// ──────────────────────────────────────────────────────────────
// 事务性 Outbox 生产者（P1-9）
// 业务写库与事件写入在同一 withTenant 事务内完成（原子），worker 侧消费 published_at IS NULL 的行。
// platform.outbox_events 已由迁移 0023 授予 hq_app SELECT/INSERT/UPDATE。
// idempotency_key 全局唯一（UNIQUE(tenant_id, idempotency_key)），同 key 重复写入被忽略。
// ──────────────────────────────────────────────────────────────
import type { DbClient } from "./db.ts";

export interface EmitInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actorId: string;
  traceId: string;
  payload: Record<string, unknown>;
  /** 缺省用 `${aggregateType}:${aggregateId}:${eventType}` 自动生成（同一聚合同一事件只发一次）。 */
  idempotencyKey?: string;
  eventVersion?: number;
}

export async function emitEvent(db: DbClient, tenantId: string, input: EmitInput): Promise<void> {
  const key = input.idempotencyKey ?? `${input.aggregateType}:${input.aggregateId}:${input.eventType}`;
  await db.query(
    `INSERT INTO platform.outbox_events
       (id, tenant_id, event_type, event_version, aggregate_type, aggregate_id, actor_id, trace_id, idempotency_key, payload)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      tenantId, input.eventType, input.eventVersion ?? 1,
      input.aggregateType, input.aggregateId, input.actorId,
      input.traceId, key, JSON.stringify(input.payload ?? {}),
    ]
  );
}

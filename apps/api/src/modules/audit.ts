import { get, json } from "../router.ts";
import { withTenant, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { assertCapability } from "../authz.ts";

// ═══════════════════════════════════════════════════════════════
// 审计日志查询（管理员）
// 只读；按发生时间倒序；支持 actor / resource_type / outcome 过滤。
// ═══════════════════════════════════════════════════════════════

get("/v1/audit/events", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const limit = Math.min(Math.max(Number(ctx.url.searchParams.get("limit") ?? 50), 1), 200);
  const actor = ctx.url.searchParams.get("actor");
  const resourceType = ctx.url.searchParams.get("resource_type");
  const outcome = ctx.url.searchParams.get("outcome");

  const items = await withTenant(identity, async (db: DbClient) => {
    await assertCapability(db, identity, "audit.read");
    const { rows } = await db.query(
      `SELECT e.id, e.occurred_at, e.actor_id,
              COALESCE(p.display_name, e.actor_id) AS actor_name,
              e.action, e.resource_id, e.resource_type, e.outcome, e.change_summary, e.trace_id
       FROM audit.audit_events e
       LEFT JOIN platform.people p
         ON p.tenant_id = e.tenant_id
        AND p.id = CASE
          WHEN e.actor_id ~ '^[a-z]+:[0-9a-f-]{36}$' THEN split_part(e.actor_id, ':', 2)::uuid
          WHEN e.actor_id ~ '^[0-9a-f-]{36}$' THEN e.actor_id::uuid
        END
       WHERE e.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR e.actor_id = $1)
         AND ($2::text IS NULL OR e.resource_type = $2)
         AND ($3::text IS NULL OR e.outcome = $3)
       ORDER BY e.occurred_at DESC LIMIT $4`,
      [actor, resourceType, outcome, limit]
    );
    return rows;
  });
  json(res, 200, { items });
});

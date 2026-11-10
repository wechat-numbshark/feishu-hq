import { get, post, json } from "../router.ts";
import { withTenant, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";

// ═══════════════════════════════════════════════════════════════
// 站内通知中心：只返回当前登录人自己的通知（RLS + person_id 双约束）。
// ═══════════════════════════════════════════════════════════════

get("/v1/notifications", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const limit = Math.min(Math.max(Number(ctx.url.searchParams.get("limit") ?? 20), 1), 100);
  const unreadOnly = ctx.url.searchParams.get("unread") === "1";

  const result = await withTenant(identity, async (db: DbClient) => {
    const { rows } = await db.query(
      `SELECT id, kind, title, body, link, read_at, created_at
       FROM platform.notifications
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
         AND ($2::boolean = false OR read_at IS NULL)
       ORDER BY created_at DESC LIMIT $3`,
      [identity.personId, unreadOnly, limit]
    );
    const { rows: [count] } = await db.query(
      `SELECT count(*)::int AS unread FROM platform.notifications
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1 AND read_at IS NULL`,
      [identity.personId]
    );
    return { items: rows, unread: count?.unread ?? 0 };
  });
  json(res, 200, result);
});

post("/v1/notifications/:id/read", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const updated = await withTenant(identity, async (db: DbClient) => {
    const { rowCount } = await db.query(
      `UPDATE platform.notifications SET read_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1 AND id = $2 AND read_at IS NULL`,
      [identity.personId, ctx.params.id]
    );
    return rowCount;
  });
  if (!updated) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { ok: true });
});

post("/v1/notifications/read-all", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const updated = await withTenant(identity, async (db: DbClient) => {
    const { rowCount } = await db.query(
      `UPDATE platform.notifications SET read_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1 AND read_at IS NULL`,
      [identity.personId]
    );
    return rowCount;
  });
  json(res, 200, { ok: true, updated });
});

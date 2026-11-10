import { get, post, patch, del } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { json } from "../router.ts";
import { readSession } from "../session.ts";
import { readSettings } from "../settings-registry.ts";
import { emitEvent } from "../outbox.ts";
import { assertOwnerAccess } from "../record-access.ts";
import { resolveRowScope } from "../data-domain.ts";

// ── 商机列表
get("/v1/crm/opportunities", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    // P2c 行级数据域：普通员工仅见本人拥有/无归属商机；特权岗位与 admin 传 null 不过滤
    const { sqlParam } = await resolveRowScope(db, identity);
    const { rows } = await db.query(
      `SELECT o.*, pe.display_name AS owner_name,
              (SELECT count(*) FROM crm.contacts c WHERE c.opportunity_id = o.id AND c.deleted_at IS NULL) AS contact_count,
              (SELECT count(*) FROM crm.activities a WHERE a.opportunity_id = o.id) AS activity_count
       FROM crm.opportunities o
       LEFT JOIN platform.people pe ON pe.tenant_id = o.tenant_id AND pe.id = o.owner_person_id
       WHERE o.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR o.stage = $1)
         AND ($2::text IS NULL OR o.name ILIKE '%' || $2 || '%' OR o.customer_name ILIKE '%' || $2 || '%')
         AND ($5::uuid IS NULL OR o.owner_person_id IS NULL OR o.owner_person_id = $5)
       ORDER BY o.created_at DESC
       LIMIT $3 OFFSET $4`,
      [q.stage ?? null, q.search ?? null, limit, offset, sqlParam]
    );
    // 设置消费者：crm.stale_opportunity_days / crm.pipeline_stages
    const cfg = await readSettings(db, "crm");
    const staleDays = Number(cfg.stale_opportunity_days ?? 30);
    const staleBeforeMs = Date.now() - staleDays * 86_400_000;
    const items = rows.map((r: Record<string, unknown>) => ({
      ...r,
      is_stale: r.stage !== "won" && r.stage !== "lost" && new Date(String(r.updated_at)).getTime() < staleBeforeMs,
    }));
    return { items, limit, offset, pipeline_stages: cfg.pipeline_stages, stale_opportunity_days: staleDays };
  });

  json(res, 200, rows);
});

get("/v1/crm/opportunities/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const [opp, contacts, activities] = await withTenant(identity, async (db) => {
    await assertOwnerAccess(db, identity, "crm.opportunities", ctx.params.id);
    const [o, c, a] = await Promise.all([
      db.query(
        `SELECT o.*, pe.display_name AS owner_name FROM crm.opportunities o
         LEFT JOIN platform.people pe ON pe.tenant_id = o.tenant_id AND pe.id = o.owner_person_id
         WHERE o.tenant_id = platform.current_tenant_id() AND o.id = $1`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT * FROM crm.contacts WHERE tenant_id = platform.current_tenant_id() AND opportunity_id = $1 AND deleted_at IS NULL`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT a.*, pe.display_name AS actor_name FROM crm.activities a
         JOIN platform.people pe ON pe.tenant_id = a.tenant_id AND pe.id = a.actor_person_id
         WHERE a.tenant_id = platform.current_tenant_id() AND a.opportunity_id = $1
         ORDER BY a.occurred_at DESC LIMIT 20`,
        [ctx.params.id]
      )
    ]);
    return [o.rows[0] ?? null, c.rows, a.rows];
  });

  if (!opp) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { ...opp, contacts, activities });
});

post("/v1/crm/opportunities", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name || !body.customer_name) return json(res, 400, { error: "name_and_customer_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    // 设置消费者：crm.default_win_probability
    const cfg = await readSettings(db, "crm");
    const defaultWinProb = Number(cfg.default_win_probability ?? 60);
    const { rows } = await db.query(
      `INSERT INTO crm.opportunities
         (id, tenant_id, name, customer_name, owner_person_id, amount_cents, stage, win_probability, expected_close_date, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), body.name, body.customer_name, body.owner_person_id ?? identity.personId,
       body.amount_cents ?? 0, body.stage ?? 'qualified', body.win_probability ?? defaultWinProb,
       body.expected_close_date ?? null, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/crm/opportunities/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","customer_name","stage","amount_cents","win_probability","expected_close_date","notes","owner_person_id"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertOwnerAccess(db, identity, "crm.opportunities", ctx.params.id);
    const { rows } = await db.query(
      `UPDATE crm.opportunities SET ${sets.join(",")}, updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 联系人
get("/v1/crm/opportunities/:id/contacts", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM crm.contacts WHERE tenant_id = platform.current_tenant_id() AND opportunity_id = $1 AND deleted_at IS NULL ORDER BY is_key_decision_maker DESC, name`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/crm/opportunities/:id/contacts", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO crm.contacts (id, tenant_id, opportunity_id, name, title, company, email, is_key_decision_maker, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [uuid(), ctx.params.id, body.name, body.title ?? null, body.company ?? null,
       body.email ?? null, body.is_key_decision_maker ?? false, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ── 跟进活动
post("/v1/crm/opportunities/:id/activities", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title || !body.activity_type) return json(res, 400, { error: "title_and_type_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO crm.activities
         (id, tenant_id, opportunity_id, contact_id, actor_person_id, activity_type, title, summary, outcome, occurred_at, next_action, next_action_date)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [uuid(), ctx.params.id, body.contact_id ?? null, identity.personId,
       body.activity_type, body.title, body.summary ?? null, body.outcome ?? null,
       body.occurred_at ?? new Date().toISOString(),
       body.next_action ?? null, body.next_action_date ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ── 客户档案 (Accounts)
get("/v1/crm/accounts", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT a.*, pe.display_name AS owner_name,
              (SELECT count(*) FROM crm.opportunities o WHERE o.tenant_id = a.tenant_id AND o.account_id = a.id) AS opp_count,
              (SELECT sum(o.amount_cents) FROM crm.opportunities o WHERE o.tenant_id = a.tenant_id AND o.account_id = a.id AND o.stage = 'won') AS won_amount_cents
       FROM crm.accounts a
       LEFT JOIN platform.people pe ON pe.tenant_id = a.tenant_id AND pe.id = a.owner_person_id
       WHERE a.tenant_id = platform.current_tenant_id() AND a.deleted_at IS NULL
         AND ($1::text IS NULL OR a.name ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR a.industry = $2)
       ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
      [q.search ?? null, q.industry ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

get("/v1/crm/accounts/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    await assertOwnerAccess(db, identity, "crm.accounts", ctx.params.id);
    const { rows } = await db.query(
      `SELECT a.*, pe.display_name AS owner_name,
              (SELECT json_agg(o ORDER BY o.updated_at DESC) FROM (
                SELECT o.id, o.name, o.stage, o.amount_cents, o.expected_close_date, o.win_probability, o.updated_at
                FROM crm.opportunities o WHERE o.tenant_id = a.tenant_id AND o.account_id = a.id LIMIT 20
              ) o) AS opportunities,
              (SELECT json_agg(c ORDER BY c.is_key_decision_maker DESC) FROM (
                SELECT c.id, c.name, c.title, c.email, c.is_key_decision_maker
                FROM crm.contacts c WHERE c.tenant_id = a.tenant_id AND c.account_id = a.id AND c.deleted_at IS NULL LIMIT 20
              ) c) AS contacts
       FROM crm.accounts a
       LEFT JOIN platform.people pe ON pe.tenant_id = a.tenant_id AND pe.id = a.owner_person_id
       WHERE a.tenant_id = platform.current_tenant_id() AND a.id = $1`,
      [ctx.params.id]
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

post("/v1/crm/accounts", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO crm.accounts (id, tenant_id, name, industry, company_size, website, annual_revenue_cents, credit_rating, owner_person_id, address, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [uuid(), body.name, body.industry ?? null, body.company_size ?? null,
       body.website ?? null, body.annual_revenue_cents ?? null, body.credit_rating ?? 'A',
       body.owner_person_id ?? identity.personId, body.address ?? null, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/crm/accounts/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","industry","company_size","website","annual_revenue_cents","credit_rating","owner_person_id","address","notes"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertOwnerAccess(db, identity, "crm.accounts", ctx.params.id);
    const { rows } = await db.query(
      `UPDATE crm.accounts SET ${sets.join(",")}, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 联系人关联到账户
post("/v1/crm/accounts/:id/contacts", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO crm.contacts (id, tenant_id, account_id, name, title, company, email, is_key_decision_maker, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [uuid(), ctx.params.id, body.name, body.title ?? null,
       body.company ?? null, body.email ?? null,
       body.is_key_decision_maker ?? false, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// 商机阶段推进（带赢单/输单处理）
post("/v1/crm/opportunities/:id/stage", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.stage) return json(res, 400, { error: "stage_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    await assertOwnerAccess(db, identity, "crm.opportunities", ctx.params.id);
    const updates: Record<string, unknown> = { stage: body.stage };
    if (body.stage === 'won') { updates.won_at = new Date().toISOString(); updates.win_probability = 100; }
    if (body.stage === 'lost') { updates.lost_reason = body.lost_reason ?? null; updates.lost_at = new Date().toISOString(); updates.win_probability = 0; }
    if (body.next_step) updates.next_step = body.next_step;
    if (body.amount_cents) updates.amount_cents = body.amount_cents;
    const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(",");
    const vals = [...Object.values(updates), ctx.params.id];
    const { rows } = await db.query(
      `UPDATE crm.opportunities SET ${sets}, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    const opp = rows[0] ?? null;
    // 赢单→发出事件（outbox 生产者）：下游可驱动立项/销售订单编排
    if (opp && opp.stage === 'won') {
      await emitEvent(db, identity.tenantId, {
        eventType: "crm.opportunity.won.v1", aggregateType: "crm.opportunities", aggregateId: opp.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { opportunity_id: opp.id, name: opp.name, amount_cents: opp.amount_cents, account_id: opp.account_id },
      });
    }
    return opp;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 销售漏斗统计
// ── 停滞商机（docs/17 细节）：开放中且超 N 天无跟进（默认 14 天）
get("/v1/crm/stale-opportunities", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const days = Math.min(Math.max(Number(ctx.url.searchParams.get("days") ?? 14), 1), 180);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT o.id, o.name, o.customer_name, o.amount_cents, o.stage, o.expected_close_date,
              p.display_name AS owner_name,
              coalesce((SELECT max(a.created_at) FROM crm.activities a
                        WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.id), o.created_at) AS last_touch_at,
              (now() - coalesce((SELECT max(a.created_at) FROM crm.activities a
                        WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.id), o.created_at))::text AS gap
       FROM crm.opportunities o
       LEFT JOIN platform.people p ON p.tenant_id = o.tenant_id AND p.id = o.owner_person_id
       WHERE o.tenant_id = platform.current_tenant_id()
         AND o.stage NOT IN ('won','lost')
         AND coalesce((SELECT max(a.created_at) FROM crm.activities a
                       WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.id), o.created_at) < now() - make_interval(days => $1::int)
       ORDER BY last_touch_at ASC LIMIT 20`, [days]);
    return rows;
  });
  json(res, 200, { items: rows, days });
});

get("/v1/crm/funnel", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT stage, count(*) AS count, sum(amount_cents) AS total_cents, avg(win_probability) AS avg_probability
       FROM crm.opportunities
       WHERE tenant_id = platform.current_tenant_id() AND stage NOT IN ('won','lost')
       GROUP BY stage ORDER BY min(created_at)`
    );
    return rows;
  });
  json(res, 200, { stages: rows });
});

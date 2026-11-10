import { get, post, patch } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { json } from "../router.ts";
import { readSession } from "../session.ts";
import { readSettings } from "../settings-registry.ts";

// ── 资产
get("/v1/it/assets", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT a.*, pe.display_name AS assigned_person_name, ou.name AS assigned_org_name
       FROM it.assets a
       LEFT JOIN platform.people pe ON pe.tenant_id = a.tenant_id AND pe.id = a.assigned_person_id
       LEFT JOIN platform.org_units ou ON ou.tenant_id = a.tenant_id AND ou.id = a.assigned_org_unit_id
       WHERE a.tenant_id = platform.current_tenant_id() AND a.deleted_at IS NULL
         AND ($1::text IS NULL OR a.category = $1)
         AND ($2::text IS NULL OR a.status = $2)
         AND ($3::text IS NULL OR a.name ILIKE '%' || $3 || '%' OR a.asset_code ILIKE '%' || $3 || '%')
       ORDER BY a.created_at DESC LIMIT $4 OFFSET $5`,
      [q.category ?? null, q.status ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

post("/v1/it/assets", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name || !body.category) return json(res, 400, { error: "name_and_category_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const code = `ASSET-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO it.assets
         (id, tenant_id, asset_code, name, category, vendor, model, serial_number, purchase_date, purchase_cost_cents, warranty_expires_at, license_expires_at, license_seats, assigned_person_id, assigned_org_unit_id, status, location, notes, tags)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
      [uuid(), body.asset_code ?? code, body.name, body.category,
       body.vendor ?? null, body.model ?? null, body.serial_number ?? null,
       body.purchase_date ?? null, body.purchase_cost_cents ?? null,
       body.warranty_expires_at ?? null, body.license_expires_at ?? null,
       body.license_seats ?? null, body.assigned_person_id ?? null,
       body.assigned_org_unit_id ?? null, body.status ?? 'in_use',
       body.location ?? null, body.notes ?? null, body.tags ?? []]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/it/assets/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","vendor","model","status","health_status","assigned_person_id","assigned_org_unit_id","license_expires_at","warranty_expires_at","license_seats","location","notes","tags"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE it.assets SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} AND deleted_at IS NULL RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 工单
get("/v1/it/tickets", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT t.*, pr.display_name AS requester_name, pa.display_name AS assignee_name
       FROM it.tickets t
       JOIN platform.people pr ON pr.tenant_id = t.tenant_id AND pr.id = t.requester_person_id
       LEFT JOIN platform.people pa ON pa.tenant_id = t.tenant_id AND pa.id = t.assignee_person_id
       WHERE t.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR t.status = $1)
         AND ($2::text IS NULL OR t.priority = $2)
         AND ($3::text IS NULL OR t.title ILIKE '%' || $3 || '%')
       ORDER BY t.created_at DESC LIMIT $4 OFFSET $5`,
      [q.status ?? null, q.priority ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

post("/v1/it/tickets", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title || !body.category) return json(res, 400, { error: "title_and_category_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const ticketNum = `TKT-${Date.now().toString(36).toUpperCase()}`;
    // 设置消费者：it.sla_high_hours / it.sla_medium_hours / it.helpdesk_email
    const cfg = await readSettings(db, "it");
    const priority = (body.priority ?? 'medium') as string;
    const highHours = Number(cfg.sla_high_hours ?? 4);
    const mediumHours = Number(cfg.sla_medium_hours ?? 24);
    const slaHours = (priority === 'critical' || priority === 'high') ? highHours : mediumHours;
    const slaDueAt = new Date(Date.now() + slaHours * 3_600_000).toISOString();
    const { rows } = await db.query(
      `INSERT INTO it.tickets
         (id, tenant_id, ticket_number, title, description, category, priority, status, requester_person_id, assignee_person_id, asset_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [uuid(), ticketNum, body.title, body.description ?? null,
       body.category, priority, 'open',
       identity.personId, body.assignee_person_id ?? null, body.asset_id ?? null]
    );
    return { ...rows[0], sla_hours: slaHours, sla_due_at: slaDueAt, helpdesk_email: cfg.helpdesk_email ?? "" };
  });
  json(res, 201, row);
});

patch("/v1/it/tickets/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["status","priority","assignee_person_id","resolution_notes"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if ("status" in body && body.status === "resolved") { sets.push(`resolved_at = $${vals.length + 1}`); vals.push(new Date().toISOString()); }
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE it.tickets SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 软件许可证管理
get("/v1/it/licenses", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT sl.*,
              (SELECT count(*) FROM it.license_assignments la WHERE la.tenant_id = sl.tenant_id AND la.license_id = sl.id AND la.status = 'active') AS used_seats,
              sl.total_seats - COALESCE(
                (SELECT count(*) FROM it.license_assignments la WHERE la.tenant_id = sl.tenant_id AND la.license_id = sl.id AND la.status = 'active'), 0
              ) AS available_seats
       FROM it.software_licenses sl
       WHERE sl.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR sl.software_name ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR sl.status = $2)
       ORDER BY sl.expiry_date ASC NULLS LAST, sl.software_name LIMIT $3 OFFSET $4`,
      [q.search ?? null, q.status ?? null, limit, offset]
    );
    // 设置消费者：it.license_expiry_warn_days
    const cfg = await readSettings(db, "it");
    const warnDays = Number(cfg.license_expiry_warn_days ?? 30);
    const warnBeforeMs = Date.now() + warnDays * 86_400_000;
    const items = rows.map((r: Record<string, unknown>) => ({
      ...r,
      expiring_soon: r.expiry_date != null && new Date(String(r.expiry_date)).getTime() <= warnBeforeMs,
    }));
    return { items, limit, offset, license_expiry_warn_days: warnDays };
  });
  json(res, 200, rows);
});

post("/v1/it/licenses", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.software_name || !body.license_type) return json(res, 400, { error: "software_name_and_type_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO it.software_licenses (id, tenant_id, software_name, vendor, license_type, license_key, total_seats, purchase_date, expiry_date, renewal_cost_cents, auto_renew, notes, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active') RETURNING *`,
      [uuid(), body.software_name, body.vendor ?? null, body.license_type,
       body.license_key ?? null, body.total_seats ?? 1,
       body.purchase_date ?? null, body.expiry_date ?? null,
       body.renewal_cost_cents ?? body.cost_per_seat_cents ?? null,
       body.auto_renew ?? false, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/it/licenses/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["software_name","vendor","total_seats","expiry_date","renewal_cost_cents","auto_renew","notes","status","license_key"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE it.software_licenses SET ${sets.join(",")}, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// 许可证分配
get("/v1/it/licenses/:id/assignments", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT la.*, pe.display_name AS person_name, pe.avatar_url
       FROM it.license_assignments la
       JOIN platform.people pe ON pe.tenant_id = la.tenant_id AND pe.id = la.person_id
       WHERE la.tenant_id = platform.current_tenant_id() AND la.license_id = $1 AND la.status = 'active'
       ORDER BY la.assigned_at DESC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/it/licenses/:id/assignments", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.person_id) return json(res, 400, { error: "person_id_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    // Check available seats
    const { rows: lic } = await db.query(
      `SELECT total_seats,
              (SELECT count(*) FROM it.license_assignments la WHERE la.tenant_id = sl.tenant_id AND la.license_id = sl.id AND la.status = 'active') AS used
       FROM it.software_licenses sl WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]
    );
    if (!lic[0]) throw new Error("license_not_found");
    if (Number(lic[0].used) >= Number(lic[0].total_seats)) throw new Error("no_seats_available");
    const { rows } = await db.query(
      `INSERT INTO it.license_assignments (id, tenant_id, license_id, person_id, assigned_by_person_id, assigned_at, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, now(), 'active')
       ON CONFLICT (tenant_id, license_id, person_id) DO UPDATE SET status = 'active', assigned_at = now()
       RETURNING *`,
      [uuid(), ctx.params.id, body.person_id, identity.personId]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// 工单详情
get("/v1/it/tickets/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT t.*, pr.display_name AS requester_name, pr.avatar_url AS requester_avatar,
              pa.display_name AS assignee_name, a.name AS asset_name, a.asset_code
       FROM it.tickets t
       JOIN platform.people pr ON pr.tenant_id = t.tenant_id AND pr.id = t.requester_person_id
       LEFT JOIN platform.people pa ON pa.tenant_id = t.tenant_id AND pa.id = t.assignee_person_id
       LEFT JOIN it.assets a ON a.tenant_id = t.tenant_id AND a.id = t.asset_id
       WHERE t.tenant_id = platform.current_tenant_id() AND t.id = $1`,
      [ctx.params.id]
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── IT 统计
// ── IT 告警（docs/17 细节）：许可 60 天到期 / 资产保修到期 / 超 48h 未决工单
get("/v1/it/alerts", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const alerts = await withTenant(identity, async (db) => {
    const [licenses, assets, tickets] = await Promise.all([
      db.query(
        `SELECT software_name, total_seats, expiry_date, renewal_cost_cents, auto_renew
         FROM it.software_licenses
         WHERE tenant_id = platform.current_tenant_id() AND status = 'active'
           AND expiry_date IS NOT NULL AND expiry_date <= current_date + 60
         ORDER BY expiry_date`),
      db.query(
        `SELECT asset_code, name, warranty_expires_at FROM it.assets
         WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL
           AND warranty_expires_at IS NOT NULL AND warranty_expires_at <= current_date + 90
         ORDER BY warranty_expires_at LIMIT 10`),
      db.query(
        `SELECT ticket_number, title, priority, created_at FROM it.tickets
         WHERE tenant_id = platform.current_tenant_id() AND status IN ('open','in_progress')
           AND created_at < now() - interval '48 hours'
         ORDER BY created_at LIMIT 10`),
    ]);
    return { licenses_expiring_60d: licenses.rows, warranty_expiring_90d: assets.rows, tickets_aging_48h: tickets.rows };
  });
  json(res, 200, alerts);
});

get("/v1/it/stats", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const stats = await withTenant(identity, async (db) => {
    // 设置消费者：it.license_expiry_warn_days（取代硬编码 30/90 天）
    const cfg = await readSettings(db, "it");
    const warnDays = Number(cfg.license_expiry_warn_days ?? 30);
    const [assets, tickets, expiring] = await Promise.all([
      db.query(
        `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'in_use') AS in_use,
                count(*) FILTER (WHERE health_status IN ('warning','critical')) AS needs_attention
         FROM it.assets WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL`
      ),
      db.query(
        `SELECT count(*) AS open_tickets, count(*) FILTER (WHERE priority = 'critical') AS critical_tickets
         FROM it.tickets WHERE tenant_id = platform.current_tenant_id() AND status IN ('open','in_progress')`
      ),
      db.query(
        `SELECT count(*) AS expiring_soon FROM it.assets
         WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL
           AND (license_expires_at IS NOT NULL AND license_expires_at <= now() + ($1::int * interval '1 day')
                OR warranty_expires_at IS NOT NULL AND warranty_expires_at <= now() + ($1::int * interval '1 day'))`,
        [warnDays]
      )
    ]);
    return { assets: assets.rows[0], tickets: tickets.rows[0], expiring: { ...expiring.rows[0], expiry_warn_days: warnDays } };
  });
  json(res, 200, stats);
});

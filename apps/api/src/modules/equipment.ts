import { get, post, patch, json } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { readSession } from "../session.ts";
import { emitEvent } from "../outbox.ts";
import type { IncomingMessage } from "node:http";

// ═══════════════════════════════════════════════════════════════
// 设备域（P1-6）：生产设备台账（区别于 it.assets 的 IT 资产语义）、
// 点检表/点检执行、停机台账、保养计划与记录；OEE 可用率由停机台账实时派生。
// ═══════════════════════════════════════════════════════════════

function sess(req: IncomingMessage) { return readSession(req.headers.cookie); }

// ── 设备台账 ───────────────────────────────────────────────────

get("/v1/equipment/assets", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT a.*,
              (SELECT coalesce(sum(EXTRACT(EPOCH FROM (coalesce(d.ended_at, now()) - d.started_at)) / 60.0), 0)::numeric
               FROM equipment.downtime_events d WHERE d.tenant_id = a.tenant_id AND d.equipment_id = a.id
                 AND d.started_at > now() - interval '30 days') AS downtime_minutes_30d
       FROM equipment.assets a
       WHERE a.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR a.status = $1)
         AND ($2::text IS NULL OR a.name ILIKE '%' || $2 || '%' OR a.asset_code ILIKE '%' || $2 || '%')
       ORDER BY a.asset_code LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/equipment/assets", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const code = (body.asset_code as string) ?? `EQ-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO equipment.assets
         (id, tenant_id, asset_code, name, vendor, model, work_center, location, commissioned_at, standard_rate_cents_per_hour, status, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [uuid(), code, body.name, body.vendor ?? null, body.model ?? null, body.work_center ?? null,
       body.location ?? null, body.commissioned_at ?? null, body.standard_rate_cents_per_hour ?? 0,
       body.status ?? "idle", body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/equipment/assets/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","vendor","model","work_center","location","status","standard_rate_cents_per_hour","notes"];
  const sets: string[] = []; const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  sets.push("updated_at = now()");
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE equipment.assets SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`, vals);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 点检表（标准）与点检执行（记录）───────────────────────────

post("/v1/equipment/checklists", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const items = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [];
  if (!body.name || !items.length) return json(res, 400, { error: "name_and_items_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO equipment.checklists (id, tenant_id, name, equipment_id) VALUES ($1, platform.current_tenant_id(), $2, $3) RETURNING *`,
      [uuid(), body.name, body.equipment_id ?? null]
    );
    const cl = rows[0];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.query(
        `INSERT INTO equipment.checklist_items (id, tenant_id, checklist_id, seq_no, name, standard)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5)`,
        [uuid(), cl.id, it.seq_no ?? i + 1, it.name, it.standard ?? null]);
    }
    return cl;
  });
  json(res, 201, row);
});

get("/v1/equipment/checklists/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM equipment.checklists WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const { rows: items } = await db.query(
      `SELECT * FROM equipment.checklist_items WHERE tenant_id = platform.current_tenant_id() AND checklist_id = $1 ORDER BY seq_no`, [header.id]);
    return { ...header, items };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

post("/v1/equipment/inspections", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.equipment_id) return json(res, 400, { error: "equipment_id_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO equipment.inspections
         (id, tenant_id, equipment_id, checklist_id, inspector_person_id, result, items_result, note)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [uuid(), body.equipment_id, body.checklist_id ?? null, body.inspector_person_id ?? identity.personId,
       body.result ?? "normal", JSON.stringify(body.items_result ?? []), body.note ?? null]
    );
    const insp = rows[0];
    if (insp.result === "abnormal") {
      await db.query(
        `UPDATE equipment.assets SET status = 'fault', updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status <> 'scrapped'`,
        [insp.equipment_id]);
      await emitEvent(db, identity.tenantId, {
        eventType: "equipment.inspection.abnormal.v1", aggregateType: "equipment.inspections", aggregateId: insp.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { equipment_id: insp.equipment_id, note: insp.note },
      });
    }
    return insp;
  });
  json(res, 201, row);
});

get("/v1/equipment/inspections", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, a.name AS equipment_name FROM equipment.inspections i
       JOIN equipment.assets a ON a.tenant_id = i.tenant_id AND a.id = i.equipment_id
       WHERE i.tenant_id = platform.current_tenant_id()
         AND ($1::uuid IS NULL OR i.equipment_id = $1)
         AND ($2::text IS NULL OR i.result = $2)
       ORDER BY i.inspected_at DESC LIMIT $3 OFFSET $4`,
      [q.equipment_id ?? null, q.result ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

// ── 停机台账：开始 / 结束（OEE 可用率原料）────────────────────

post("/v1/equipment/downtime", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.equipment_id || !body.started_at) return json(res, 400, { error: "equipment_id_and_started_at_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO equipment.downtime_events (id, tenant_id, equipment_id, downtime_type, reason_code, started_at, note)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6) RETURNING *`,
      [uuid(), body.equipment_id, body.downtime_type ?? "unplanned", body.reason_code ?? null,
       body.started_at, body.note ?? null]
    );
    if ((body.downtime_type ?? "unplanned") === "unplanned") {
      await db.query(`UPDATE equipment.assets SET status = 'fault', updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'running'`, [body.equipment_id]);
    }
    return rows[0];
  });
  json(res, 201, row);
});

post("/v1/equipment/downtime/:id/end", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE equipment.downtime_events SET ended_at = $2 WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND ended_at IS NULL RETURNING *`,
      [ctx.params.id, body.ended_at ?? new Date().toISOString()]);
    const ev = rows[0] ?? null;
    if (ev) {
      const { rows: open } = await db.query(
        `SELECT count(*)::int AS c FROM equipment.downtime_events WHERE tenant_id = platform.current_tenant_id() AND equipment_id = $1 AND ended_at IS NULL`,
        [ev.equipment_id]);
      if (open[0].c === 0) {
        await db.query(`UPDATE equipment.assets SET status = 'idle', updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'fault'`, [ev.equipment_id]);
      }
    }
    return ev;
  });
  if (!row) return json(res, 409, { error: "downtime_open_event_not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 保养计划与保养记录 ─────────────────────────────────────────

post("/v1/equipment/maintenance-plans", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.equipment_id || !body.name || !Number(body.cycle_days)) return json(res, 400, { error: "equipment_id_name_cycle_days_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO equipment.maintenance_plans (id, tenant_id, equipment_id, name, cycle_days, next_due_at, description)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6) RETURNING *`,
      [uuid(), body.equipment_id, body.name, body.cycle_days,
       body.next_due_at ?? new Date(Date.now() + Number(body.cycle_days) * 86_400_000).toISOString().slice(0, 10),
       body.description ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// 执行保养：写记录 + 推进计划的下次到期日（可带停机分钟）
post("/v1/equipment/maintenance-plans/:id/perform", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM equipment.maintenance_plans WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [ctx.params.id]);
    const plan = rows[0] ?? null;
    if (!plan) return null;
    const performedAt = String(body.performed_at ?? new Date().toISOString().slice(0, 10));
    const { rows: recRows } = await db.query(
      `INSERT INTO equipment.maintenance_records (id, tenant_id, equipment_id, plan_id, performed_at, performed_by_person_id, cost_cents, downtime_minutes, note)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [uuid(), plan.equipment_id, plan.id, performedAt, body.performed_by_person_id ?? identity.personId,
       body.cost_cents ?? 0, body.downtime_minutes ?? 0, body.note ?? null]);
    await db.query(
      `UPDATE equipment.maintenance_plans SET last_performed_at = $2,
              next_due_at = $2::date + make_interval(days => $3::int), updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [plan.id, performedAt, plan.cycle_days]);
    if (Number(body.downtime_minutes ?? 0) > 0) {
      await db.query(
        `INSERT INTO equipment.downtime_events (id, tenant_id, equipment_id, downtime_type, reason_code, started_at, ended_at, note)
         VALUES (gen_random_uuid(), platform.current_tenant_id(), $1, 'planned', 'maintenance',
                 $2::timestamptz - make_interval(mins => $3::int), $2::timestamptz, '保养计划执行')`,
        [plan.equipment_id, new Date().toISOString(), body.downtime_minutes]);
    }
    return recRows[0];
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 201, row);
});

// ── OEE 可用率（近 30 天，按设备实时派生）─────────────────────

get("/v1/equipment/oee", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const windowMinutes = 30 * 24 * 60;
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT a.id, a.asset_code, a.name, a.status,
              coalesce(sum(EXTRACT(EPOCH FROM (coalesce(d.ended_at, now()) - d.started_at)) / 60.0) FILTER (WHERE d.downtime_type = 'unplanned'), 0)::numeric AS unplanned_minutes,
              coalesce(sum(EXTRACT(EPOCH FROM (coalesce(d.ended_at, now()) - d.started_at)) / 60.0), 0)::numeric AS total_downtime_minutes
       FROM equipment.assets a
       LEFT JOIN equipment.downtime_events d
         ON d.tenant_id = a.tenant_id AND d.equipment_id = a.id AND d.started_at > now() - interval '30 days'
       WHERE a.tenant_id = platform.current_tenant_id() AND a.status <> 'scrapped'
       GROUP BY a.id ORDER BY a.asset_code`
    );
    return rows.map(r => ({
      ...r,
      availability_pct: Math.max(0, Math.round((1 - Math.min(Number(r.total_downtime_minutes), windowMinutes) / windowMinutes) * 10000) / 100),
    }));
  });
  json(res, 200, { items: rows, window: "30d", note: "可用率=1-停机/日历；性能率与良品率需设备计数采集，当前以报工良率近似（/v1/mfg/kpis）" });
});

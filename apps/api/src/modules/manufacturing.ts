import { get, post, patch, json } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { readSession } from "../session.ts";
import { emitEvent } from "../outbox.ts";
import { applyStockMovement } from "../stock.ts";
import type { IncomingMessage } from "node:http";

// ═══════════════════════════════════════════════════════════════
// 制造执行域（P0）：零件主数据 / BOM / 工艺路线 / 生产工单 / 领料 / 报工 / 完工入库
// 制造 KPI 派生端点（P2a）也落在这里：全部指标从业务表实时聚合，不另存冗余。
// ═══════════════════════════════════════════════════════════════

function requireSession(req: IncomingMessage) {
  return readSession(req.headers.cookie);
}

// ── 零件主数据 ──────────────────────────────────────────────────

get("/v1/mfg/parts", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT p.*, (SELECT coalesce(sum(o.quantity),0) FROM stock.onhand o WHERE o.tenant_id = p.tenant_id AND o.part_id = p.id) AS stock_quantity
       FROM mfg.parts p
       WHERE p.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR p.kind = $1)
         AND ($2::text IS NULL OR p.status = $2)
         AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.part_number ILIKE '%' || $3 || '%')
       ORDER BY p.part_number LIMIT $4 OFFSET $5`,
      [q.kind ?? null, q.status ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/mfg/parts", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.part_number || !body.name) return json(res, 400, { error: "part_number_and_name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO mfg.parts
         (id, tenant_id, part_number, name, kind, uom, spec, safety_stock, standard_unit_cost_cents, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), body.part_number, body.name, body.kind ?? "product", body.uom ?? "PCS",
       body.spec ?? null, body.safety_stock ?? 0, body.standard_unit_cost_cents ?? 0, body.status ?? "active"]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/mfg/parts/:id", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","kind","uom","spec","safety_stock","standard_unit_cost_cents","status"];
  const sets: string[] = []; const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  sets.push("updated_at = now()");
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE mfg.parts SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`, vals);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── BOM 头/行 ──────────────────────────────────────────────────

post("/v1/mfg/parts/:id/boms", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const lines = Array.isArray(body.lines) ? body.lines as Record<string, unknown>[] : [];
  if (!lines.length) return json(res, 400, { error: "bom_lines_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO mfg.boms (id, tenant_id, product_part_id, version, status, effective_date, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, 'draft', $4, $5) RETURNING *`,
      [uuid(), ctx.params.id, body.version ?? "V1.0", body.effective_date ?? null, body.notes ?? null]
    );
    const bom = rows[0];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.child_part_id || !Number(l.quantity)) throw new Error("bom_line_needs_child_part_id_and_quantity");
      await db.query(
        `INSERT INTO mfg.bom_lines (id, tenant_id, bom_id, child_part_id, position_no, quantity, scrap_rate)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6)`,
        [uuid(), bom.id, l.child_part_id, l.position_no ?? i + 1, l.quantity, l.scrap_rate ?? 0]
      );
    }
    return bom;
  });
  json(res, 201, row);
});

get("/v1/mfg/boms/:id", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT b.*, p.part_number, p.name AS product_name FROM mfg.boms b
       JOIN mfg.parts p ON p.tenant_id = b.tenant_id AND p.id = b.product_part_id
       WHERE b.tenant_id = platform.current_tenant_id() AND b.id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const { rows: lineRows } = await db.query(
      `SELECT l.*, p.part_number, p.name, p.kind, p.uom FROM mfg.bom_lines l
       JOIN mfg.parts p ON p.tenant_id = l.tenant_id AND p.id = l.child_part_id
       WHERE l.tenant_id = platform.current_tenant_id() AND l.bom_id = $1 ORDER BY l.position_no NULLS LAST, l.created_at`, [ctx.params.id]);
    return { ...header, lines: lineRows };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

post("/v1/mfg/boms/:id/release", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE mfg.boms SET status = 'released', effective_date = coalesce(effective_date, current_date), updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'draft' RETURNING *`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "bom_not_draft_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 工艺路线头/工序 ────────────────────────────────────────────

post("/v1/mfg/parts/:id/routings", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const ops = Array.isArray(body.ops) ? body.ops as Record<string, unknown>[] : [];
  if (!ops.length) return json(res, 400, { error: "routing_ops_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO mfg.routings (id, tenant_id, product_part_id, version, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, 'draft') RETURNING *`,
      [uuid(), ctx.params.id, body.version ?? "V1.0"]
    );
    const routing = rows[0];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (!o.name) throw new Error("routing_op_needs_name");
      await db.query(
        `INSERT INTO mfg.routing_ops (id, tenant_id, routing_id, seq_no, operation_no, name, work_center, standard_hours, inspect)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8)`,
        [uuid(), routing.id, o.seq_no ?? (i + 1) * 10, o.operation_no ?? String((i + 1) * 10),
         o.name, o.work_center ?? null, o.standard_hours ?? 0, o.inspect ?? false]
      );
    }
    return routing;
  });
  json(res, 201, row);
});

get("/v1/mfg/routings/:id", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT r.*, p.part_number, p.name AS product_name FROM mfg.routings r
       JOIN mfg.parts p ON p.tenant_id = r.tenant_id AND p.id = r.product_part_id
       WHERE r.tenant_id = platform.current_tenant_id() AND r.id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const { rows: opRows } = await db.query(
      `SELECT * FROM mfg.routing_ops WHERE tenant_id = platform.current_tenant_id() AND routing_id = $1 ORDER BY seq_no`, [ctx.params.id]);
    return { ...header, ops: opRows };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

post("/v1/mfg/routings/:id/release", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE mfg.routings SET status = 'released', updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'draft' RETURNING *`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "routing_not_draft_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 生产工单 ───────────────────────────────────────────────────

get("/v1/mfg/work-orders", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT w.*, p.part_number, p.name AS product_name
       FROM mfg.work_orders w JOIN mfg.parts p ON p.tenant_id = w.tenant_id AND p.id = w.product_part_id
       WHERE w.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR w.status = $1)
         AND ($2::uuid IS NULL OR w.product_part_id = $2)
         AND ($3::text IS NULL OR w.wo_number ILIKE '%' || $3 || '%')
       ORDER BY w.created_at DESC LIMIT $4 OFFSET $5`,
      [q.status ?? null, q.product_part_id ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/mfg/work-orders", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.product_part_id || !Number(body.planned_qty)) return json(res, 400, { error: "product_part_id_and_planned_qty_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    // 缺省引用最新已发布 BOM / 工艺路线
    let bomId = body.bom_id ?? null;
    let routingId = body.routing_id ?? null;
    if (!bomId) {
      const { rows } = await db.query(
        `SELECT id FROM mfg.boms WHERE tenant_id = platform.current_tenant_id() AND product_part_id = $1 AND status = 'released'
         ORDER BY effective_date DESC NULLS LAST, created_at DESC LIMIT 1`, [body.product_part_id]);
      bomId = rows[0]?.id ?? null;
    }
    if (!routingId) {
      const { rows } = await db.query(
        `SELECT id FROM mfg.routings WHERE tenant_id = platform.current_tenant_id() AND product_part_id = $1 AND status = 'released'
         ORDER BY created_at DESC LIMIT 1`, [body.product_part_id]);
      routingId = rows[0]?.id ?? null;
    }
    const woNumber = `WO-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO mfg.work_orders
         (id, tenant_id, wo_number, product_part_id, project_id, bom_id, routing_id, planned_qty, priority, planned_start, planned_finish, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [uuid(), woNumber, body.product_part_id, body.project_id ?? null, bomId, routingId,
       body.planned_qty, body.priority ?? "medium", body.planned_start ?? null, body.planned_finish ?? null, body.notes ?? null]
    );
    // 允许先建工单、后补 BOM/工艺路线（中小企业常见：先排产，工艺卡随后下达）。
    // 有已发布版本时自动引用，没有则留空，后续可通过 PATCH 补。
    await emitEvent(db, identity.tenantId, {
      eventType: "mfg.work_order.created.v1", aggregateType: "mfg.work_orders", aggregateId: rows[0].id,
      actorId: identity.personId, traceId: ctx.traceId,
      payload: { wo_number: rows[0].wo_number, product_part_id: bomId ? body.product_part_id : null, planned_qty: rows[0].planned_qty },
    });
    return rows[0];
  });
  json(res, 201, row);
});

get("/v1/mfg/work-orders/:id", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT w.*, p.part_number, p.name AS product_name,
              (SELECT count(*) FROM mfg.work_reports r WHERE r.tenant_id = w.tenant_id AND r.work_order_id = w.id) AS report_count
       FROM mfg.work_orders w JOIN mfg.parts p ON p.tenant_id = w.tenant_id AND p.id = w.product_part_id
       WHERE w.tenant_id = platform.current_tenant_id() AND w.id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const [ops, reports, cost] = await Promise.all([
      db.query(`SELECT o.*, (SELECT count(*) FROM mfg.work_reports r WHERE r.tenant_id = o.tenant_id AND r.work_order_op_id = o.id) AS report_count
                FROM mfg.work_order_ops o WHERE o.tenant_id = platform.current_tenant_id() AND o.work_order_id = $1 ORDER BY seq_no`, [header.id]),
      db.query(`SELECT r.*, pe.display_name AS person_name FROM mfg.work_reports r
                LEFT JOIN platform.people pe ON pe.tenant_id = r.tenant_id AND pe.id = r.person_id
                WHERE r.tenant_id = platform.current_tenant_id() AND r.work_order_id = $1 ORDER BY r.reported_at`, [header.id]),
      db.query(`SELECT * FROM mfg.work_order_costs WHERE tenant_id = platform.current_tenant_id() AND work_order_id = $1`, [header.id]),
    ]);
    return { ...header, ops: ops.rows, reports: reports.rows, cost: cost.rows[0] ?? null };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

// 下达：快照已发布工艺路线到工单工序
post("/v1/mfg/work-orders/:id/release", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE mfg.work_orders SET status = 'released', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'created' RETURNING *`, [ctx.params.id]);
    const wo = rows[0] ?? null;
    if (!wo) return null;
    // 有已发布工艺路线时生成工序；没有也允许下达，后续补工艺卡后仍可报工。
    const ops: Array<Record<string, unknown>> = [];
    if (wo.routing_id) {
      const { rows } = await db.query(
        `SELECT * FROM mfg.routing_ops WHERE tenant_id = platform.current_tenant_id() AND routing_id = $1 ORDER BY seq_no`, [wo.routing_id]);
      ops.push(...rows);
      for (const o of ops) {
        await db.query(
          `INSERT INTO mfg.work_order_ops
             (id, tenant_id, work_order_id, seq_no, operation_no, name, work_center, standard_hours, inspect)
           VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, work_order_id, seq_no) DO NOTHING`,
          [uuid(), wo.id, o.seq_no, o.operation_no, o.name, o.work_center, o.standard_hours, o.inspect]);
      }
    }
    if (ops.length === 0) {
      // 无工艺路线时生成一个默认"生产"工序，保证报工/完工闭环仍可走通。
      await db.query(
        `INSERT INTO mfg.work_order_ops
           (id, tenant_id, work_order_id, seq_no, operation_no, name, standard_hours, inspect)
         VALUES ($1, platform.current_tenant_id(), $2, 1, 'OP-1', '生产', 0, false)
         ON CONFLICT (tenant_id, work_order_id, seq_no) DO NOTHING`,
        [uuid(), wo.id]
      );
    }
    await emitEvent(db, identity.tenantId, {
      eventType: "mfg.work_order.released.v1", aggregateType: "mfg.work_orders", aggregateId: wo.id,
      actorId: identity.personId, traceId: ctx.traceId,
      payload: { wo_number: wo.wo_number, ops: ops.length },
    });
    return wo;
  });
  if (!result) return json(res, 409, { error: "work_order_not_created_or_missing", traceId: ctx.traceId });
  json(res, 200, result);
});

// 领料：按已发布 BOM × 计划数量(含损耗) 从库存出库，流水引用工单
post("/v1/mfg/work-orders/:id/issue-materials", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const warehouse = String(body.warehouse ?? "MAIN");
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM mfg.work_orders WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [ctx.params.id]);
    const wo = rows[0] ?? null;
    if (!wo) return null;
    if (!["released", "in_progress"].includes(wo.status)) throw new Error(`work_order_status_not_issueable:${wo.status}`);
    if (wo.materialized) throw new Error("materials_already_issued");
    if (!wo.bom_id) throw new Error("work_order_has_no_bom");
    const { rows: lines } = await db.query(
      `SELECT l.*, p.part_number, p.standard_unit_cost_cents FROM mfg.bom_lines l
       JOIN mfg.parts p ON p.tenant_id = l.tenant_id AND p.id = l.child_part_id
       WHERE l.tenant_id = platform.current_tenant_id() AND l.bom_id = $1`, [wo.bom_id]);
    const issued: Record<string, unknown>[] = [];
    for (const l of lines) {
      const need = Number(l.quantity) * (1 + Number(l.scrap_rate)) * Number(wo.planned_qty);
      const needRounded = Math.ceil(need * 10000) / 10000;
      await applyStockMovement(db, {
        partId: l.child_part_id, warehouse, direction: "out", movementType: "production_issue",
        quantity: needRounded, unitCostCents: Number(l.standard_unit_cost_cents),
        referenceType: "mfg.work_orders", referenceId: wo.id, personId: identity.personId,
        note: `工单 ${wo.wo_number} 领料`,
      });
      issued.push({ part_id: l.child_part_id, part_number: l.part_number, quantity: needRounded, unit_cost_cents: l.standard_unit_cost_cents });
    }
    await db.query(
      `UPDATE mfg.work_orders SET materialized = true, status = 'in_progress', updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [wo.id]);
    return { wo, issued };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { work_order_id: result.wo.id, materialized: true, issued: result.issued });
});

// 报工：按工序记录合格/报废数量与工时
post("/v1/mfg/work-orders/:id/report", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const qtyGood = Number(body.qty_good ?? 0);
  const qtyScrap = Number(body.qty_scrap ?? 0);
  if (qtyGood <= 0 && qtyScrap <= 0) return json(res, 400, { error: "qty_good_or_qty_scrap_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows: woRows } = await db.query(
      `SELECT * FROM mfg.work_orders WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [ctx.params.id]);
    const wo = woRows[0] ?? null;
    if (!wo) return null;
    if (!["released", "in_progress"].includes(wo.status)) throw new Error(`work_order_not_reportable:${wo.status}`);
    let opId = body.work_order_op_id ?? null;
    if (!opId && body.seq_no != null) {
      const { rows } = await db.query(
        `SELECT id FROM mfg.work_order_ops WHERE tenant_id = platform.current_tenant_id() AND work_order_id = $1 AND seq_no = $2`,
        [wo.id, body.seq_no]);
      opId = rows[0]?.id ?? null;
    }
    if (!opId) {
      // 默认报第一道工序，避免简单工单必须知道工序 ID。
      const { rows } = await db.query(
        `SELECT id FROM mfg.work_order_ops WHERE tenant_id = platform.current_tenant_id() AND work_order_id = $1 ORDER BY seq_no LIMIT 1`,
        [wo.id]);
      opId = rows[0]?.id ?? null;
    }
    if (!opId) throw new Error("work_order_op_not_found:提供 work_order_op_id 或 seq_no");
    const { rows: opRows } = await db.query(
      `SELECT * FROM mfg.work_order_ops WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [opId]);
    const op = opRows[0] ?? null;
    if (!op || op.work_order_id !== wo.id) throw new Error("work_order_op_not_found");
    const report = (await db.query(
      `INSERT INTO mfg.work_reports (id, tenant_id, work_order_id, work_order_op_id, person_id, qty_good, qty_scrap, hours_logged, note)
       VALUES (gen_random_uuid(), platform.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [wo.id, opId, body.person_id ?? identity.personId, qtyGood, qtyScrap, Number(body.hours_logged ?? 0), body.note ?? null]
    )).rows[0];
    const newReported = Number(op.qty_reported) + qtyGood + qtyScrap;
    const newGood = Number(op.qty_good) + qtyGood;
    const newScrap = Number(op.qty_scrap) + qtyScrap;
    const opDone = newReported >= Number(wo.planned_qty);
    await db.query(
      `UPDATE mfg.work_order_ops SET qty_reported = $2, qty_good = $3, qty_scrap = $4, status = $5, updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [opId, newReported, newGood, newScrap, opDone ? "done" : "in_progress"]);
    if (wo.status === "released") {
      await db.query(`UPDATE mfg.work_orders SET status = 'in_progress', updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [wo.id]);
    }
    // 工序含检验点且出现报废 → 自动挂过程检（QMS 与工单联动）
    if (op.inspect && qtyScrap > 0) {
      await db.query(
        `INSERT INTO qms.inspections (id, tenant_id, inspection_number, inspection_type, part_id, work_order_id, total_quantity, sample_quantity, result, note)
         VALUES (gen_random_uuid(), platform.current_tenant_id(), 'QC-' || upper(substr(md5(random()::text), 1, 10)), 'in_process',
                 $1, $2, $3, 0, 'pending', '报工报废自动触发过程检')`,
        [wo.product_part_id, wo.id, qtyScrap]);
    }
    return { report, opDone, wo };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 201, { report: result.report, op_done: result.opDone });
});

// 完工：末道工序合格数进入成品库存，同时归集工单成本（料/工/费，P1-8）
post("/v1/mfg/work-orders/:id/complete", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const warehouse = String(body.warehouse ?? "MAIN");
  const hourlyRate = Number(body.hourly_rate_cents ?? 6000);      // 工时费率，默认 ¥60/小时
  const overheadRate = Number(body.overhead_rate ?? 0.3);         // 制造费用率（按人工的 30%）
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM mfg.work_orders WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [ctx.params.id]);
    const wo = rows[0] ?? null;
    if (!wo) return null;
    if (!["in_progress", "released"].includes(wo.status)) throw new Error(`work_order_not_completable:${wo.status}`);
    const { rows: ops } = await db.query(
      `SELECT * FROM mfg.work_order_ops WHERE tenant_id = platform.current_tenant_id() AND work_order_id = $1 ORDER BY seq_no`, [wo.id]);
    if (!ops.length) throw new Error("work_order_has_no_ops");
    const lastOp = ops[ops.length - 1];
    const completedQty = Number(lastOp.qty_good);
    if (completedQty <= 0 && body.allow_zero !== true) throw new Error("nothing_to_complete:末道工序合格数为 0");
    if (completedQty <= 0) {
      await db.query(
        `UPDATE mfg.work_orders SET status = 'completed', actual_finish = now(), updated_at = now(), version = version + 1
         WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [wo.id]);
      return { wo, completedQty: 0, cost: null };
    }
    // 成本：料 = 本工单领料流水加总；工 = 报工工时 × 费率；费 = 人工 × 费率
    const { rows: mat } = await db.query(
      `SELECT coalesce(sum(quantity * unit_cost_cents), 0)::numeric AS material_cents, count(*)::int AS lines
       FROM stock.movements WHERE tenant_id = platform.current_tenant_id()
         AND movement_type = 'production_issue' AND reference_type = 'mfg.work_orders' AND reference_id = $1`, [wo.id]);
    const materialCents = Math.round(Number(mat[0].material_cents) / Number(wo.planned_qty) * completedQty); // 按完工/计划比例分摊投料
    const { rows: hrs } = await db.query(
      `SELECT coalesce(sum(hours_logged), 0)::numeric AS hours FROM mfg.work_reports WHERE tenant_id = platform.current_tenant_id() AND work_order_id = $1`, [wo.id]);
    const laborCents = Math.round(Number(hrs[0].hours) * hourlyRate);
    const overheadCents = Math.round(laborCents * overheadRate);
    const totalCents = materialCents + laborCents + overheadCents;
    const unitCost = Math.round((totalCents / completedQty) * 100) / 100;
    await db.query(
      `INSERT INTO mfg.work_order_costs (id, tenant_id, work_order_id, material_cents, labor_cents, overhead_cents, total_cents, unit_cost_cents, breakdown)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, work_order_id) DO UPDATE SET
         material_cents = $3, labor_cents = $4, overhead_cents = $5, total_cents = $6, unit_cost_cents = $7, breakdown = $8, computed_at = now()`,
      [uuid(), wo.id, materialCents, laborCents, overheadCents, totalCents, unitCost,
       JSON.stringify({ material_lines: mat[0].lines, hours: hrs[0].hours, hourly_rate_cents: hourlyRate, overhead_rate: overheadRate })]);
    await applyStockMovement(db, {
      partId: wo.product_part_id, warehouse, direction: "in", movementType: "production_receipt",
      quantity: completedQty, unitCostCents: Math.round(unitCost),
      referenceType: "mfg.work_orders", referenceId: wo.id, personId: identity.personId,
      note: `工单 ${wo.wo_number} 完工入库`,
    });
    await db.query(
      `UPDATE mfg.work_orders SET status = 'completed', completed_qty = $2, actual_finish = now(), updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [wo.id, completedQty]);
    await emitEvent(db, identity.tenantId, {
      eventType: "mfg.work_order.completed.v1", aggregateType: "mfg.work_orders", aggregateId: wo.id,
      actorId: identity.personId, traceId: ctx.traceId,
      payload: { wo_number: wo.wo_number, completed_qty: completedQty, total_cost_cents: totalCents, unit_cost_cents: unitCost },
    });
    const { rows: costRows } = await db.query(
      `SELECT * FROM mfg.work_order_costs WHERE tenant_id = platform.current_tenant_id() AND work_order_id = $1`, [wo.id]);
    return { wo, completedQty, cost: costRows[0] };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, {
    work_order_id: result.wo.id, status: "completed", completed_qty: result.completedQty, cost: result.cost,
  });
});

// ── 库存可见性（P0）──────────────────────────────────────────

get("/v1/stock/onhand", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT o.*, p.part_number, p.name, p.uom, p.safety_stock FROM stock.onhand o
       JOIN mfg.parts p ON p.tenant_id = o.tenant_id AND p.id = o.part_id
       WHERE o.tenant_id = platform.current_tenant_id() AND ($1::uuid IS NULL OR o.part_id = $1)
       ORDER BY p.part_number LIMIT $2 OFFSET $3`,
      [q.part_id ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

get("/v1/stock/movements", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT m.*, p.part_number, p.name FROM stock.movements m
       JOIN mfg.parts p ON p.tenant_id = m.tenant_id AND p.id = m.part_id
       WHERE m.tenant_id = platform.current_tenant_id()
         AND ($1::uuid IS NULL OR m.part_id = $1)
         AND ($2::text IS NULL OR m.movement_type = $2)
       ORDER BY m.created_at DESC LIMIT $3 OFFSET $4`,
      [q.part_id ?? null, q.movement_type ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

// ── 制造 KPI 实时派生（P2a）：良率 / 准交 OTD / 在制 WIP / 库存周转 / OEE 可用率 ──

get("/v1/mfg/kpis", async (req, res, ctx) => {
  const identity = requireSession(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const kpis = await withTenant(identity, async (db) => {
    const [yieldRow, otdRow, wipRow, turnRow, oeeRow] = await Promise.all([
      db.query(
        `SELECT coalesce(sum(qty_good),0)::numeric AS good, coalesce(sum(qty_scrap),0)::numeric AS scrap
         FROM mfg.work_reports WHERE tenant_id = platform.current_tenant_id()`),
      db.query(
        `SELECT count(*) FILTER (WHERE actual_finish::date <= planned_finish)::int AS on_time,
                count(*) FILTER (WHERE status = 'completed' AND planned_finish IS NOT NULL)::int AS finished_planned
         FROM mfg.work_orders WHERE tenant_id = platform.current_tenant_id()`),
      db.query(
        `SELECT count(*)::int AS open_orders, coalesce(sum(planned_qty - completed_qty),0)::numeric AS wip_qty
         FROM mfg.work_orders WHERE tenant_id = platform.current_tenant_id() AND status IN ('released','in_progress')`),
      db.query(
        `SELECT coalesce(sum(m.quantity) FILTER (WHERE m.direction = 'out' AND m.created_at > now() - interval '90 days'), 0)::numeric AS out_90d,
                (SELECT coalesce(sum(quantity),0) FROM stock.onhand WHERE tenant_id = platform.current_tenant_id())::numeric AS onhand
         FROM stock.movements m WHERE m.tenant_id = platform.current_tenant_id()`),
      db.query(
        `SELECT count(*)::int AS assets,
                coalesce(sum(EXTRACT(EPOCH FROM (coalesce(e.ended_at, now()) - e.started_at)) / 3600.0), 0)::numeric AS downtime_hours
         FROM equipment.downtime_events e
         WHERE e.tenant_id = platform.current_tenant_id() AND e.started_at > now() - interval '30 days'
           AND e.downtime_type = 'unplanned'`),
    ]);
    const good = Number(yieldRow.rows[0].good);
    const scrap = Number(yieldRow.rows[0].scrap);
    const onTime = Number(otdRow.rows[0].on_time);
    const finishedPlanned = Number(otdRow.rows[0].finished_planned);
    const out90d = Number(turnRow.rows[0].out_90d);
    const onhand = Number(turnRow.rows[0].onhand);
    const downtimeHours = Number(oeeRow.rows[0].downtime_hours);
    const windowHours = 24 * 30;
    return {
      quality_yield_pct: good + scrap > 0 ? Math.round(good / (good + scrap) * 10000) / 100 : null,
      otd_pct: finishedPlanned > 0 ? Math.round(onTime / finishedPlanned * 10000) / 100 : null,
      wip: { open_orders: Number(wipRow.rows[0].open_orders), wip_qty: Number(wipRow.rows[0].wip_qty) },
      inventory_turnover_90d: onhand > 0 ? Math.round(out90d / onhand * 100) / 100 : null,
      equipment_availability_pct: Math.round((1 - Math.min(downtimeHours, windowHours) / windowHours) * 10000) / 100,
      window: { oee_days: 30, turnover_days: 90 },
      generated_at: new Date().toISOString(),
    };
  });
  json(res, 200, kpis);
});

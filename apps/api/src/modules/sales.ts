import { get, post, json } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { readSession } from "../session.ts";
import { emitEvent } from "../outbox.ts";
import { applyStockMovement } from "../stock.ts";
import type { IncomingMessage } from "node:http";

// ═══════════════════════════════════════════════════════════════
// 销售域（P1-8）：销售订单 SO（引用 CRM 客户/商机）、发货出库（库存 sales_issue 出）、
// 毛利 = 订单行收入 vs 完工工单加权单位成本（成本来自 manufacturing 完工归集）。
// ═══════════════════════════════════════════════════════════════

function sess(req: IncomingMessage) { return readSession(req.headers.cookie); }

get("/v1/sales/orders", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT o.*, a.name AS account_name FROM sales.orders o
       JOIN crm.accounts a ON a.tenant_id = o.tenant_id AND a.id = o.account_id
       WHERE o.tenant_id = platform.current_tenant_id() AND ($1::text IS NULL OR o.status = $1)
       ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

get("/v1/sales/orders/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT o.*, a.name AS account_name FROM sales.orders o
       JOIN crm.accounts a ON a.tenant_id = o.tenant_id AND a.id = o.account_id
       WHERE o.tenant_id = platform.current_tenant_id() AND o.id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const { rows: lines } = await db.query(
      `SELECT l.*, p.part_number, p.name, p.uom FROM sales.order_lines l
       JOIN mfg.parts p ON p.tenant_id = l.tenant_id AND p.id = l.part_id
       WHERE l.tenant_id = platform.current_tenant_id() AND l.order_id = $1 ORDER BY l.created_at`, [header.id]);
    const { rows: shipments } = await db.query(
      `SELECT * FROM sales.shipments WHERE tenant_id = platform.current_tenant_id() AND order_id = $1 ORDER BY shipped_at`, [header.id]);
    return { ...header, lines, shipments };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

post("/v1/sales/orders", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const lines = Array.isArray(body.lines) ? body.lines as Record<string, unknown>[] : [];
  if (!body.account_id || !lines.length) return json(res, 400, { error: "account_id_and_lines_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const soNumber = `SO-${Date.now().toString(36).toUpperCase()}`;
    let total = 0;
    for (const l of lines) {
      if (!l.part_id || !Number(l.quantity) || l.unit_price_cents == null) throw new Error("so_line_needs_part_id_quantity_unit_price");
      total += Math.round(Number(l.quantity) * Number(l.unit_price_cents));
    }
    const { rows } = await db.query(
      `INSERT INTO sales.orders (id, tenant_id, so_number, account_id, opportunity_id, project_id, order_date, requested_delivery_date, total_amount_cents, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), soNumber, body.account_id, body.opportunity_id ?? null, body.project_id ?? null,
       body.order_date ?? new Date().toISOString().slice(0, 10), body.requested_delivery_date ?? null, total, body.notes ?? null]
    );
    const so = rows[0];
    for (const l of lines) {
      await db.query(
        `INSERT INTO sales.order_lines (id, tenant_id, order_id, part_id, quantity, unit_price_cents, amount_cents)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6)`,
        [uuid(), so.id, l.part_id, l.quantity, l.unit_price_cents, Math.round(Number(l.quantity) * Number(l.unit_price_cents))]);
    }
    return so;
  });
  json(res, 201, row);
});

post("/v1/sales/orders/:id/confirm", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE sales.orders SET status = 'confirmed', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'draft' RETURNING *`, [ctx.params.id]);
    const so = rows[0] ?? null;
    if (so) {
      await emitEvent(db, identity.tenantId, {
        eventType: "sales.order.confirmed.v1", aggregateType: "sales.orders", aggregateId: so.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { so_number: so.so_number, account_id: so.account_id, total_amount_cents: so.total_amount_cents },
      });
    }
    return so;
  });
  if (!row) return json(res, 409, { error: "so_not_draft_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// 发货出库：扣减成品库存（不足即整单失败），回写行已发量与订单状态
post("/v1/sales/orders/:id/shipments", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const lines = Array.isArray(body.lines) ? body.lines as Record<string, unknown>[] : [];
  if (!lines.length) return json(res, 400, { error: "shipment_lines_required", traceId: ctx.traceId });
  const warehouse = String(body.warehouse ?? "MAIN");
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM sales.orders WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [ctx.params.id]);
    const so = rows[0] ?? null;
    if (!so) return null;
    if (!["confirmed", "in_production", "ready_to_ship", "partial_shipped"].includes(so.status)) throw new Error(`so_not_shippable:${so.status}`);
    const shipmentNumber = `SHP-${Date.now().toString(36).toUpperCase()}`;
    const { rows: shpRows } = await db.query(
      `INSERT INTO sales.shipments (id, tenant_id, shipment_number, order_id, carrier, tracking_no, receiver, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7) RETURNING *`,
      [uuid(), shipmentNumber, so.id, body.carrier ?? null, body.tracking_no ?? null, body.receiver ?? null, body.notes ?? null]
    );
    const shipment = shpRows[0];
    for (const l of lines) {
      if (!l.order_line_id || !Number(l.quantity)) throw new Error("shipment_line_needs_order_line_id_and_quantity");
      const { rows: lineRows } = await db.query(
        `SELECT * FROM sales.order_lines WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [l.order_line_id]);
      const ol = lineRows[0];
      if (!ol || ol.order_id !== so.id) throw new Error(`order_line_not_found:${l.order_line_id}`);
      if (Number(ol.shipped_quantity) + Number(l.quantity) > Number(ol.quantity)) throw new Error(`over_shipment_not_allowed:${ol.shipped_quantity}/${ol.quantity}`);
      const { rows: pc } = await db.query(
        `SELECT standard_unit_cost_cents FROM mfg.parts WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ol.part_id]);
      await applyStockMovement(db, {
        partId: ol.part_id, warehouse, direction: "out", movementType: "sales_issue",
        quantity: Number(l.quantity), unitCostCents: Number(pc[0]?.standard_unit_cost_cents ?? 0),
        referenceType: "sales.shipments", referenceId: shipment.id, personId: identity.personId,
        note: `销售发货 ${shipment.shipment_number}`,
      });
      await db.query(
        `UPDATE sales.order_lines SET shipped_quantity = shipped_quantity + $2::numeric, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
        [ol.id, l.quantity]);
      await db.query(
        `INSERT INTO sales.shipment_lines (id, tenant_id, shipment_id, order_line_id, part_id, quantity)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5)`,
        [uuid(), shipment.id, ol.id, ol.part_id, l.quantity]);
    }
    const { rows: checkRows } = await db.query(
      `SELECT count(*) FILTER (WHERE shipped_quantity < quantity)::int AS open_lines FROM sales.order_lines
       WHERE tenant_id = platform.current_tenant_id() AND order_id = $1`, [so.id]);
    const newStatus = checkRows[0].open_lines === 0 ? "shipped" : "partial_shipped";
    await db.query(`UPDATE sales.orders SET status = $2, updated_at = now(), version = version + 1 WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [so.id, newStatus]);
    await emitEvent(db, identity.tenantId, {
      eventType: "sales.shipment.created.v1", aggregateType: "sales.shipments", aggregateId: shipment.id,
      actorId: identity.personId, traceId: ctx.traceId,
      idempotencyKey: `sales.shipments:${shipment.id}:created`,
      payload: { shipment_number: shipment.shipment_number, so_number: so.so_number },
    });
    return { shipment, soStatus: newStatus };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 201, result.shipment);
});

// 毛利：行收入 −（完工工单加权单位成本 × 数量）。无完工成本的料号 cost 记 0 并标注。
get("/v1/sales/orders/:id/margin", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT o.so_number, o.status FROM sales.orders o WHERE o.tenant_id = platform.current_tenant_id() AND o.id = $1`, [ctx.params.id]);
    const so = rows[0] ?? null;
    if (!so) return null;
    const { rows: lines } = await db.query(
      `SELECT l.*, p.part_number, p.name,
              (SELECT coalesce(sum(woc.total_cents) / nullif(sum(w.completed_qty), 0), 0)::numeric
               FROM mfg.work_order_costs woc
               JOIN mfg.work_orders w ON w.tenant_id = woc.tenant_id AND w.id = woc.work_order_id
               WHERE woc.tenant_id = l.tenant_id AND w.product_part_id = l.part_id AND w.status = 'completed') AS avg_unit_cost_cents,
              (SELECT count(*) FROM mfg.work_orders w WHERE w.tenant_id = l.tenant_id AND w.product_part_id = l.part_id AND w.status = 'completed')::int AS completed_wo_count
       FROM sales.order_lines l JOIN mfg.parts p ON p.tenant_id = l.tenant_id AND p.id = l.part_id
       WHERE l.tenant_id = platform.current_tenant_id() AND l.order_id = $1 ORDER BY l.created_at`, [ctx.params.id]);
    let revenue = 0; let cost = 0;
    const items = lines.map(l => {
      const lineRevenue = Number(l.amount_cents);
      const lineCost = Math.round(Number(l.avg_unit_cost_cents) * Number(l.quantity));
      revenue += lineRevenue; cost += lineCost;
      return {
        part_number: l.part_number, name: l.name, quantity: l.quantity,
        revenue_cents: lineRevenue, cost_cents: lineCost, cost_known: Number(l.completed_wo_count) > 0,
        margin_cents: lineRevenue - lineCost,
        margin_pct: lineRevenue > 0 ? Math.round((lineRevenue - lineCost) / lineRevenue * 10000) / 100 : null,
      };
    });
    return {
      so_number: so.so_number, status: so.status, items,
      totals: {
        revenue_cents: revenue, cost_cents: cost, margin_cents: revenue - cost,
        margin_pct: revenue > 0 ? Math.round((revenue - cost) / revenue * 10000) / 100 : null,
      },
    };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

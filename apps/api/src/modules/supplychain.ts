import { get, post, patch, json } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { readSession } from "../session.ts";
import { emitEvent } from "../outbox.ts";
import { resolveRowScope } from "../data-domain.ts";
import type { IncomingMessage } from "node:http";

// ═══════════════════════════════════════════════════════════════
// 供应链域（P0）：供应商 / 请购 PR / 采购订单 PO / 收货 / 供应商发票三单匹配 → 应付
// 收货本身不加库存；库存增加发生在来料检验判定合格时（quality.ts 裁决回写）。
// ═══════════════════════════════════════════════════════════════

function sess(req: IncomingMessage) { return readSession(req.headers.cookie); }

// ── 供应商 ─────────────────────────────────────────────────────

get("/v1/purchase/suppliers", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM purchase.suppliers
       WHERE tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR supplier_code ILIKE '%' || $2 || '%')
       ORDER BY supplier_code LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/purchase/suppliers", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const code = (body.supplier_code as string) ?? `SUP-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO purchase.suppliers
         (id, tenant_id, supplier_code, name, contact_person, contact_phone, email, payment_terms, lead_time_days, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), code, body.name, body.contact_person ?? null, body.contact_phone ?? null,
       body.email ?? null, body.payment_terms ?? null, body.lead_time_days ?? 0, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ── 请购单 PR ──────────────────────────────────────────────────
// 状态机：draft → submitted → approved/rejected；approved → converted(转PO)。

get("/v1/purchase/requisitions", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    // P2c 行级数据域：普通员工仅见本人请购/无归属 PR；特权岗位/admin 不过滤
    const { sqlParam } = await resolveRowScope(db, identity);
    const { rows } = await db.query(
      `SELECT r.*, pe.display_name AS requester_name FROM purchase.requisitions r
       LEFT JOIN platform.people pe ON pe.tenant_id = r.tenant_id AND pe.id = r.requester_person_id
       WHERE r.tenant_id = platform.current_tenant_id() AND ($1::text IS NULL OR r.status = $1)
         AND ($4::uuid IS NULL OR r.requester_person_id IS NULL OR r.requester_person_id = $4)
       ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, limit, offset, sqlParam]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

get("/v1/purchase/requisitions/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM purchase.requisitions WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const { rows: lineRows } = await db.query(
      `SELECT l.*, p.part_number, p.name FROM purchase.requisition_lines l
       JOIN mfg.parts p ON p.tenant_id = l.tenant_id AND p.id = l.part_id
       WHERE l.tenant_id = platform.current_tenant_id() AND l.requisition_id = $1 ORDER BY l.created_at`, [header.id]);
    return { ...header, lines: lineRows };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

post("/v1/purchase/requisitions", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const lines = Array.isArray(body.lines) ? body.lines as Record<string, unknown>[] : [];
  if (!lines.length) return json(res, 400, { error: "requisition_lines_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const prNumber = `PR-${Date.now().toString(36).toUpperCase()}`;
    let total = 0;
    for (const l of lines) {
      if (!l.part_id || !Number(l.quantity)) throw new Error("requisition_line_needs_part_id_and_quantity");
      total += Math.round(Number(l.quantity) * Number(l.expected_unit_price_cents ?? 0));
    }
    const { rows } = await db.query(
      `INSERT INTO purchase.requisitions (id, tenant_id, pr_number, requester_person_id, need_date, status, reason, total_amount_cents, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, 'draft', $5, $6, $7) RETURNING *`,
      [uuid(), prNumber, body.requester_person_id ?? identity.personId, body.need_date ?? null,
       body.reason ?? null, total, body.notes ?? null]
    );
    const pr = rows[0];
    for (const l of lines) {
      await db.query(
        `INSERT INTO purchase.requisition_lines (id, tenant_id, requisition_id, part_id, quantity, expected_unit_price_cents, note)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6)`,
        [uuid(), pr.id, l.part_id, l.quantity, l.expected_unit_price_cents ?? 0, l.note ?? null]);
    }
    return pr;
  });
  json(res, 201, row);
});

// PR 状态流转：submit / approve / reject（审批留痕在 API 层，状态机在 DB CHECK 约束）
post("/v1/purchase/requisitions/:id/submit", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE purchase.requisitions SET status = 'submitted', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'draft' RETURNING *`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "pr_not_draft_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

post("/v1/purchase/requisitions/:id/approve", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const current = await db.query(
      `SELECT requester_person_id FROM purchase.requisitions
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'submitted'`,
      [ctx.params.id]
    );
    if (!current.rows[0]) return null;
    // 四眼原则：申请人不能批准自己的请购单
    if (current.rows[0].requester_person_id === identity.personId) throw new Error("self_approval_forbidden");
    const { rows } = await db.query(
      `UPDATE purchase.requisitions SET status = 'approved', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'submitted' RETURNING *`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "pr_not_submitted_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

post("/v1/purchase/requisitions/:id/reject", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const current = await db.query(
      `SELECT requester_person_id FROM purchase.requisitions
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'submitted'`,
      [ctx.params.id]
    );
    if (!current.rows[0]) return null;
    if (current.rows[0].requester_person_id === identity.personId) throw new Error("self_approval_forbidden");
    const { rows } = await db.query(
      `UPDATE purchase.requisitions SET status = 'rejected', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'submitted' RETURNING *`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "pr_not_submitted_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// PR 转 PO（带入预计单价；转后 PR 终结为 converted）
post("/v1/purchase/requisitions/:id/convert", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.supplier_id) return json(res, 400, { error: "supplier_id_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE purchase.requisitions SET status = 'converted', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'approved' RETURNING *`, [ctx.params.id]);
    const pr = rows[0] ?? null;
    if (!pr) throw new Error("pr_not_approved_or_missing");
    const { rows: lines } = await db.query(
      `SELECT * FROM purchase.requisition_lines WHERE tenant_id = platform.current_tenant_id() AND requisition_id = $1`, [pr.id]);
    const poNumber = `PO-${Date.now().toString(36).toUpperCase()}`;
    let total = 0;
    for (const l of lines) total += Math.round(Number(l.quantity) * Number(l.expected_unit_price_cents));
    const { rows: poRows } = await db.query(
      `INSERT INTO purchase.purchase_orders (id, tenant_id, po_number, supplier_id, requisition_id, buyer_person_id, status, total_amount_cents, order_date, expected_delivery_date, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, 'draft', $6, current_date, $7, $8) RETURNING *`,
      [uuid(), poNumber, body.supplier_id, pr.id, identity.personId, total,
       body.expected_delivery_date ?? null, `由请购单 ${pr.pr_number} 转单`]
    );
    const po = poRows[0];
    for (const l of lines) {
      await db.query(
        `INSERT INTO purchase.purchase_order_lines (id, tenant_id, order_id, part_id, quantity, unit_price_cents, amount_cents)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6)`,
        [uuid(), po.id, l.part_id, l.quantity, l.expected_unit_price_cents,
         Math.round(Number(l.quantity) * Number(l.expected_unit_price_cents))]);
    }
    return po;
  });
  json(res, 201, row);
});

// ── 采购订单 PO ────────────────────────────────────────────────

get("/v1/purchase/orders", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    // P2c 行级数据域：普通员工仅见本人采购/无归属 PO；特权岗位/admin 不过滤
    const { sqlParam } = await resolveRowScope(db, identity);
    const { rows } = await db.query(
      `SELECT o.*, s.name AS supplier_name FROM purchase.purchase_orders o
       JOIN purchase.suppliers s ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id
       WHERE o.tenant_id = platform.current_tenant_id() AND ($1::text IS NULL OR o.status = $1)
         AND ($4::uuid IS NULL OR o.buyer_person_id IS NULL OR o.buyer_person_id = $4)
       ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, limit, offset, sqlParam]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

get("/v1/purchase/orders/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT o.*, s.name AS supplier_name FROM purchase.purchase_orders o
       JOIN purchase.suppliers s ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id
       WHERE o.tenant_id = platform.current_tenant_id() AND o.id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const { rows: lineRows } = await db.query(
      `SELECT l.*, p.part_number, p.name, p.uom FROM purchase.purchase_order_lines l
       JOIN mfg.parts p ON p.tenant_id = l.tenant_id AND p.id = l.part_id
       WHERE l.tenant_id = platform.current_tenant_id() AND l.order_id = $1 ORDER BY l.created_at`, [header.id]);
    return { ...header, lines: lineRows };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

post("/v1/purchase/orders", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const lines = Array.isArray(body.lines) ? body.lines as Record<string, unknown>[] : [];
  if (!body.supplier_id || !lines.length) return json(res, 400, { error: "supplier_id_and_lines_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const poNumber = `PO-${Date.now().toString(36).toUpperCase()}`;
    let total = 0;
    for (const l of lines) {
      if (!l.part_id || !Number(l.quantity) || l.unit_price_cents == null) throw new Error("po_line_needs_part_id_quantity_unit_price");
      total += Math.round(Number(l.quantity) * Number(l.unit_price_cents));
    }
    const { rows } = await db.query(
      `INSERT INTO purchase.purchase_orders (id, tenant_id, po_number, supplier_id, buyer_person_id, status, total_amount_cents, order_date, expected_delivery_date, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, 'draft', $5, $6, $7, $8) RETURNING *`,
      [uuid(), poNumber, body.supplier_id, identity.personId, total,
       body.order_date ?? new Date().toISOString().slice(0, 10), body.expected_delivery_date ?? null, body.notes ?? null]
    );
    const po = rows[0];
    for (const l of lines) {
      await db.query(
        `INSERT INTO purchase.purchase_order_lines (id, tenant_id, order_id, part_id, quantity, unit_price_cents, amount_cents)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6)`,
        [uuid(), po.id, l.part_id, l.quantity, l.unit_price_cents,
         Math.round(Number(l.quantity) * Number(l.unit_price_cents))]);
    }
    return po;
  });
  json(res, 201, row);
});

post("/v1/purchase/orders/:id/approve", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const current = await db.query(
      `SELECT buyer_person_id FROM purchase.purchase_orders
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'draft'`,
      [ctx.params.id]
    );
    if (!current.rows[0]) return null;
    if (current.rows[0].buyer_person_id === identity.personId) throw new Error("self_approval_forbidden");
    const { rows } = await db.query(
      `UPDATE purchase.purchase_orders SET status = 'approved', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'draft' RETURNING *`, [ctx.params.id]);
    const po = rows[0] ?? null;
    if (po) {
      await emitEvent(db, identity.tenantId, {
        eventType: "purchase.purchase_order.approved.v1", aggregateType: "purchase.purchase_orders", aggregateId: po.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { po_number: po.po_number, total_amount_cents: po.total_amount_cents },
      });
    }
    return po;
  });
  if (!row) return json(res, 409, { error: "po_not_draft_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 收货（来料登记；库存增加在来料检判定合格后由 quality 裁决回写）──

post("/v1/purchase/orders/:id/receipts", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const lines = Array.isArray(body.lines) ? body.lines as Record<string, unknown>[] : [];
  if (!lines.length) return json(res, 400, { error: "receipt_lines_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM purchase.purchase_orders WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [ctx.params.id]);
    const po = rows[0] ?? null;
    if (!po) return null;
    if (!["approved", "partially_received"].includes(po.status)) throw new Error(`po_not_receiveable:${po.status}`);
    const receiptNumber = `GRN-${Date.now().toString(36).toUpperCase()}`;
    const { rows: receiptRows } = await db.query(
      `INSERT INTO purchase.goods_receipts (id, tenant_id, receipt_number, order_id, receiver_person_id, status, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, 'received', $5) RETURNING *`,
      [uuid(), receiptNumber, po.id, body.receiver_person_id ?? identity.personId, body.notes ?? null]
    );
    const receipt = receiptRows[0];
    for (const l of lines) {
      if (!l.order_line_id || !Number(l.quantity)) throw new Error("receipt_line_needs_order_line_id_and_quantity");
      const { rows: lineRows } = await db.query(
        `SELECT * FROM purchase.purchase_order_lines WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [l.order_line_id]);
      const ol = lineRows[0];
      if (!ol || ol.order_id !== po.id) throw new Error(`order_line_not_found:${l.order_line_id}`);
      if (Number(ol.received_quantity) + Number(l.quantity) > Number(ol.quantity)) throw new Error(`over_receive_not_allowed:${ol.received_quantity}/${ol.quantity}`);
      await db.query(
        `UPDATE purchase.purchase_order_lines SET received_quantity = received_quantity + $2::numeric, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
        [ol.id, l.quantity]);
      await db.query(
        `INSERT INTO purchase.goods_receipt_lines (id, tenant_id, receipt_id, order_line_id, part_id, quantity)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5)`,
        [uuid(), receipt.id, ol.id, ol.part_id, l.quantity]);
    }
    // 全部行收满 → received；否则 partially_received
    const { rows: checkRows } = await db.query(
      `SELECT count(*) FILTER (WHERE received_quantity < quantity)::int AS open_lines FROM purchase.purchase_order_lines
       WHERE tenant_id = platform.current_tenant_id() AND order_id = $1`, [po.id]);
    const newStatus = checkRows[0].open_lines === 0 ? "received" : "partially_received";
    await db.query(`UPDATE purchase.purchase_orders SET status = $2, updated_at = now(), version = version + 1 WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [po.id, newStatus]);
    // 自动生成来料检（pending），逐行引用收货单
    const totalQty = lines.reduce((s, l) => s + Number(l.quantity), 0);
    await db.query(
      `INSERT INTO qms.inspections (id, tenant_id, inspection_number, inspection_type, receipt_id, total_quantity, sample_quantity, result, note)
       VALUES (gen_random_uuid(), platform.current_tenant_id(), 'IQC-' || upper(substr(md5(random()::text), 1, 10)), 'incoming', $1, $2, 0, 'pending', $3)`,
      [receipt.id, totalQty, `收货单自动触发的来料检`]);
    return { receipt, poStatus: newStatus };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 201, result.receipt);
});

get("/v1/purchase/receipts/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT r.*, o.po_number FROM purchase.goods_receipts r
       JOIN purchase.purchase_orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id
       WHERE r.tenant_id = platform.current_tenant_id() AND r.id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const { rows: lineRows } = await db.query(
      `SELECT l.*, p.part_number, p.name FROM purchase.goods_receipt_lines l
       JOIN mfg.parts p ON p.tenant_id = l.tenant_id AND p.id = l.part_id
       WHERE l.tenant_id = platform.current_tenant_id() AND l.receipt_id = $1`, [header.id]);
    return { ...header, lines: lineRows };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

// ── 供应商发票与三单匹配（PO 价 × 收货合格量 × 发票额）→ 应付 ──

post("/v1/purchase/invoices", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.supplier_id || !body.order_id || !Number(body.amount_cents) || !body.invoice_number) {
    return json(res, 400, { error: "invoice_number_supplier_id_order_id_amount_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO purchase.supplier_invoices (id, tenant_id, invoice_number, supplier_id, order_id, amount_cents, tax_rate, invoice_date, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [uuid(), body.invoice_number, body.supplier_id, body.order_id, body.amount_cents,
       body.tax_rate ?? 0.13, body.invoice_date ?? new Date().toISOString().slice(0, 10), body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

get("/v1/purchase/invoices", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, s.name AS supplier_name, o.po_number FROM purchase.supplier_invoices i
       JOIN purchase.suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
       JOIN purchase.purchase_orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
       WHERE i.tenant_id = platform.current_tenant_id() AND ($1::text IS NULL OR i.match_status = $1)
       ORDER BY i.created_at DESC LIMIT $2 OFFSET $3`,
      [q.match_status ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

// 三单匹配：期望额 = Σ(PO单价 × 收货合格量)；发票净额与期望额差在容差内即匹配，
// 匹配成功后生成应付（finance.invoices invoice_type='payable'），并发出事件。
post("/v1/purchase/invoices/:id/match", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const tolerancePct = Number(body.tolerance_pct ?? 0.01);
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM purchase.supplier_invoices WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [ctx.params.id]);
    const inv = rows[0] ?? null;
    if (!inv) return null;
    if (inv.match_status !== "pending") throw new Error(`invoice_already_${inv.match_status}`);
    // 每行：合格收货量（来料检回写）× PO 单价
    const { rows: matchRows } = await db.query(
      `SELECT ol.part_id, ol.unit_price_cents,
              coalesce(sum(rl.accepted_quantity), 0)::numeric AS accepted_qty
       FROM purchase.purchase_order_lines ol
       LEFT JOIN purchase.goods_receipt_lines rl ON rl.tenant_id = ol.tenant_id AND rl.order_line_id = ol.id
       WHERE ol.tenant_id = platform.current_tenant_id() AND ol.order_id = $1
       GROUP BY ol.part_id, ol.unit_price_cents`, [inv.order_id]);
    let expected = 0;
    const detail: Record<string, unknown>[] = [];
    for (const m of matchRows) {
      const lineExpected = Math.round(Number(m.accepted_qty) * Number(m.unit_price_cents));
      expected += lineExpected;
      const { rows: pr } = await db.query(`SELECT part_number FROM mfg.parts WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [m.part_id]);
      detail.push({ part_number: pr[0]?.part_number, accepted_qty: m.accepted_qty, unit_price_cents: m.unit_price_cents, expected_cents: lineExpected });
    }
    // 发票按不含税净额比较：amount_cents / (1+tax_rate)
    const invoiceNet = Math.round(Number(inv.amount_cents) / (1 + Number(inv.tax_rate)));
    const variance = invoiceNet - expected;
    const tolerance = Math.round(expected * tolerancePct);
    const matched = expected > 0 && Math.abs(variance) <= tolerance;
    if (!matched) {
      await db.query(
        `UPDATE purchase.supplier_invoices SET match_status = 'mismatched', match_result = $2, updated_at = now()
         WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
        [inv.id, JSON.stringify({ expected_cents: expected, invoice_net_cents: invoiceNet, variance_cents: variance, tolerance_cents: tolerance, lines: detail })]);
      return { invoice: { ...inv, match_status: "mismatched" }, matched: false, expected, invoiceNet, variance };
    }
    // 生成应付（财务模块的 payable 发票），due_date = 发票日期 + 30 天
    const { rows: supRows } = await db.query(`SELECT name FROM purchase.suppliers WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [inv.supplier_id]);
    const dueDate = new Date(Date.parse(String(inv.invoice_date)) + 30 * 86_400_000).toISOString().slice(0, 10);
    const { rows: finRows } = await db.query(
      `INSERT INTO finance.invoices
         (id, tenant_id, invoice_number, invoice_type, counterparty_name, amount_cents, tax_rate, issue_date, due_date, status, notes)
       VALUES ($1, platform.current_tenant_id(), $2, 'payable', $3, $4, $5, $6, $7, 'sent', $8) RETURNING *`,
      [uuid(), `AP-${inv.invoice_number}`, supRows[0]?.name ?? "供应商", inv.amount_cents,
       inv.tax_rate, inv.invoice_date, dueDate, `三单匹配自动生成（PO 发票 ${inv.invoice_number}）`]
    );
    const fin = finRows[0];
    await db.query(
      `UPDATE purchase.supplier_invoices SET match_status = 'matched', match_result = $2, finance_invoice_id = $3, matched_at = now(), updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [inv.id, JSON.stringify({ expected_cents: expected, invoice_net_cents: invoiceNet, variance_cents: variance, tolerance_cents: tolerance, lines: detail, finance_invoice_number: fin.invoice_number }), fin.id]);
    await emitEvent(db, identity.tenantId, {
      eventType: "purchase.invoice.matched.v1", aggregateType: "purchase.supplier_invoices", aggregateId: inv.id,
      actorId: identity.personId, traceId: ctx.traceId,
      payload: { invoice_number: inv.invoice_number, expected_cents: expected, payable_invoice_id: fin.id },
    });
    return { invoice: { ...inv, match_status: "matched", finance_invoice_id: fin.id }, matched: true, expected, invoiceNet, variance, payable: fin };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

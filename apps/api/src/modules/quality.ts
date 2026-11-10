import { get, post, patch, json } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { readSession } from "../session.ts";
import { emitEvent } from "../outbox.ts";
import { applyStockMovement } from "../stock.ts";
import type { IncomingMessage } from "node:http";

// ═══════════════════════════════════════════════════════════════
// 质量域 QMS（P0）：来料检/过程检/成品检 + 实测值 + 判定回写（收货合格量、库存）+ NCR。
// 来料检与收货联动：判定合格的数量才增加库存；不合格自动生成 NCR。
// ═══════════════════════════════════════════════════════════════

function sess(req: IncomingMessage) { return readSession(req.headers.cookie); }

get("/v1/qms/inspections", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, p.part_number, p.name AS part_name
       FROM qms.inspections i
       LEFT JOIN mfg.parts p ON p.tenant_id = i.tenant_id AND p.id = i.part_id
       WHERE i.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR i.inspection_type = $1)
         AND ($2::text IS NULL OR i.result = $2)
         AND ($3::uuid IS NULL OR i.receipt_id = $3)
         AND ($4::uuid IS NULL OR i.work_order_id = $4)
       ORDER BY i.created_at DESC LIMIT $5 OFFSET $6`,
      [q.inspection_type ?? null, q.result ?? null, q.receipt_id ?? null, q.work_order_id ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/qms/inspections", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.inspection_type) return json(res, 400, { error: "inspection_type_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const prefix = { incoming: "IQC", in_process: "IPQC", final: "FQC" }[String(body.inspection_type)] ?? "QC";
    const { rows } = await db.query(
      `INSERT INTO qms.inspections
         (id, tenant_id, inspection_number, inspection_type, part_id, work_order_id, receipt_id, total_quantity, sample_quantity, inspector_person_id, note)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [uuid(), `${prefix}-` + upper_rand(), body.inspection_type, body.part_id ?? null,
       body.work_order_id ?? null, body.receipt_id ?? null,
       body.total_quantity ?? 0, body.sample_quantity ?? 0, body.inspector_person_id ?? null, body.note ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

function upper_rand(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
}

get("/v1/qms/inspections/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, p.part_number, p.name AS part_name FROM qms.inspections i
       LEFT JOIN mfg.parts p ON p.tenant_id = i.tenant_id AND p.id = i.part_id
       WHERE i.tenant_id = platform.current_tenant_id() AND i.id = $1`, [ctx.params.id]);
    const header = rows[0] ?? null;
    if (!header) return null;
    const { rows: ms } = await db.query(
      `SELECT * FROM qms.inspection_measurements WHERE tenant_id = platform.current_tenant_id() AND inspection_id = $1 ORDER BY created_at`, [header.id]);
    const { rows: ncrs } = await db.query(
      `SELECT * FROM qms.ncrs WHERE tenant_id = platform.current_tenant_id() AND inspection_id = $1`, [header.id]);
    return { ...header, measurements: ms, ncrs };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

// 实测值（SPC 原料）：一次提交多条特性测量
post("/v1/qms/inspections/:id/measurements", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const items = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [];
  if (!items.length) return json(res, 400, { error: "measurements_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows: ex } = await db.query(
      `SELECT id FROM qms.inspections WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id]);
    if (!ex[0]) throw new Error("inspection_not_found");
    const created: unknown[] = [];
    for (const m of items) {
      if (!m.characteristic) throw new Error("measurement_needs_characteristic");
      const { rows } = await db.query(
        `INSERT INTO qms.inspection_measurements (id, tenant_id, inspection_id, characteristic, standard_value, measured_value, result, note)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7) RETURNING *`,
        [uuid(), ctx.params.id, m.characteristic, m.standard_value ?? null, m.measured_value ?? null, m.result ?? "na", m.note ?? null]);
      created.push(rows[0]);
      if (m.result === "fail") {
        await db.query(`UPDATE qms.inspections SET updated_at = now() WHERE id = $1`, [ctx.params.id]);
      }
    }
    await db.query(
      `UPDATE qms.inspections SET sample_quantity = greatest(sample_quantity, $2) WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id, items.length]);
    return created;
  });
  json(res, 201, { items: rows });
});

// 判定：pass/fail（可带逐收货行的合格/不合格数量）。来料检联动收货与库存。
post("/v1/qms/inspections/:id/verdict", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const verdict = String(body.result ?? "");
  if (!["pass", "fail"].includes(verdict)) return json(res, 400, { error: "result_must_be_pass_or_fail", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM qms.inspections WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`, [ctx.params.id]);
    const insp = rows[0] ?? null;
    if (!insp) return null;
    if (insp.result !== "pending") throw new Error(`inspection_already_verdicted:${insp.result}`);
    await db.query(
      `UPDATE qms.inspections SET result = $2, inspector_person_id = coalesce($3, inspector_person_id), inspected_at = now(),
              note = coalesce($4, note), updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [insp.id, verdict, body.inspector_person_id ?? identity.personId, body.note ?? null]);

    let receiptHandled = false;
    if (insp.inspection_type === "incoming" && insp.receipt_id) {
      // 逐收货行确定合格/不合格量：显式 accepted_quantities 优先，否则按整单 pass/fail
      const { rows: rLines } = await db.query(
        `SELECT * FROM purchase.goods_receipt_lines WHERE tenant_id = platform.current_tenant_id() AND receipt_id = $1 FOR UPDATE`, [insp.receipt_id]);
      const overrides = Array.isArray(body.accepted_quantities) ? body.accepted_quantities as Record<string, unknown>[] : [];
      let totalAccepted = 0;
      let totalRejected = 0;
      for (const rl of rLines) {
        const o = overrides.find(x => String(x.receipt_line_id) === String(rl.id));
        let accepted: number; let rejected: number;
        if (o) {
          accepted = Number(o.accepted_quantity ?? 0);
          rejected = Number(o.rejected_quantity ?? 0);
          if (accepted + rejected > Number(rl.quantity)) throw new Error(`verdict_quantities_exceed_received:${rl.id}`);
        } else if (verdict === "pass") {
          accepted = Number(rl.quantity); rejected = 0;
        } else {
          accepted = 0; rejected = Number(rl.quantity);
        }
        await db.query(
          `UPDATE purchase.goods_receipt_lines SET accepted_quantity = $2, rejected_quantity = $3 WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
          [rl.id, accepted, rejected]);
        totalAccepted += accepted; totalRejected += rejected;
        if (accepted > 0) {
          // 入库估值用标准成本（actual PO 价体现在应付，不影响库存账面）
          const { rows: pc } = await db.query(
            `SELECT standard_unit_cost_cents FROM mfg.parts WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [rl.part_id]);
          await applyStockMovement(db, {
            partId: rl.part_id, warehouse: String(body.warehouse ?? "MAIN"), direction: "in",
            movementType: "purchase_receipt", quantity: accepted, unitCostCents: Number(pc[0]?.standard_unit_cost_cents ?? 0),
            referenceType: "purchase.goods_receipts", referenceId: insp.receipt_id, personId: identity.personId,
            note: `来料检合格入库（${insp.inspection_number}）`,
          });
        }
      }
      const receiptStatus = totalRejected === 0 ? "accepted" : (totalAccepted > 0 ? "partial_accepted" : "rejected");
      await db.query(
        `UPDATE purchase.goods_receipts SET status = $2, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
        [insp.receipt_id, receiptStatus]);
      receiptHandled = true;
      await emitEvent(db, identity.tenantId, {
        eventType: "purchase.goods_receipt.confirmed.v1", aggregateType: "purchase.goods_receipts", aggregateId: insp.receipt_id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { receipt_id: insp.receipt_id, accepted: totalAccepted, rejected: totalRejected, status: receiptStatus },
      });
    }

    // 不合格 → 自动生成 NCR（来源可追溯到检验单）
    if (verdict === "fail") {
      const failQty = Number(body.ncr_quantity ?? insp.total_quantity);
      await db.query(
        `INSERT INTO qms.ncrs (id, tenant_id, ncr_number, inspection_id, work_order_id, receipt_id, part_id, quantity, description, owner_person_id)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuid(), `NCR-${upper_rand()}`, insp.id, insp.work_order_id, insp.receipt_id, insp.part_id,
         failQty, `检验 ${insp.inspection_number} 判定不合格${body.note ? "：" + body.note : ""}`,
         body.inspector_person_id ?? identity.personId]);
      await emitEvent(db, identity.tenantId, {
        eventType: "qms.inspection.failed.v1", aggregateType: "qms.inspections", aggregateId: insp.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { inspection_number: insp.inspection_number, inspection_type: insp.inspection_type, part_id: insp.part_id },
      });
    }
    const { rows: after } = await db.query(`SELECT * FROM qms.inspections WHERE id = $1`, [insp.id]);
    return { inspection: after[0], receiptHandled };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result.inspection);
});

// ── NCR 不合格品处置 ───────────────────────────────────────────

get("/v1/qms/ncrs", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT n.*, p.part_number, p.name AS part_name, pe.display_name AS owner_name FROM qms.ncrs n
       LEFT JOIN mfg.parts p ON p.tenant_id = n.tenant_id AND p.id = n.part_id
       LEFT JOIN platform.people pe ON pe.tenant_id = n.tenant_id AND pe.id = n.owner_person_id
       WHERE n.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR n.status = $1)
         AND ($2::text IS NULL OR n.disposition = $2)
       ORDER BY n.created_at DESC LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.disposition ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/qms/ncrs", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.description) return json(res, 400, { error: "description_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO qms.ncrs (id, tenant_id, ncr_number, inspection_id, work_order_id, receipt_id, part_id, quantity, description, owner_person_id, note)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [uuid(), `NCR-${upper_rand()}`, body.inspection_id ?? null, body.work_order_id ?? null,
       body.receipt_id ?? null, body.part_id ?? null, body.quantity ?? 0, body.description,
       body.owner_person_id ?? identity.personId, body.note ?? null]
    );
    const ncr = rows[0];
    await emitEvent(db, identity.tenantId, {
      eventType: "qms.ncr.created.v1", aggregateType: "qms.ncrs", aggregateId: ncr.id,
      actorId: identity.personId, traceId: ctx.traceId,
      payload: { ncr_number: ncr.ncr_number, part_id: ncr.part_id, quantity: ncr.quantity },
    });
    return ncr;
  });
  json(res, 201, row);
});

patch("/v1/qms/ncrs/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["disposition", "status", "owner_person_id", "note", "quantity"];
  const sets: string[] = []; const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  if (body.status === "closed") sets.push("closed_at = now()");
  sets.push("updated_at = now()");
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE qms.ncrs SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`, vals);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

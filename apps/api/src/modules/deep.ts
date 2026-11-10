import { get, post, patch, del, json } from "../router.ts";
import { withTenant, uuid, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { assertCapability, effectiveRoles } from "../authz.ts";
import { emitEvent } from "../outbox.ts";
import type { IncomingMessage } from "node:http";

// ═══════════════════════════════════════════════════════════════
// 全面深化（docs/18）：合同模板/条款、发票核销、KR 实时值、360 反馈、
// 考勤月历/补卡、库存预警、点检日历、知识评审。迁移 0027。
// ═══════════════════════════════════════════════════════════════

function sess(req: IncomingMessage) { return readSession(req.headers.cookie); }

// ── 1. 合同模板与条款库 ────────────────────────────────────────

get("/v1/sales/contract-templates", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT t.*, p.display_name AS creator_name,
              (SELECT count(*)::int FROM sales.contract_clauses c WHERE c.tenant_id = t.tenant_id AND c.template_id = t.id) AS clause_count
       FROM sales.contract_templates t
       LEFT JOIN platform.people p ON p.tenant_id = t.tenant_id AND p.id = t.created_by_person_id
       WHERE t.tenant_id = platform.current_tenant_id() AND t.status = 'active'
       ORDER BY t.created_at DESC`);
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/sales/contract-templates", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "people.manage_roles"); // 仅企业管理员维护模板
    const { rows } = await db.query(
      `INSERT INTO sales.contract_templates (id, tenant_id, name, contract_type, default_payment_terms, body_md, created_by_person_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6) RETURNING *`,
      [uuid(), body.name, body.contract_type ?? "service", body.default_payment_terms ?? null, body.body_md ?? null, identity.personId]);
    const template = rows[0];
    const clauses = Array.isArray(body.clauses) ? body.clauses as Record<string, unknown>[] : [];
    for (let i = 0; i < clauses.length; i++) {
      const c = clauses[i];
      if (!c.title || !c.body_md) throw new Error("clause_needs_title_and_body");
      await db.query(
        `INSERT INTO sales.contract_clauses (id, tenant_id, template_id, title, body_md, category, sort_order)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6)`,
        [uuid(), template.id, c.title, c.body_md, c.category ?? null, i + 1]);
    }
    return template;
  });
  json(res, 201, row);
});

get("/v1/sales/contract-templates/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM sales.contract_templates WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id]);
    const template = rows[0] ?? null;
    if (!template) return null;
    const { rows: clauses } = await db.query(
      `SELECT * FROM sales.contract_clauses WHERE tenant_id = platform.current_tenant_id() AND template_id = $1 ORDER BY sort_order`,
      [template.id]);
    return { ...template, clauses };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

post("/v1/sales/contract-templates/:id/clauses", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title || !body.body_md) return json(res, 400, { error: "title_and_body_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "people.manage_roles");
    const { rows: [template] } = await db.query(
      `SELECT id FROM sales.contract_templates WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id]);
    if (!template) throw new Error("template_not_found");
    const { rows } = await db.query(
      `INSERT INTO sales.contract_clauses (id, tenant_id, template_id, title, body_md, category, sort_order)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5,
               coalesce((SELECT max(sort_order)+1 FROM sales.contract_clauses WHERE tenant_id = platform.current_tenant_id() AND template_id = $2), 1))
       RETURNING *`,
      [uuid(), ctx.params.id, body.title, body.body_md, body.category ?? null]);
    return rows[0];
  });
  json(res, 201, row);
});

del("/v1/sales/contract-templates/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "people.manage_roles");
    const { rows } = await db.query(
      `UPDATE sales.contract_templates SET status = 'archived', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 RETURNING id`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { archived: true });
});

// 从模板创建合同（起草态；条款快照防模板后续变更影响已建合同）
post("/v1/sales/contracts/from-template", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.template_id || !body.account_id || !Number.isFinite(Number(body.amount_cents))) {
    return json(res, 400, { error: "template_id_account_amount_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const { rows: [template] } = await db.query(
      `SELECT * FROM sales.contract_templates WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'active'`,
      [body.template_id]);
    if (!template) throw new Error("template_not_found");
    const { rows: clauses } = await db.query(
      `SELECT title, body_md, category FROM sales.contract_clauses WHERE tenant_id = platform.current_tenant_id() AND template_id = $1 ORDER BY sort_order`,
      [template.id]);
    const contractNo = "CT-" + Date.now().toString(36).toUpperCase();
    const { rows } = await db.query(
      `INSERT INTO sales.contracts
         (id, tenant_id, contract_no, title, contract_type, account_id, amount_cents, payment_terms,
          owner_person_id, template_id, clauses_snapshot, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING *`,
      [uuid(), contractNo,
       body.title ?? template.name + "（依模板起草）",
       template.contract_type, body.account_id, Math.round(Number(body.amount_cents)),
       body.payment_terms ?? template.default_payment_terms, identity.personId,
       template.id, JSON.stringify(clauses), "由模板「" + template.name + "」起草，条款已快照"]);
    return { contract: rows[0], clauses_snapshotted: clauses.length };
  });
  json(res, 201, row);
});

// ── 2. 发票核销 ────────────────────────────────────────────────

get("/v1/finance/invoices/:id/writeoffs", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT w.*, pp.milestone AS payment_milestone, pp.due_date AS payment_due_date
       FROM finance.invoice_writeoffs w
       JOIN finance.payment_plans pp ON pp.tenant_id = w.tenant_id AND pp.id = w.payment_plan_id
       WHERE w.tenant_id = platform.current_tenant_id() AND w.invoice_id = $1
       ORDER BY w.created_at`, [ctx.params.id]);
    return rows;
  });
  json(res, 200, { items: rows });
});

// 自动核销：按最早期「已收且未被完全占用」的收款计划冲抵发票未结额（finance.manage）
post("/v1/finance/invoices/:id/auto-writeoff", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "finance.manage");
    const { rows: [inv] } = await db.query(
      `SELECT * FROM finance.invoices WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`,
      [ctx.params.id]);
    if (!inv) return { code: 404, error: "not_found" };
    const outstanding = Number(inv.amount_cents) - Number(inv.paid_cents);
    if (outstanding <= 0) return { code: 409, error: "invoice_already_settled" };

    const { rows: payments } = await db.query(
      `SELECT pp.id, pp.amount_cents,
              coalesce((SELECT sum(w.amount_cents) FROM finance.invoice_writeoffs w
                        WHERE w.tenant_id = pp.tenant_id AND w.payment_plan_id = pp.id), 0)::bigint AS consumed_cents
       FROM finance.payment_plans pp
       WHERE pp.tenant_id = platform.current_tenant_id() AND pp.status = 'paid'
       ORDER BY pp.due_date ASC`);
    let remaining = outstanding;
    const allocations: Array<{ payment_plan_id: string; amount_cents: number }> = [];
    for (const pay of payments) {
      if (remaining <= 0) break;
      const free = Number(pay.amount_cents) - Number(pay.consumed_cents);
      if (free <= 0) continue;
      const use = Math.min(free, remaining);
      allocations.push({ payment_plan_id: pay.id, amount_cents: use });
      remaining -= use;
    }
    if (!allocations.length) return { code: 409, error: "no_paid_payment_available" };

    let applied = 0;
    for (const a of allocations) {
      await db.query(
        `INSERT INTO finance.invoice_writeoffs (id, tenant_id, invoice_id, payment_plan_id, amount_cents, created_by_person_id)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5)`,
        [uuid(), inv.id, a.payment_plan_id, a.amount_cents, identity.personId]);
      applied += a.amount_cents;
    }
    const newPaid = Number(inv.paid_cents) + applied;
    const newStatus = newPaid >= Number(inv.amount_cents) ? "paid" : "partial";
    const { rows: [updated] } = await db.query(
      `UPDATE finance.invoices SET paid_cents = $2, status = $3,
              paid_at = CASE WHEN $3 = 'paid' THEN now() ELSE paid_at END,
              updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 RETURNING *`,
      [inv.id, newPaid, newStatus]);
    return { code: 201, invoice: updated, applied_cents: applied, allocations };
  });
  if ("code" in result && result.code !== 201 && result.code !== 200) {
    return json(res, result.code, { error: result.error, traceId: ctx.traceId });
  }
  json(res, 201, result);
});

// ── 3. KR 实时值（绑定 metric_source 后由业务表派生）──────────
// mrr → 活跃订阅 MRR（万元）；otd/yield → 制造实时率（%）。手工打卡保留为记录。

export async function computeLiveMetric(db: DbClient, source: string, krId?: string): Promise<{ value: number; unit: string } | null> {
  if (source === "mrr") {
    const { rows } = await db.query(
      `SELECT coalesce(sum(mrr_cents),0)::bigint AS cents FROM sales.subscriptions
       WHERE tenant_id = platform.current_tenant_id() AND status = 'active'`);
    return { value: Math.round(Number(rows[0].cents) / 1_000_000 * 100) / 100, unit: "万元" };
  }
  if (source === "otd") {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'completed' AND actual_finish::date <= planned_finish)::int AS on_time,
              count(*) FILTER (WHERE status = 'completed' AND planned_finish IS NOT NULL)::int AS finished
       FROM mfg.work_orders WHERE tenant_id = platform.current_tenant_id()`);
    const { on_time, finished } = rows[0];
    return finished > 0 ? { value: Math.round(Number(on_time) / Number(finished) * 10000) / 100, unit: "%" } : null;
  }
  if (source === "project") {
    const { rows } = await db.query(
      `SELECT round(coalesce(sum(l.weight * pr.progress) / nullif(sum(l.weight), 0), 0))::int AS progress
       FROM strategy.kr_links l JOIN project.projects pr ON pr.tenant_id = l.tenant_id AND pr.id = l.link_id
       WHERE l.tenant_id = platform.current_tenant_id() AND l.kr_id = $1 AND l.link_type = 'project'`, [krId]);
    return rows[0]?.progress != null ? { value: Number(rows[0].progress), unit: "%" } : null;
  }
  if (source === "yield") {
    const { rows } = await db.query(
      `SELECT coalesce(sum(qty_good),0)::numeric AS good, coalesce(sum(qty_scrap),0)::numeric AS scrap
       FROM mfg.work_reports WHERE tenant_id = platform.current_tenant_id()`);
    const good = Number(rows[0].good), scrap = Number(rows[0].scrap);
    return good + scrap > 0 ? { value: Math.round(good / (good + scrap) * 10000) / 100, unit: "%" } : null;
  }
  return null;
}

// ── 4. 考勤月历与补卡 ──────────────────────────────────────────

get("/v1/hr/attendance/calendar", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const now = new Date();
  const year = Number(q.year ?? now.getFullYear());
  const month = Math.min(Math.max(Number(q.month ?? now.getMonth() + 1), 1), 12);
  const rows = await withTenant(identity, async (db) => {
    const target = q.person_id ?? identity.personId;
    if (target !== identity.personId) {
      await assertCapability(db, identity, "hr.manage");
    }
    const { rows } = await db.query(
      `SELECT date::text AS date, check_in::text AS check_in, check_out::text AS check_out, source
       FROM hr.attendance_records
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
         AND extract(year from date) = $2::int AND extract(month from date) = $3::int
       ORDER BY date`, [target, year, month]);
    interface AttendanceRow { date: string; check_in: string | null; check_out: string | null; source: string }
    const byDate = new Map<string, AttendanceRow>(rows.map((r) => [String(r.date).slice(0, 10), r as AttendanceRow]));
    const days: Array<{ date: string; weekday: number; status: string; check_in: string | null; check_out: string | null }> = [];
    const first = new Date(Date.UTC(year, month - 1, 1));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(Date.UTC(year, month - 1, d)).toISOString().slice(0, 10);
      const weekday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
      const rec = byDate.get(date);
      let status = "missing";
      if (rec) status = rec.source === "makeup" ? "makeup" : "present";
      else if (weekday === 0 || weekday === 6) status = "weekend";
      days.push({ date, weekday, status, check_in: rec?.check_in ?? null, check_out: rec?.check_out ?? null });
    }
    return { year, month, days, present: days.filter(x => x.status === "present").length, makeup: days.filter(x => x.status === "makeup").length };
  });
  json(res, 200, rows);
});

post("/v1/hr/attendance/makeup", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? ""))) {
    return json(res, 400, { error: "date_required_yyyy_mm_dd", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO hr.attendance_records (id, tenant_id, person_id, date, check_in, source, note)
       VALUES ($1, platform.current_tenant_id(), $2, $3::date, $3::date::timestamptz + interval '9 hours', 'makeup', $4)
       ON CONFLICT (tenant_id, person_id, date)
       DO UPDATE SET source = 'makeup', check_in = coalesce(hr.attendance_records.check_in, EXCLUDED.check_in),
                     note = coalesce(EXCLUDED.note, hr.attendance_records.note)
       RETURNING *`,
      [uuid(), identity.personId, body.date, ("补卡：" + (body.reason ?? "未说明")) as string]);
    await db.query(
      `INSERT INTO audit.audit_events (id, tenant_id, actor_id, action, resource_type, outcome, change_summary, client_context, trace_id)
       VALUES ($1, platform.current_tenant_id(), $2, 'hr.attendance.makeup', 'attendance', 'success', $3::jsonb, '{"mode":"ui"}'::jsonb, $4)`,
      [uuid(), identity.personId, JSON.stringify({ date: body.date, reason: body.reason ?? null }), ctx.traceId]);
    await emitEvent(db, identity.tenantId, {
      eventType: "hr.attendance.makeup.v1", aggregateType: "hr.attendance_records", aggregateId: rows[0].id,
      actorId: identity.personId, traceId: ctx.traceId,
      payload: { date: body.date, reason: body.reason ?? null },
    });
    return rows[0];
  });
  json(res, 201, row);
});

// ── 5. 库存安全库存预警 ────────────────────────────────────────

get("/v1/stock/alerts", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT p.id, p.part_number, p.name, p.uom, p.safety_stock,
              coalesce(sum(o.quantity - o.blocked_quantity), 0)::numeric AS available,
              (p.safety_stock - coalesce(sum(o.quantity - o.blocked_quantity), 0))::numeric AS gap
       FROM mfg.parts p
       LEFT JOIN stock.onhand o ON o.tenant_id = p.tenant_id AND o.part_id = p.id
       WHERE p.tenant_id = platform.current_tenant_id() AND p.safety_stock > 0 AND p.status = 'active'
       GROUP BY p.id, p.tenant_id
       HAVING coalesce(sum(o.quantity - o.blocked_quantity), 0) < p.safety_stock
       ORDER BY gap DESC`);
    return rows;
  });
  json(res, 200, { items: rows });
});

// ── 6. 设备点检日历 ────────────────────────────────────────────

get("/v1/equipment/calendar", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const now = new Date();
  const year = Number(q.year ?? now.getFullYear());
  const month = Math.min(Math.max(Number(q.month ?? now.getMonth() + 1), 1), 12);
  const result = await withTenant(identity, async (db) => {
    const [inspections, plans] = await Promise.all([
      db.query(
        `SELECT i.id, i.inspected_at::date::text AS date, i.result, i.note,
                a.name AS equipment_name, pe.display_name AS inspector_name
         FROM equipment.inspections i
         JOIN equipment.assets a ON a.tenant_id = i.tenant_id AND a.id = i.equipment_id
         LEFT JOIN platform.people pe ON pe.tenant_id = i.tenant_id AND pe.id = i.inspector_person_id
         WHERE i.tenant_id = platform.current_tenant_id()
           AND extract(year from i.inspected_at) = $1::int AND extract(month from i.inspected_at) = $2::int
         ORDER BY i.inspected_at`, [year, month]),
      db.query(
        `SELECT mp.id, mp.name, mp.next_due_at::text AS date, a.name AS equipment_name
         FROM equipment.maintenance_plans mp
         JOIN equipment.assets a ON a.tenant_id = mp.tenant_id AND a.id = mp.equipment_id
         WHERE mp.tenant_id = platform.current_tenant_id()
           AND mp.next_due_at IS NOT NULL
           AND extract(year from mp.next_due_at) = $1::int AND extract(month from mp.next_due_at) = $2::int
         ORDER BY mp.next_due_at`, [year, month]),
    ]);
    const byDate: Record<string, unknown[]> = {};
    for (const ins of inspections.rows) {
      (byDate[ins.date as string] ??= []).push({ kind: "inspection", ...ins });
    }
    for (const plan of plans.rows) {
      (byDate[plan.date as string] ??= []).push({ kind: "maintenance_due", ...plan });
    }
    return { year, month, by_date: byDate, inspection_count: inspections.rows.length, plan_count: plans.rows.length };
  });
  json(res, 200, result);
});

// ── 7. 知识评审 ────────────────────────────────────────────────

post("/v1/knowledge/items/:id/submit-review", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const roles = await effectiveRoles(db, identity);
    const { rows } = await db.query(
      `UPDATE knowledge.items SET review_status = 'pending', reviewed_at = NULL, reviewed_by_person_id = NULL, review_note = NULL,
              updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1
         AND (owner_person_id = $2 OR $3::bool) RETURNING *`,
      [ctx.params.id, identity.personId, roles.includes("tenant_admin")]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "not_owner_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

post("/v1/knowledge/items/:id/review", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const decision = String(body.decision ?? "");
  if (!["approved", "changes_requested"].includes(decision)) {
    return json(res, 400, { error: "decision_approved_or_changes_requested", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "people.manage_roles"); // 评审为管理员职责
    const { rows } = await db.query(
      `UPDATE knowledge.items SET review_status = $2, reviewed_by_person_id = $3, reviewed_at = now(), review_note = $4,
              updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 RETURNING *`,
      [ctx.params.id, decision, identity.personId, body.note ?? null]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

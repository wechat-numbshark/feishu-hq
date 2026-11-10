import { get, post, patch } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { json } from "../router.ts";
import { readSession } from "../session.ts";
import { createApprovalInstance } from "./approvals.ts";
import { assertCapability } from "../authz.ts";
import { readSettings } from "../settings-registry.ts";
import { resolveRowScope } from "../data-domain.ts";

// ── 付款计划
get("/v1/finance/payments", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT pp.*, p.name AS project_name FROM finance.payment_plans pp
       LEFT JOIN project.projects p ON p.tenant_id = pp.tenant_id AND p.id = pp.project_id
       WHERE pp.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR pp.status = $1)
         AND ($2::text IS NULL OR pp.customer_name ILIKE '%' || $2 || '%')
       ORDER BY pp.due_date ASC LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

post("/v1/finance/payments", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.customer_name || !body.amount_cents || !body.due_date || !body.milestone) {
    return json(res, 400, { error: "customer_name_amount_due_date_milestone_required", traceId: ctx.traceId });
  }

  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "finance.manage");
    const { rows } = await db.query(
      `INSERT INTO finance.payment_plans (id, tenant_id, project_id, customer_name, amount_cents, due_date, milestone, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7) RETURNING *`,
      [uuid(), body.project_id ?? null, body.customer_name, body.amount_cents,
       body.due_date, body.milestone, body.status ?? 'planned']
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/finance/payments/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["customer_name","amount_cents","due_date","milestone","status"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "finance.manage");
    const { rows } = await db.query(
      `UPDATE finance.payment_plans SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 费用报销
get("/v1/finance/expenses", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    // P2c 行级数据域：普通员工仅见本人提交的报销；finance_manager/manager/admin 不过滤
    const { sqlParam } = await resolveRowScope(db, identity);
    const { rows } = await db.query(
      `SELECT e.*, pe.display_name AS submitter_name, pa.display_name AS approver_name
       FROM finance.expenses e
       JOIN platform.people pe ON pe.tenant_id = e.tenant_id AND pe.id = e.submitter_person_id
       LEFT JOIN platform.people pa ON pa.tenant_id = e.tenant_id AND pa.id = e.approver_person_id
       WHERE e.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR e.status = $1)
         AND ($2::text IS NULL OR e.submitter_person_id::text = $2)
         AND ($5::uuid IS NULL OR e.submitter_person_id = $5)
       ORDER BY e.expense_date DESC LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.submitter ?? null, limit, offset, sqlParam]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

post("/v1/finance/expenses", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const description = body.description || body.title || body.category;
  const expenseDate = body.expense_date || body.date || new Date().toISOString().slice(0, 10);
  if (!body.category || !body.amount_cents) {
    return json(res, 400, { error: "category_and_amount_required", traceId: ctx.traceId });
  }

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO finance.expenses
         (id, tenant_id, submitter_person_id, category, amount_cents, expense_date, description, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7) RETURNING *`,
      [uuid(), identity.personId, body.category, body.amount_cents,
       expenseDate, description ?? null, 'submitted']
    );
    const expense = rows[0];
    const { rows: empRows } = await db.query(
      `SELECT manager_person_id FROM platform.employments
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
         AND status != 'terminated' AND deleted_at IS NULL LIMIT 1`,
      [identity.personId]
    );
    // 设置消费者：finance.approval_threshold_cents + finance.expense_deadline_day
    const cfg = await readSettings(db, "finance");
    const threshold = Number(cfg.approval_threshold_cents ?? 500000);
    const deadlineDay = Number(cfg.expense_deadline_day ?? 25);
    const amountCents = Number(body.amount_cents);
    let needsApproval = false;
    if (Number.isFinite(amountCents) && amountCents > threshold) {
      needsApproval = true;
      const approvalInstanceId = await createApprovalInstance(db, {
        tenantId: identity.tenantId,
        flowCode: "expense",
        resourceType: "expense",
        resourceId: expense.id,
        requesterPersonId: identity.personId ?? expense.submitter_person_id,
        title: `报销：${description || body.category} ¥${(amountCents / 100).toFixed(2)}`,
        summary: { category: body.category, amount_cents: body.amount_cents, expense_date: expenseDate, description: description ?? null },
        managerPersonId: empRows[0]?.manager_person_id ?? null,
      });
      if (!approvalInstanceId) throw new Error("approval_flow_unavailable");
    }
    // 计算本月/下月报销提交截止日（expense_deadline_day 消费者）
    const now = new Date();
    const deadline = now.getUTCDate() > deadlineDay
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, deadlineDay))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), deadlineDay));
    return {
      ...expense,
      needs_approval: needsApproval,
      expense_deadline_day: deadlineDay,
      submission_deadline: deadline.toISOString().slice(0, 10),
    };
  });
  json(res, 201, row);
});

const approveExpenseHandler = async (req: any, res: any, ctx: any) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const approved = body.approved !== false;
  const newStatus = approved ? 'approved' : 'rejected';
  const row = await withTenant(identity, async (db) => {
    // 审批报销需 finance.approve；且不能审批自己提交的报销（职责分离）
    await assertCapability(db, identity, "finance.approve");
    const { rows: expRows } = await db.query(
      `SELECT submitter_person_id FROM finance.expenses
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]
    );
    if (expRows[0]?.submitter_person_id === identity.personId) throw new Error("self_approval_forbidden");
    const { rows } = await db.query(
      `UPDATE finance.expenses
       SET status = $3, approver_person_id = $1, approved_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $2
         AND status IN ('draft','submitted')
       RETURNING *`,
      [identity.personId, ctx.params.id, newStatus]
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
};
patch("/v1/finance/expenses/:id/approve", approveExpenseHandler);
post("/v1/finance/expenses/:id/approve", approveExpenseHandler);

// ── 发票
get("/v1/finance/invoices", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM finance.invoices
       WHERE tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR invoice_type = $1)
         AND ($2::text IS NULL OR status = $2)
       ORDER BY issue_date DESC LIMIT $3 OFFSET $4`,
      [q.type ?? null, q.status ?? null, limit, offset]
    );
    // 设置消费者：finance.invoice_expiry_warn_days
    const cfg = await readSettings(db, "finance");
    const warnDays = Number(cfg.invoice_expiry_warn_days ?? 7);
    const warnBeforeMs = Date.now() + warnDays * 86_400_000;
    const items = rows.map((r: Record<string, unknown>) => ({
      ...r,
      expiring_soon: r.due_date != null && String(r.status) !== 'paid'
        && new Date(String(r.due_date)).getTime() <= warnBeforeMs,
    }));
    return { items, limit, offset, invoice_expiry_warn_days: warnDays };
  });

  json(res, 200, rows);
});

// ── 发票创建
post("/v1/finance/invoices", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.invoice_type || !body.amount_cents || !body.counterparty_name) {
    return json(res, 400, { error: "invoice_type_amount_counterparty_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "finance.manage");
    const { rows } = await db.query(
      `INSERT INTO finance.invoices (id, tenant_id, invoice_type, invoice_number, counterparty_name, amount_cents, paid_cents, issue_date, due_date, status, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, 0, $6, $7, 'draft', $8) RETURNING *`,
      [uuid(), body.invoice_type,
       (body.invoice_number as string) || `INV-${Date.now().toString(36).toUpperCase()}`,
       body.counterparty_name, body.amount_cents,
       body.issue_date ?? new Date().toISOString().slice(0, 10),
       body.due_date ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
       body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/finance/invoices/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["status","paid_cents","paid_at","invoice_number","due_date","notes"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "finance.manage");
    const { rows } = await db.query(
      `UPDATE finance.invoices SET ${sets.join(",")}, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 预算管理
get("/v1/finance/budgets", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT ba.*, ou.name AS org_unit_name,
              ba.spent_cents AS actual_spent_cents,
              GREATEST(0, ba.total_amount_cents - ba.spent_cents) AS remaining_cents,
              ROUND(ba.spent_cents * 100.0 / NULLIF(ba.total_amount_cents, 0), 1) AS utilization_pct,
              (ba.spent_cents > ba.total_amount_cents) AS over_budget
       FROM finance.budget_allocations ba
       LEFT JOIN platform.org_units ou ON ou.tenant_id = ba.tenant_id AND ou.id = ba.org_unit_id
       WHERE ba.tenant_id = platform.current_tenant_id()
         AND ($1::int IS NULL OR ba.period_year = $1::int)
         AND ($2::text IS NULL OR ba.category = $2)
         AND ba.status != 'closed'
       ORDER BY ba.period_year DESC, ba.category LIMIT $3 OFFSET $4`,
      [q.year ? Number(q.year) : null, q.category ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/finance/budgets", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.category || !body.total_amount_cents || !body.period_year) {
    return json(res, 400, { error: "category_amount_year_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "finance.manage");
    const budgetName = (body.name as string) || `${body.category} ${body.period_year}预算`;
    const periodLabel = (body.period_label as string) ||
      (body.period_quarter ? `${body.period_year}Q${body.period_quarter}` : `${body.period_year}年`);
    const { rows } = await db.query(
      `INSERT INTO finance.budget_allocations (id, tenant_id, org_unit_id, name, period_label, period_year, period_quarter, category, total_amount_cents, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), (body.org_unit_id as string) || null, budgetName, periodLabel,
       body.period_year, body.period_quarter ?? null,
       body.category, body.total_amount_cents, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/finance/budgets/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["total_amount_cents","notes","period_quarter"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "finance.manage");
    const { rows } = await db.query(
      `UPDATE finance.budget_allocations SET ${sets.join(",")}, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 费用详情
get("/v1/finance/expenses/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT e.*, pe.display_name AS submitter_name, pe.avatar_url AS submitter_avatar,
              pa.display_name AS approver_name
       FROM finance.expenses e
       JOIN platform.people pe ON pe.tenant_id = e.tenant_id AND pe.id = e.submitter_person_id
       LEFT JOIN platform.people pa ON pa.tenant_id = e.tenant_id AND pa.id = e.approver_person_id
       WHERE e.tenant_id = platform.current_tenant_id() AND e.id = $1`,
      [ctx.params.id]
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 财务概览
get("/v1/finance/overview", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const overview = await withTenant(identity, async (db) => {
    const [payments, expenses, invoices] = await Promise.all([
      db.query(
        `SELECT
           sum(amount_cents) FILTER (WHERE status = 'planned' AND due_date <= now() + interval '30 days') AS upcoming_receivable,
           sum(amount_cents) FILTER (WHERE status = 'paid') AS collected_total,
           count(*) FILTER (WHERE status = 'overdue') AS overdue_count
         FROM finance.payment_plans WHERE tenant_id = platform.current_tenant_id()`
      ),
      db.query(
        `SELECT sum(amount_cents) FILTER (WHERE status IN ('submitted','approved')) AS pending_expenses,
                sum(amount_cents) FILTER (WHERE status = 'paid' AND expense_date >= date_trunc('month', now())) AS month_expenses
         FROM finance.expenses WHERE tenant_id = platform.current_tenant_id()`
      ),
      db.query(
        `SELECT sum(amount_cents - paid_cents) FILTER (WHERE invoice_type = 'receivable' AND status NOT IN ('paid','cancelled')) AS outstanding_receivable
         FROM finance.invoices WHERE tenant_id = platform.current_tenant_id()`
      )
    ]);
    return {
      payments: payments.rows[0],
      expenses: expenses.rows[0],
      invoices: invoices.rows[0]
    };
  });

  json(res, 200, overview);
});

// ── 应收账龄（docs/15 P1-4）：0-30/31-60/61-90/90+ 分桶，security_invoker 视图（随调用者 RLS）
get("/v1/finance/receivables/aging", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const aging = await withTenant(identity, async (db) => {
    const { rows } = await db.query(`SELECT * FROM reporting.v_ar_aging`);
    const r = rows[0] ?? {
      b_0_30: 0, b_31_60: 0, b_61_90: 0, b_over_90: 0,
      cents_0_30: 0, cents_31_60: 0, cents_61_90: 0, cents_over_90: 0, outstanding_cents: 0,
    };
    // 明细：超期未收发票（Top 20）
    const { rows: detail } = await db.query(
      `SELECT invoice_number, counterparty_name, amount_cents, paid_cents,
              (amount_cents - paid_cents) AS outstanding_cents, due_date,
              (current_date - due_date) AS days_overdue
       FROM finance.invoices
       WHERE tenant_id = platform.current_tenant_id()
         AND invoice_type = 'receivable' AND status IN ('sent','partial','overdue','disputed')
         AND current_date > due_date
       ORDER BY days_overdue DESC LIMIT 20`
    );
    return { buckets: r, overdue_detail: detail };
  });
  json(res, 200, aging);
});

// ── 预算占用（docs/15 P1-4）：提交+已批的报销与已批采购对照预算；观测优先（不改变审批语义）
get("/v1/finance/budgets/:id/utilization", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows: [budget] } = await db.query(
      `SELECT ba.*, ou.name AS org_unit_name FROM finance.budget_allocations ba
       LEFT JOIN platform.org_units ou ON ou.tenant_id = ba.tenant_id AND ou.id = ba.org_unit_id
       WHERE ba.tenant_id = platform.current_tenant_id() AND ba.id = $1`, [ctx.params.id]);
    if (!budget) return null;
    const { rows: [expenseUse] } = await db.query(
      `SELECT coalesce(sum(amount_cents) FILTER (WHERE status IN ('submitted','approved','paid')), 0)::bigint AS committed_cents,
              coalesce(sum(amount_cents) FILTER (WHERE status IN ('approved','paid')), 0)::bigint AS approved_cents
       FROM finance.expenses
       WHERE tenant_id = platform.current_tenant_id() AND category = $1
         AND extract(year from expense_date) = $2::int`,
      [budget.category, budget.period_year]
    );
    const committed = Number(expenseUse.committed_cents);
    const budgetCents = Number(budget.budget_cents);
    return {
      budget_id: budget.id, period_label: budget.period_label, category: budget.category,
      org_unit_name: budget.org_unit_name, budget_cents: budgetCents,
      committed_cents: committed, approved_cents: Number(expenseUse.approved_cents),
      remaining_cents: budgetCents - committed,
      utilization_pct: budgetCents > 0 ? Math.round(committed / budgetCents * 10000) / 100 : null,
      over_budget: committed > budgetCents,
    };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

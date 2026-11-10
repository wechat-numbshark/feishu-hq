import { get, post, patch, json } from "../router.ts";
import { withTenant, page, uuid, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { emitEvent } from "../outbox.ts";
import { createApprovalInstance } from "./approvals.ts";
import type { IncomingMessage } from "node:http";

// ═══════════════════════════════════════════════════════════════
// 合同管理（docs/15 P0/P1）：draft→reviewing(审批)→approved→signed→closed。
// 提交评审自动建审批实例（复用审批内核）；签署后可按条款生成收款计划（finance 联动）。
// 订阅计费（SaaS）：MRR 单一事实源，ARR/流失率实时派生。
// 实体归属 sales 模块（modules/sales/module.json），本文件为其 API 实现。
// ═══════════════════════════════════════════════════════════════

function sess(req: IncomingMessage) { return readSession(req.headers.cookie); }

const CONTRACT_FLOW_CODE = "contract";
// 默认单步「直属上级」：保证开箱可走通；管理员可在审批设置里扩展为多步（如 +财务负责人 person 步骤）。
const DEFAULT_CONTRACT_STEPS = [
  { order: 1, type: "manager", label: "直属上级" },
];

// 确保租户存在合同审批流（未配置时落一个默认两步流：直属上级→财务负责人；已有配置不覆盖）。
// 财务负责人步骤未指定 person 时为待指派（approver null），管理员可在审批设置里改为 person 步骤。
async function ensureContractFlow(db: DbClient): Promise<void> {
  await db.query(
    `INSERT INTO platform.approval_flows (id, tenant_id, code, name, module, steps, auto_approve_if_no_approver, is_active)
     VALUES ($1, platform.current_tenant_id(), $2, '销售合同审批', 'sales', $3::jsonb, false, true)
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [uuid(), CONTRACT_FLOW_CODE, JSON.stringify(DEFAULT_CONTRACT_STEPS)]
  );
}

get("/v1/sales/contracts", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT c.*, a.name AS account_name, pe.display_name AS owner_name,
              (SELECT count(*)::int FROM finance.payment_plans pp
               WHERE pp.tenant_id = c.tenant_id AND pp.milestone = '合同:' || c.contract_no) AS payment_plan_count
       FROM sales.contracts c
       JOIN crm.accounts a ON a.tenant_id = c.tenant_id AND a.id = c.account_id
       LEFT JOIN platform.people pe ON pe.tenant_id = c.tenant_id AND pe.id = c.owner_person_id
       WHERE c.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR c.status = $1)
       ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

get("/v1/sales/contracts/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT c.*, a.name AS account_name, pe.display_name AS owner_name
       FROM sales.contracts c
       JOIN crm.accounts a ON a.tenant_id = c.tenant_id AND a.id = c.account_id
       LEFT JOIN platform.people pe ON pe.tenant_id = c.tenant_id AND pe.id = c.owner_person_id
       WHERE c.tenant_id = platform.current_tenant_id() AND c.id = $1`, [ctx.params.id]);
    const contract = rows[0] ?? null;
    if (!contract) return null;
    const { rows: plans } = await db.query(
      `SELECT * FROM finance.payment_plans
       WHERE tenant_id = platform.current_tenant_id() AND milestone = '合同:' || $1
       ORDER BY due_date`, [contract.contract_no]);
    const { rows: subs } = await db.query(
      `SELECT * FROM sales.subscriptions WHERE tenant_id = platform.current_tenant_id() AND contract_id = $1`,
      [contract.id]);
    return { ...contract, payment_plans: plans, subscriptions: subs };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

post("/v1/sales/contracts", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title || !body.account_id || !Number.isFinite(Number(body.amount_cents)) || Number(body.amount_cents) < 0) {
    return json(res, 400, { error: "title_account_amount_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const contractNo = "CT-" + Date.now().toString(36).toUpperCase();
    const { rows } = await db.query(
      `INSERT INTO sales.contracts
         (id, tenant_id, contract_no, title, contract_type, account_id, opportunity_id, project_id,
          amount_cents, currency, payment_terms, start_date, end_date, owner_person_id, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [uuid(), contractNo, body.title, body.contract_type ?? "service", body.account_id,
       body.opportunity_id ?? null, body.project_id ?? null, Math.round(Number(body.amount_cents)),
       body.currency ?? "CNY", body.payment_terms ?? null, body.start_date ?? null, body.end_date ?? null,
       body.owner_person_id ?? identity.personId, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// 起草态可改基本字段
patch("/v1/sales/contracts/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(col + " = $" + vals.length); };
    if (body.title != null) add("title", body.title);
    if (body.contract_type != null) add("contract_type", body.contract_type);
    if (body.amount_cents != null) add("amount_cents", Math.round(Number(body.amount_cents)));
    if (body.payment_terms != null) add("payment_terms", body.payment_terms);
    if (body.start_date !== undefined) add("start_date", body.start_date);
    if (body.end_date !== undefined) add("end_date", body.end_date);
    if (body.notes != null) add("notes", body.notes);
    if (body.owner_person_id !== undefined) add("owner_person_id", body.owner_person_id);
    if (!sets.length) throw new Error("no_fields_to_update");
    add("updated_at", new Date());
    vals.push(ctx.params.id);
    const { rows } = await db.query(
      `UPDATE sales.contracts SET ${sets.join(", ")}
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} AND status = 'draft' RETURNING *`, vals);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "contract_not_draft_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// 提交评审：进入审批流（同事务创建审批实例，fail-closed；无审批人时进入待指派队列）
post("/v1/sales/contracts/:id/submit", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM sales.contracts WHERE tenant_id = platform.current_tenant_id() AND id = $1 FOR UPDATE`,
      [ctx.params.id]);
    const contract = rows[0] ?? null;
    if (!contract) return { code: 404, error: "not_found" };
    if (contract.status !== "draft") return { code: 409, error: "contract_not_draft" };
    await ensureContractFlow(db);
    const { rows: empRows } = await db.query(
      `SELECT manager_person_id FROM platform.employments
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
         AND status != 'terminated' AND deleted_at IS NULL LIMIT 1`,
      [identity.personId]
    );
    const amountYuan = (Number(contract.amount_cents) / 100).toLocaleString("zh-CN");
    const instanceId = await createApprovalInstance(db, {
      tenantId: identity.tenantId,
      flowCode: CONTRACT_FLOW_CODE,
      resourceType: "contract",
      resourceId: contract.id,
      requesterPersonId: identity.personId,
      title: contract.title + "（¥" + amountYuan + "）",
      summary: { contract_no: contract.contract_no, contract_type: contract.contract_type,
                 amount_cents: contract.amount_cents, account_id: contract.account_id },
      managerPersonId: empRows[0]?.manager_person_id ?? null,
    });
    if (!instanceId) throw new Error("contract_flow_unavailable");
    const { rows: updated } = await db.query(
      `UPDATE sales.contracts SET status = 'reviewing', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 RETURNING *`, [contract.id]);
    return { code: 200, contract: updated[0], approval_instance_id: instanceId };
  });
  if (result.code !== 200) return json(res, result.code, { error: result.error, traceId: ctx.traceId });
  json(res, 200, result);
});

// 签署：审批通过后生效
post("/v1/sales/contracts/:id/sign", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE sales.contracts SET status = 'signed', sign_date = COALESCE($2, current_date), signed_at = now(),
              updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'approved' RETURNING *`,
      [ctx.params.id, body.sign_date ?? null]
    );
    const contract = rows[0] ?? null;
    if (contract) {
      await emitEvent(db, identity.tenantId, {
        eventType: "sales.contract.signed.v1", aggregateType: "sales.contracts", aggregateId: contract.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { contract_no: contract.contract_no, amount_cents: contract.amount_cents, account_id: contract.account_id },
      });
    }
    return contract;
  });
  if (!row) return json(res, 409, { error: "contract_not_approved_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

post("/v1/sales/contracts/:id/close", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE sales.contracts SET status = 'closed', closed_at = now(), updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'signed' RETURNING *`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "contract_not_signed_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// 按合同生成收款计划（finance.payment_plans，milestone 前缀「合同:编号」建立关联）
post("/v1/sales/contracts/:id/payment-plans", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const lines = Array.isArray(body.lines) ? body.lines as Record<string, unknown>[] : [];
  if (!lines.length) return json(res, 400, { error: "lines_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows: cRows } = await db.query(
      `SELECT c.*, a.name AS account_name FROM sales.contracts c
       JOIN crm.accounts a ON a.tenant_id = c.tenant_id AND a.id = c.account_id
       WHERE c.tenant_id = platform.current_tenant_id() AND c.id = $1`, [ctx.params.id]);
    const contract = cRows[0] ?? null;
    if (!contract) throw new Error("contract_not_found");
    if (!["approved", "signed"].includes(contract.status)) throw new Error("contract_not_approved_or_signed");
    let sum = 0;
    const created: unknown[] = [];
    for (const l of lines) {
      if (!l.due_date || !Number(l.amount_cents) || !l.milestone_title) throw new Error("line_needs_due_date_amount_milestone_title");
      sum += Math.round(Number(l.amount_cents));
      const { rows } = await db.query(
        `INSERT INTO finance.payment_plans (id, tenant_id, project_id, customer_name, amount_cents, due_date, milestone, status)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, 'planned') RETURNING *`,
        [uuid(), contract.project_id ?? null, contract.account_name, Math.round(Number(l.amount_cents)),
         l.due_date, "合同:" + contract.contract_no]
      );
      created.push(rows[0]);
    }
    if (sum > Number(contract.amount_cents)) throw new Error("payment_plans_exceed_contract_amount");
    return created;
  });
  json(res, 201, { items: rows });
});

// ── 订阅计费（SaaS）─────────────────────────────────────────────

get("/v1/sales/subscriptions", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT s.*, a.name AS account_name FROM sales.subscriptions s
       JOIN crm.accounts a ON a.tenant_id = s.tenant_id AND a.id = s.account_id
       WHERE s.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR s.status = $1)
       ORDER BY s.created_at DESC LIMIT 100`,
      [q.status ?? null]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/sales/subscriptions", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.account_id || !body.plan_name || !Number.isFinite(Number(body.mrr_cents)) || Number(body.mrr_cents) < 0) {
    return json(res, 400, { error: "account_id_plan_mrr_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const subscriptionNo = "SUB-" + Date.now().toString(36).toUpperCase();
    const status = ["trialing", "active"].includes(String(body.status)) ? body.status : "trialing";
    const { rows } = await db.query(
      `INSERT INTO sales.subscriptions
         (id, tenant_id, subscription_no, account_id, contract_id, plan_name, seats, billing_cycle,
          mrr_cents, status, start_date, renewal_date, auto_renew, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [uuid(), subscriptionNo, body.account_id, body.contract_id ?? null, body.plan_name,
       body.seats ?? 1, body.billing_cycle ?? "monthly", Math.round(Number(body.mrr_cents)),
       status, body.start_date ?? new Date().toISOString().slice(0, 10),
       body.renewal_date ?? null, body.auto_renew !== false, body.notes ?? null]
    );
    const sub = rows[0];
    if (sub.status === "active") {
      await emitEvent(db, identity.tenantId, {
        eventType: "sales.subscription.activated.v1", aggregateType: "sales.subscriptions", aggregateId: sub.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { subscription_no: sub.subscription_no, mrr_cents: sub.mrr_cents, account_id: sub.account_id },
      });
    }
    return sub;
  });
  json(res, 201, row);
});

post("/v1/sales/subscriptions/:id/activate", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE sales.subscriptions SET status = 'active', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status IN ('trialing','paused') RETURNING *`,
      [ctx.params.id]);
    const sub = rows[0] ?? null;
    if (sub) {
      await emitEvent(db, identity.tenantId, {
        eventType: "sales.subscription.activated.v1", aggregateType: "sales.subscriptions", aggregateId: sub.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { subscription_no: sub.subscription_no, mrr_cents: sub.mrr_cents, account_id: sub.account_id },
      });
    }
    return sub;
  });
  if (!row) return json(res, 409, { error: "subscription_not_activatable", traceId: ctx.traceId });
  json(res, 200, row);
});

post("/v1/sales/subscriptions/:id/cancel", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE sales.subscriptions SET status = 'churned', churned_at = now(), auto_renew = false,
              updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status IN ('active','trialing','paused') RETURNING *`,
      [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "subscription_not_cancellable", traceId: ctx.traceId });
  json(res, 200, row);
});

// MRR/ARR/流失：从活跃订阅实时聚合（CEO 北极星指标的数据源）
get("/v1/sales/subscriptions/metrics", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const metrics = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active_count,
              coalesce(sum(mrr_cents) FILTER (WHERE status = 'active'), 0)::bigint AS mrr_cents,
              count(*) FILTER (WHERE status = 'churned')::int AS churned_count,
              coalesce(sum(mrr_cents) FILTER (WHERE status = 'churned' AND churned_at >= now() - interval '30 days'), 0)::bigint AS churned_mrr_30d_cents,
              coalesce(sum(seats) FILTER (WHERE status = 'active'), 0)::int AS active_seats,
              count(*) FILTER (WHERE status = 'trialing')::int AS trialing_count,
              count(*) FILTER (WHERE status = 'active' AND renewal_date IS NOT NULL AND renewal_date <= current_date + 30)::int AS renewals_30d
       FROM sales.subscriptions WHERE tenant_id = platform.current_tenant_id()`
    );
    const m = rows[0];
    const churnBase = Number(m.active_count) + Number(m.churned_count);
    return {
      ...m,
      arr_cents: Number(m.mrr_cents) * 12,
      churn_rate_pct: churnBase > 0 ? Math.round(Number(m.churned_count) / churnBase * 10000) / 100 : 0,
    };
  });
  json(res, 200, metrics);
});

import { get, json } from "../router.ts";
import { withTenant, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { effectiveRoles } from "../authz.ts";
import type { SessionIdentity } from "../session.ts";

// ═══════════════════════════════════════════════════════════════
// 高层看板（docs/15 P2-7）：一次调用聚合全部经营域，供管理层驾驶舱与 AI query_dashboard。
// 权限：仅管理层角色（tenant_admin / manager / hr_manager / finance_manager）可见；其余 403。
// 制造/研发等域指标按「有数据才出」动态裁剪——软件公司不显制造 KPI，制造厂不显 MRR。
// ═══════════════════════════════════════════════════════════════

const EXECUTIVE_ROLES = new Set(["tenant_admin", "manager", "hr_manager", "finance_manager"]);

export async function requireExecutiveRole(db: DbClient, identity: SessionIdentity): Promise<boolean> {
  const roles = await effectiveRoles(db, identity);
  return roles.some(r => EXECUTIVE_ROLES.has(r));
}

export async function buildExecutiveDashboard(db: DbClient): Promise<Record<string, unknown>> {
  const [finance, crm, subs, projects, delivery, mfg, hr, it, approvals, leaveAlerts] = await Promise.all([
    db.query(
      `SELECT
         (SELECT coalesce(sum(amount_cents),0) FROM finance.payment_plans WHERE tenant_id = platform.current_tenant_id() AND status = 'paid'
            AND due_date >= date_trunc('month', now()))::bigint AS month_collected_cents,
         (SELECT coalesce(sum(amount_cents),0) FROM finance.expenses WHERE tenant_id = platform.current_tenant_id()
            AND status IN ('paid') AND expense_date >= date_trunc('month', now()))::bigint AS month_expense_cents,
         (SELECT coalesce(sum(amount_cents),0) FROM finance.expenses WHERE tenant_id = platform.current_tenant_id()
            AND status IN ('submitted','approved'))::bigint AS pending_expense_cents,
         (SELECT coalesce(sum(amount_cents - paid_cents),0) FROM finance.invoices WHERE tenant_id = platform.current_tenant_id()
            AND invoice_type = 'receivable' AND status IN ('sent','partial','overdue','disputed'))::bigint AS outstanding_ar_cents`
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE stage NOT IN ('won','lost'))::int AS open_opportunities,
              coalesce(sum(amount_cents) FILTER (WHERE stage NOT IN ('won','lost')),0)::bigint AS pipeline_cents,
              count(*) FILTER (WHERE stage = 'won' AND won_at > now() - interval '90 days')::int AS won_90d,
              count(*) FILTER (WHERE stage IN ('won','lost') AND won_at > now() - interval '90 days')::int AS closed_90d
       FROM crm.opportunities WHERE tenant_id = platform.current_tenant_id()`
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active_count,
              coalesce(sum(mrr_cents) FILTER (WHERE status = 'active'),0)::bigint AS mrr_cents,
              count(*) FILTER (WHERE status = 'churned')::int AS churned_count,
              count(*) FILTER (WHERE status = 'active' AND renewal_date <= current_date + 30)::int AS renewals_30d
       FROM sales.subscriptions WHERE tenant_id = platform.current_tenant_id()`
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active_count,
              count(*) FILTER (WHERE status = 'at_risk')::int AS at_risk_count,
              count(*)::int AS total,
              coalesce(round(avg(progress)),0)::int AS avg_progress
       FROM project.projects WHERE tenant_id = platform.current_tenant_id()`
    ),
    db.query(
      `SELECT (SELECT count(*)::int FROM sw.defects WHERE tenant_id = platform.current_tenant_id()
                 AND status NOT IN ('closed','rejected') AND severity IN ('blocker','critical')) AS critical_defects,
              (SELECT count(*)::int FROM sw.defects WHERE tenant_id = platform.current_tenant_id()
                 AND status NOT IN ('closed','rejected')) AS open_defects,
              (SELECT count(*)::int FROM sw.requirements WHERE tenant_id = platform.current_tenant_id()
                 AND status IN ('new','triaged')) AS backlog_requirements,
              (SELECT count(*)::int FROM sw.iterations WHERE tenant_id = platform.current_tenant_id()
                 AND status = 'active') AS active_iterations,
              (SELECT count(*)::int FROM sw.versions WHERE tenant_id = platform.current_tenant_id()
                 AND status = 'released' AND released_at > now() - interval '30 days') AS releases_30d`
    ),
    db.query(
      `SELECT (SELECT count(*)::int FROM mfg.parts WHERE tenant_id = platform.current_tenant_id()) AS part_count,
              (SELECT count(*)::int FROM mfg.work_orders WHERE tenant_id = platform.current_tenant_id()
                 AND status IN ('released','in_progress')) AS open_work_orders,
              (SELECT coalesce(sum(qty_good),0)::numeric FROM mfg.work_reports WHERE tenant_id = platform.current_tenant_id()) AS good_qty,
              (SELECT coalesce(sum(qty_scrap),0)::numeric FROM mfg.work_reports WHERE tenant_id = platform.current_tenant_id()) AS scrap_qty,
              (SELECT count(*) FILTER (WHERE status = 'completed' AND actual_finish::date <= planned_finish)::int FROM mfg.work_orders
                 WHERE tenant_id = platform.current_tenant_id()) AS on_time_orders,
              (SELECT count(*) FILTER (WHERE status = 'completed' AND planned_finish IS NOT NULL)::int FROM mfg.work_orders
                 WHERE tenant_id = platform.current_tenant_id()) AS finished_planned,
              (SELECT count(*)::int FROM purchase.purchase_orders WHERE tenant_id = platform.current_tenant_id()
                 AND status IN ('draft','pending_approval','approved')) AS open_purchase_orders,
              (SELECT count(*)::int FROM qms.ncrs WHERE tenant_id = platform.current_tenant_id()
                 AND status NOT IN ('closed','cancelled')) AS open_ncrs`
    ),
    db.query(
      `SELECT (SELECT count(*)::int FROM platform.employments WHERE tenant_id = platform.current_tenant_id()
                 AND status = 'active' AND deleted_at IS NULL) AS headcount,
              (SELECT count(*)::int FROM hr.job_requisitions WHERE tenant_id = platform.current_tenant_id()
                 AND status = 'open') AS open_requisitions,
              (SELECT count(*)::int FROM hr.candidates WHERE tenant_id = platform.current_tenant_id()
                 AND status NOT IN ('rejected','withdrawn','hired') AND deleted_at IS NULL) AS active_candidates,
              (SELECT count(*)::int FROM hr.performance_reviews WHERE tenant_id = platform.current_tenant_id()
                 AND status IN ('self_review','pending_review')) AS open_reviews,
              (SELECT coalesce(round(avg(overall_rating),2),0) FROM hr.performance_reviews
                 WHERE tenant_id = platform.current_tenant_id() AND status = 'completed') AS avg_review_rating`
    ),
    db.query(
      `SELECT (SELECT count(*)::int FROM it.assets WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL) AS assets,
              (SELECT count(*)::int FROM it.tickets WHERE tenant_id = platform.current_tenant_id()
                 AND status IN ('open','in_progress','pending')) AS open_tickets,
              (SELECT count(*)::int FROM equipment.assets WHERE tenant_id = platform.current_tenant_id()) AS production_assets`
    ),
    db.query(
      `SELECT count(*)::int AS pending_count FROM platform.approval_instances
       WHERE tenant_id = platform.current_tenant_id() AND status = 'pending'`
    ),
    db.query(
      `SELECT p.display_name, lb.leave_type, lb.used_days,
              (lb.entitled_days + lb.accrued_days + lb.carried_over_days - lb.used_days) AS remaining_days
       FROM hr.leave_balances lb JOIN platform.people p ON p.tenant_id = lb.tenant_id AND p.id = lb.person_id
       WHERE lb.tenant_id = platform.current_tenant_id() AND lb.year = extract(year from current_date)::int
         AND (lb.entitled_days + lb.accrued_days + lb.carried_over_days - lb.used_days) < 0
       ORDER BY lb.used_days DESC LIMIT 10`
    ),
  ]);

  // 账龄（视图按租户一行）
  const { rows: agingRows } = await db.query(`SELECT * FROM reporting.v_ar_aging`);
  const aging = agingRows[0] ?? { cents_0_30: 0, cents_31_60: 0, cents_61_90: 0, cents_over_90: 0, outstanding_cents: 0 };

  const f = finance.rows[0];
  const c = crm.rows[0];
  const s = subs.rows[0];
  const m = mfg.rows[0];
  const mrr = Number(s.mrr_cents);

  const hasMfg = Number(m.part_count) > 0 || Number(m.open_work_orders) > 0 || Number(m.finished_planned) > 0;
  const good = Number(m.good_qty); const scrap = Number(m.scrap_qty);
  const dashboard: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    finance: {
      month_collected_cents: Number(f.month_collected_cents),
      month_expense_cents: Number(f.month_expense_cents),
      pending_expense_cents: Number(f.pending_expense_cents),
      outstanding_ar_cents: Number(f.outstanding_ar_cents),
      ar_aging_cents: {
        d_0_30: Number(aging.cents_0_30), d_31_60: Number(aging.cents_31_60),
        d_61_90: Number(aging.cents_61_90), d_over_90: Number(aging.cents_over_90),
      },
    },
    sales: {
      open_opportunities: Number(c.open_opportunities),
      pipeline_cents: Number(c.pipeline_cents),
      won_90d: Number(c.won_90d),
      win_rate_90d_pct: Number(c.closed_90d) > 0
        ? Math.round(Number(c.won_90d) / Number(c.closed_90d) * 10000) / 100 : null,
    },
    subscriptions: Number(s.active_count) > 0 || Number(s.churned_count) > 0 ? {
      active_count: Number(s.active_count),
      mrr_cents: mrr,
      arr_cents: mrr * 12,
      churned_count: Number(s.churned_count),
      renewals_due_30d: Number(s.renewals_30d),
    } : null,
    projects: {
      active_count: Number(projects.rows[0].active_count),
      at_risk_count: Number(projects.rows[0].at_risk_count),
      total: Number(projects.rows[0].total),
      avg_progress: Number(projects.rows[0].avg_progress),
    },
    delivery: Number(delivery.rows[0].open_defects) > 0 || Number(delivery.rows[0].active_iterations) > 0
      || Number(delivery.rows[0].backlog_requirements) > 0 ? {
      critical_defects: Number(delivery.rows[0].critical_defects),
      open_defects: Number(delivery.rows[0].open_defects),
      backlog_requirements: Number(delivery.rows[0].backlog_requirements),
      active_iterations: Number(delivery.rows[0].active_iterations),
      releases_30d: Number(delivery.rows[0].releases_30d),
    } : null,
    manufacturing: hasMfg ? {
      open_work_orders: Number(m.open_work_orders),
      quality_yield_pct: good + scrap > 0 ? Math.round(good / (good + scrap) * 10000) / 100 : null,
      otd_pct: Number(m.finished_planned) > 0
        ? Math.round(Number(m.on_time_orders) / Number(m.finished_planned) * 10000) / 100 : null,
      open_purchase_orders: Number(m.open_purchase_orders),
      open_ncrs: Number(m.open_ncrs),
    } : null,
    hr: {
      headcount: Number(hr.rows[0].headcount),
      open_requisitions: Number(hr.rows[0].open_requisitions),
      active_candidates: Number(hr.rows[0].active_candidates),
      open_reviews: Number(hr.rows[0].open_reviews),
      avg_review_rating: Number(hr.rows[0].avg_review_rating),
    },
    it: {
      assets: Number(it.rows[0].assets),
      open_tickets: Number(it.rows[0].open_tickets),
      production_assets: Number(it.rows[0].production_assets),
    },
    approvals_pending: Number(approvals.rows[0].pending_count),
    leave_alerts: leaveAlerts.rows.map((r: { display_name: string; leave_type: string; used_days: string; remaining_days: string }) => ({
      person_name: r.display_name, leave_type: r.leave_type,
      used_days: Number(r.used_days), remaining_days: Number(r.remaining_days),
    })),
  };
  return dashboard;
}

get("/v1/dashboard/executive", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const dashboard = await withTenant(identity, async (db) => {
    const allowed = await requireExecutiveRole(db, identity);
    if (!allowed) throw new Error("permission_denied");
    return buildExecutiveDashboard(db);
  });
  json(res, 200, dashboard);
});

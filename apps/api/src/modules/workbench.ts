import { get, json } from "../router.ts";
import { withTenant, uuid, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { effectiveRoles } from "../authz.ts";
import type { SessionIdentity } from "../session.ts";
import { demoPersonaOf } from "../demo.ts";

// ═══════════════════════════════════════════════════════════════
// 我的工作台（docs/17 岗位细节）：一次调用聚合"我的卡片 + 岗位专属区块"。
// 区块可见性 = 真实角色（manager/hr_manager/finance_manager/tenant_admin）
//            ∪ 演示岗位标签（production/purchase/quality/sales/rnd/it/product/hr/exec）。
// 数据域遵循既有行级策略（本人/本团队），敏感聚合仅管理层角色可见。
// ═══════════════════════════════════════════════════════════════

const ROLE_LABELS: Record<string, string> = {
  tenant_admin: "企业管理员", hr_manager: "人事管理员", finance_manager: "财务管理员", manager: "部门主管", employee: "员工",
};

async function buildWorkbench(db: DbClient, identity: SessionIdentity) {
  const roles = await effectiveRoles(db, identity);
  const persona = demoPersonaOf(identity as never);
  const tags = new Set(persona?.tags ?? []);
  const isAdmin = roles.includes("tenant_admin");
  const isManager = isAdmin || roles.includes("manager");
  const isHr = isAdmin || roles.includes("hr_manager");
  const isFinance = isAdmin || roles.includes("finance_manager");
  const year = new Date().getFullYear();
  const me = identity.personId;

  const [personRow, attendance, tasks, balances, expenses, myApprovals, teamTasks] = await Promise.all([
    db.query(
      `SELECT p.display_name, ou.name AS org_name FROM platform.people p
       LEFT JOIN platform.employments e ON e.tenant_id = p.tenant_id AND e.person_id = p.id AND e.deleted_at IS NULL AND e.status = 'active'
       LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
       WHERE p.tenant_id = platform.current_tenant_id() AND p.id = $1`, [me]),
    db.query(
      `SELECT check_in::text AS check_in, check_out::text AS check_out FROM hr.attendance_records
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1 AND date = current_date`, [me]),
    db.query(
      `SELECT t.id, t.title, t.status, t.priority, t.due_date, p.name AS project_name
       FROM project.tasks t JOIN project.projects p ON p.tenant_id = t.tenant_id AND p.id = t.project_id
       WHERE t.tenant_id = platform.current_tenant_id() AND t.assignee_person_id = $1
         AND t.status IN ('todo','in_progress') AND t.deleted_at IS NULL
       ORDER BY t.due_date ASC NULLS LAST LIMIT 6`, [me]),
    db.query(
      `SELECT leave_type, entitled_days + accrued_days + carried_over_days - used_days AS remaining_days
       FROM hr.leave_balances
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1 AND year = $2::int
       ORDER BY leave_type`, [me, year]),
    db.query(
      `SELECT count(*)::int AS pending_count, coalesce(sum(amount_cents),0)::bigint AS pending_cents
       FROM finance.expenses
       WHERE tenant_id = platform.current_tenant_id() AND submitter_person_id = $1 AND status IN ('submitted','approved')`, [me]),
    db.query(
      `SELECT count(*)::int AS n FROM platform.approval_instances ai
       JOIN platform.approval_actions aa ON aa.instance_id = ai.id AND aa.status = 'pending' AND aa.step_order = ai.current_step
       WHERE ai.tenant_id = platform.current_tenant_id() AND ai.status = 'pending'
         AND (aa.approver_person_id = $1 OR aa.approver_person_id IS NULL)`, [me]),
    // 主管：直属团队的开放任务（负荷）
    db.query(
      `SELECT count(*)::int AS n FROM project.tasks t
       JOIN platform.employments e ON e.tenant_id = t.tenant_id AND e.person_id = t.assignee_person_id
         AND e.manager_person_id = $1 AND e.status = 'active' AND e.deleted_at IS NULL
       WHERE t.tenant_id = platform.current_tenant_id() AND t.status IN ('todo','in_progress') AND t.deleted_at IS NULL`, [me]),
  ]);

  const wb: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    person: {
      person_id: me,
      name: personRow.rows[0]?.display_name ?? "—",
      org: personRow.rows[0]?.org_name ?? "—",
      role_labels: roles.map(r => ROLE_LABELS[r] ?? r),
      demo_persona: persona ? { title: persona.title, duty: persona.duty, tags: persona.tags } : null,
    },
    cards: {
      attendance_today: attendance.rows[0] ?? null,
      my_tasks: {
        list: tasks.rows,
        due_this_week: tasks.rows.filter(t => t.due_date && new Date(String(t.due_date)) <= new Date(Date.now() + 7 * 86400000)).length,
      },
      my_leave_balances: balances.rows,
      my_expenses: expenses.rows[0],
      approvals_waiting_me: Number(myApprovals.rows[0]?.n ?? 0),
    },
    sections: {} as Record<string, unknown>,
  };
  const sections = wb.sections as Record<string, unknown>;

  // ── 主管/管理员：审批与团队 ──
  if (isManager) {
    const [approvals, milestones] = await Promise.all([
      db.query(
        `SELECT ai.id, ai.title, ai.resource_type, ai.created_at,
                p.display_name AS requester_name
         FROM platform.approval_instances ai
         JOIN platform.approval_actions aa ON aa.instance_id = ai.id AND aa.status = 'pending' AND aa.step_order = ai.current_step
         JOIN platform.people p ON p.tenant_id = ai.tenant_id AND p.id = ai.requester_person_id
         WHERE ai.tenant_id = platform.current_tenant_id() AND ai.status = 'pending'
           AND (aa.approver_person_id IS NULL OR aa.approver_person_id = $1)
         ORDER BY ai.created_at ASC LIMIT 8`, [me]),
      db.query(
        `SELECT m.name, m.due_date, pr.name AS project_name FROM project.milestones m
         JOIN project.projects pr ON pr.tenant_id = m.tenant_id AND pr.id = m.project_id
         WHERE m.tenant_id = platform.current_tenant_id() AND m.status IN ('pending','in_progress')
           AND m.due_date <= current_date + 30
         ORDER BY m.due_date LIMIT 6`),
    ]);
    sections.manager = {
      pending_approvals: approvals.rows,
      milestones_due_30d: milestones.rows,
      team_open_tasks: Number(teamTasks.rows[0]?.n ?? 0),
    };
  }

  // ── 财务：账龄/预算/发票 ──
  if (isFinance) {
    const [aging, budgets, invoices] = await Promise.all([
      db.query(`SELECT * FROM reporting.v_ar_aging`),
      db.query(
        `SELECT ba.id, ba.period_label, ba.category, ba.total_amount_cents, ba.spent_cents, ou.name AS org_name,
                coalesce((SELECT sum(e.amount_cents) FROM finance.expenses e
                          WHERE e.tenant_id = ba.tenant_id AND e.category = ba.category
                            AND e.status IN ('submitted','approved','paid')
                            AND extract(year from e.expense_date) = ba.period_year), 0)::bigint AS committed_cents
         FROM finance.budget_allocations ba LEFT JOIN platform.org_units ou ON ou.tenant_id = ba.tenant_id AND ou.id = ba.org_unit_id
         WHERE ba.tenant_id = platform.current_tenant_id() AND ba.status != 'closed'
         ORDER BY ba.period_year DESC, ba.total_amount_cents DESC LIMIT 8`),
      db.query(
        `SELECT count(*)::int AS n FROM finance.invoices
         WHERE tenant_id = platform.current_tenant_id() AND invoice_type = 'receivable'
           AND status IN ('sent','partial','overdue')`),
    ]);
    const a = aging.rows[0] ?? {};
    const budgetItems = budgets.rows.map((b: Record<string, unknown>) => ({
      ...b,
      utilization_pct: Number(b.total_amount_cents) > 0
        ? Math.round(Number(b.committed_cents) / Number(b.total_amount_cents) * 10000) / 100 : null,
      over_budget: Number(b.committed_cents) > Number(b.total_amount_cents),
    }));
    sections.finance = {
      ar_over_90_cents: Number(a.cents_over_90 ?? 0),
      ar_outstanding_cents: Number(a.outstanding_cents ?? 0),
      unpaid_receivable_invoices: Number(invoices.rows[0]?.n ?? 0),
      budgets: budgetItems,
      over_budget_count: budgetItems.filter((b: { over_budget: boolean }) => b.over_budget).length,
    };
  }

  // ── HR：招聘/转正/绩效 ──
  if (isHr) {
    const [reqs, candidates, probation, reviews] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS n FROM hr.job_requisitions WHERE tenant_id = platform.current_tenant_id() AND status = 'open'`),
      db.query(
        `SELECT count(*)::int AS n FROM hr.candidates WHERE tenant_id = platform.current_tenant_id()
           AND status NOT IN ('rejected','withdrawn','hired') AND deleted_at IS NULL`),
      // 试用期推算：入职 + 6 个月（无显式字段，口径在 docs/17 说明）
      db.query(
        `SELECT p.display_name, ou.name AS org_name,
                (e.start_date + interval '6 months')::date AS probation_end
         FROM platform.employments e
         JOIN platform.people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
         LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
         WHERE e.tenant_id = platform.current_tenant_id() AND e.status = 'active' AND e.deleted_at IS NULL
           AND e.start_date + interval '6 months' BETWEEN current_date - 7 AND current_date + 30
         ORDER BY probation_end LIMIT 6`),
      db.query(
        `SELECT count(*)::int AS n FROM hr.performance_reviews
         WHERE tenant_id = platform.current_tenant_id() AND status IN ('self_review','pending_review')`),
    ]);
    sections.hr = {
      open_requisitions: Number(reqs.rows[0]?.n ?? 0),
      active_candidates: Number(candidates.rows[0]?.n ?? 0),
      probation_due: probation.rows,
      open_reviews: Number(reviews.rows[0]?.n ?? 0),
    };
  }

  // ── IT：许可到期 / 工单时效 ──
  if (tags.has("it") || isAdmin) {
    const [licenses, tickets] = await Promise.all([
      db.query(
        `SELECT software_name, total_seats, expiry_date, renewal_cost_cents FROM it.software_licenses
         WHERE tenant_id = platform.current_tenant_id() AND status = 'active'
           AND expiry_date IS NOT NULL AND expiry_date <= current_date + 60
         ORDER BY expiry_date LIMIT 6`),
      db.query(
        `SELECT count(*)::int AS aging FROM it.tickets
         WHERE tenant_id = platform.current_tenant_id() AND status IN ('open','in_progress')
           AND created_at < now() - interval '48 hours'`),
    ]);
    sections.it = {
      licenses_expiring_60d: licenses.rows,
      tickets_aging_48h: Number(tickets.rows[0]?.aging ?? 0),
    };
  }

  // ── 生产（工艺/生产主管/管理员）──
  if (tags.has("production") || isAdmin) {
    const [wos, pos] = await Promise.all([
      db.query(
        `SELECT wo_number, status, planned_qty, completed_qty, planned_finish FROM mfg.work_orders
         WHERE tenant_id = platform.current_tenant_id() AND status IN ('released','in_progress')
         ORDER BY planned_finish LIMIT 6`),
      db.query(
        `SELECT count(*)::int AS n FROM purchase.purchase_orders
         WHERE tenant_id = platform.current_tenant_id() AND status IN ('draft','approved')`),
    ]);
    sections.production = { open_work_orders: wos.rows, open_purchase_orders: Number(pos.rows[0]?.n ?? 0) };
  }

  // ── 采购 ──
  if (tags.has("purchase") || isAdmin) {
    const prs = await db.query(
      `SELECT pr_number, status, total_amount_cents, need_date FROM purchase.requisitions
       WHERE tenant_id = platform.current_tenant_id() AND status IN ('draft','submitted','approved')
       ORDER BY created_at DESC LIMIT 6`);
    sections.purchase = { my_requisitions: prs.rows };
  }

  // ── 质量 ──
  if (tags.has("quality") || isAdmin) {
    const ncrs = await db.query(
      `SELECT ncr_number, status, quantity, created_at FROM qms.ncrs
       WHERE tenant_id = platform.current_tenant_id() AND status NOT IN ('closed','cancelled')
       ORDER BY created_at DESC LIMIT 6`);
    sections.quality = { open_ncrs: ncrs.rows };
  }

  // ── 销售（销售岗看本人，主管/管理员看全部）──
  if (tags.has("sales") || tags.has("product") || isManager) {
    const scope = isManager ? null : me;
    const [stale, pipeline] = await Promise.all([
      db.query(
        `SELECT o.id, o.name, o.customer_name, o.amount_cents, o.stage,
                p.display_name AS owner_name,
                coalesce((SELECT max(a.created_at) FROM crm.activities a
                          WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.id), o.created_at) AS last_touch
         FROM crm.opportunities o
         LEFT JOIN platform.people p ON p.tenant_id = o.tenant_id AND p.id = o.owner_person_id
         WHERE o.tenant_id = platform.current_tenant_id()
           AND o.stage NOT IN ('won','lost')
           AND ($1::uuid IS NULL OR o.owner_person_id = $1)
           AND coalesce((SELECT max(a.created_at) FROM crm.activities a
                         WHERE a.tenant_id = o.tenant_id AND a.opportunity_id = o.id), o.created_at) < now() - interval '14 days'
         ORDER BY last_touch ASC LIMIT 6`, [scope]),
      db.query(
        `SELECT coalesce(sum(amount_cents),0)::bigint AS cents FROM crm.opportunities
         WHERE tenant_id = platform.current_tenant_id() AND stage NOT IN ('won','lost')
           AND ($1::uuid IS NULL OR owner_person_id = $1)`, [scope]),
    ]);
    sections.sales = { stale_opportunities: stale.rows, pipeline_cents: Number(pipeline.rows[0]?.cents ?? 0) };
  }

  // ── 研发 ──
  if (tags.has("rnd") || tags.has("product") || isManager) {
    const [myDefects, iterations, backlog] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS n FROM sw.defects
         WHERE tenant_id = platform.current_tenant_id() AND assignee_person_id = $1
           AND status NOT IN ('closed','rejected')`, [me]),
      db.query(
        `SELECT i.name, i.status, i.start_date, i.end_date, pr.name AS project_name,
                (SELECT coalesce(sum(coalesce(ii.story_points, t.story_points)),0)::int
                 FROM sw.iteration_items ii JOIN project.tasks t ON t.tenant_id = ii.tenant_id AND t.id = ii.task_id
                 WHERE ii.tenant_id = i.tenant_id AND ii.iteration_id = i.id) AS total_points,
                (SELECT coalesce(sum(coalesce(ii.story_points, t.story_points)),0)::int
                 FROM sw.iteration_items ii JOIN project.tasks t ON t.tenant_id = ii.tenant_id AND t.id = ii.task_id
                 WHERE ii.tenant_id = i.tenant_id AND ii.iteration_id = i.id AND t.status = 'done') AS done_points
         FROM sw.iterations i JOIN project.projects pr ON pr.tenant_id = i.tenant_id AND pr.id = i.project_id
         WHERE i.tenant_id = platform.current_tenant_id() AND i.status = 'active'
         ORDER BY i.end_date LIMIT 3`),
      db.query(
        `SELECT count(*)::int AS n FROM sw.requirements
         WHERE tenant_id = platform.current_tenant_id() AND status IN ('new','triaged')`),
    ]);
    sections.rnd = {
      my_open_defects: Number(myDefects.rows[0]?.n ?? 0),
      active_iterations: iterations.rows,
      backlog_requirements: Number(backlog.rows[0]?.n ?? 0),
    };
  }

  // 工作台访问审计（轻量，一次一条）
  await db.query(
    `INSERT INTO audit.audit_events (id, tenant_id, actor_id, action, resource_type, outcome, client_context, trace_id)
     VALUES ($1, platform.current_tenant_id(), $2, 'workbench.viewed', 'workbench', 'success', '{"mode":"ui"}'::jsonb, $3)`,
    [uuid(), me, me]
  ).catch(() => undefined);
  return wb;
}

get("/v1/workbench", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const wb = await withTenant(identity, async (db) => buildWorkbench(db, identity));
  json(res, 200, wb);
});

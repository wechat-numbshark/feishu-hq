import { get, json } from "../router.ts";
import { withTenant, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { effectiveRoles } from "../authz.ts";
import type { SessionIdentity } from "../session.ts";

// ═══════════════════════════════════════════════════════════════
// 个人全景（docs/19 P1）：一个人的全部工作足迹，一次聚合。
// 视野：full = 本人/直属主管/hr_manager/tenant_admin；limited = 其他同事（公开面）。
// 敏感面（薪资）不进全景，继续走 ABAC 字段策略。
// ═══════════════════════════════════════════════════════════════

async function buildPanorama(db: Parameters<Parameters<typeof withTenant>[1]>[0], viewer: SessionIdentity, targetId: string) {
  const viewerRoles = await effectiveRoles(db, viewer);
  const isPrivileged = viewerRoles.some(r => ["tenant_admin", "hr_manager", "manager"].includes(r));
  const isSelf = viewer.personId === targetId;
  let isManagerOfTarget = false;
  if (!isPrivileged && !isSelf) {
    const { rows } = await db.query(
      `SELECT 1 FROM platform.employments
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
         AND manager_person_id = $2 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
      [targetId, viewer.personId]);
    isManagerOfTarget = !!rows[0];
  }
  const full = isSelf || isPrivileged || isManagerOfTarget;
  const year = new Date().getFullYear();

  const [person, krs, initiatives, projects, tasks, defects, requirements] = await Promise.all([
    db.query(
      `SELECT p.display_name, p.primary_email, ou.name AS org_name, e.start_date, e.employee_number,
              (current_date - e.start_date) AS tenure_days
       FROM platform.people p
       LEFT JOIN platform.employments e ON e.tenant_id = p.tenant_id AND e.person_id = p.id AND e.deleted_at IS NULL AND e.status = 'active'
       LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
       WHERE p.tenant_id = platform.current_tenant_id() AND p.id = $1`, [targetId]),
    db.query(
      `SELECT kr.id, kr.title, kr.progress, kr.target_value, kr.current_value, kr.unit, kr.metric_source,
              o.title AS objective_title, pe.display_name AS owner_name
       FROM strategy.key_results kr
       JOIN strategy.objectives o ON o.tenant_id = kr.tenant_id AND o.id = kr.objective_id
       LEFT JOIN platform.people pe ON pe.tenant_id = kr.tenant_id AND pe.id = kr.owner_person_id
       WHERE kr.tenant_id = platform.current_tenant_id() AND kr.owner_person_id = $1 AND kr.status = 'active'
       ORDER BY kr.progress DESC LIMIT 8`, [targetId]),
    db.query(
      `SELECT i.id, i.title, i.status, i.due_date, o.title AS kr_title
       FROM strategy.initiatives i
       JOIN strategy.key_results kr ON kr.tenant_id = i.tenant_id AND kr.id = i.key_result_id
       LEFT JOIN strategy.objectives o ON o.tenant_id = kr.tenant_id AND o.id = kr.objective_id
       WHERE i.tenant_id = platform.current_tenant_id() AND i.owner_person_id = $1
       ORDER BY i.due_date NULLS LAST LIMIT 8`, [targetId]),
    db.query(
      `SELECT DISTINCT pr.id, pr.code, pr.name, pr.status, pr.progress, pr.owner_person_id,
              CASE WHEN pr.owner_person_id = $1 THEN 'owner' ELSE 'member' END AS role
       FROM project.projects pr
       LEFT JOIN project.project_members m ON m.tenant_id = pr.tenant_id AND m.project_id = pr.id AND m.person_id = $1
       WHERE pr.tenant_id = platform.current_tenant_id()
         AND (pr.owner_person_id = $1 OR m.id IS NOT NULL)
       ORDER BY pr.progress DESC LIMIT 10`, [targetId]),
    db.query(
      `SELECT count(*) FILTER (WHERE status IN ('todo','in_progress'))::int AS open_count,
              count(*) FILTER (WHERE status = 'done' AND updated_at > now() - interval '30 days')::int AS done_30d,
              coalesce(sum(actual_hours), 0)::numeric AS total_hours
       FROM project.tasks
       WHERE tenant_id = platform.current_tenant_id() AND assignee_person_id = $1 AND deleted_at IS NULL`, [targetId]),
    db.query(
      `SELECT count(*) FILTER (WHERE status NOT IN ('closed','rejected'))::int AS open_count,
              count(*) FILTER (WHERE status IN ('verified','closed') AND resolved_at > now() - interval '30 days')::int AS closed_30d
       FROM sw.defects WHERE tenant_id = platform.current_tenant_id() AND assignee_person_id = $1`, [targetId]),
    db.query(
      `SELECT count(*)::int AS owned FROM sw.requirements
       WHERE tenant_id = platform.current_tenant_id() AND owner_person_id = $1 AND status NOT IN ('done','rejected')`, [targetId]),
  ]);
  if (!person.rows[0]) return null;
  const p = person.rows[0];

  const panorama: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    visibility: full ? "full" : "limited",
    person: {
      person_id: targetId, name: p.display_name, email: p.primary_email,
      org: p.org_name ?? "—", employee_number: p.employee_number,
      tenure_days: p.tenure_days != null ? Number(p.tenure_days) : null,
      start_date: p.start_date,
    },
    okr: { key_results: krs.rows, initiatives: initiatives.rows },
    projects: {
      items: projects.rows,
      tasks_open: Number(tasks.rows[0].open_count),
      tasks_done_30d: Number(tasks.rows[0].done_30d),
      total_hours: Number(tasks.rows[0].total_hours),
    },
    delivery: {
      defects_open: Number(defects.rows[0].open_count),
      defects_closed_30d: Number(defects.rows[0].closed_30d),
      requirements_owned: Number(requirements.rows[0].owned),
    },
  };

  if (full) {
    const [approvalsMine, approvalsWaiting, expenses, attendance, reviews, aiUsage] = await Promise.all([
      db.query(
        `SELECT ai.id, ai.title, ai.status, ai.created_at FROM platform.approval_instances ai
         WHERE ai.tenant_id = platform.current_tenant_id() AND ai.requester_person_id = $1
         ORDER BY ai.created_at DESC LIMIT 10`, [targetId]),
      db.query(
        `SELECT count(*)::int AS n FROM platform.approval_instances ai
         JOIN platform.approval_actions aa ON aa.instance_id = ai.id AND aa.status = 'pending' AND aa.step_order = ai.current_step
         WHERE ai.tenant_id = platform.current_tenant_id() AND ai.status = 'pending' AND aa.approver_person_id = $1`, [targetId]),
      db.query(
        `SELECT coalesce(sum(amount_cents) FILTER (WHERE expense_date >= date_trunc('month', now())),0)::bigint AS month_cents,
                coalesce(sum(amount_cents) FILTER (WHERE status IN ('submitted','approved')),0)::bigint AS pending_cents
         FROM finance.expenses WHERE tenant_id = platform.current_tenant_id() AND submitter_person_id = $1`, [targetId]),
      db.query(
        `SELECT count(*) FILTER (WHERE source <> 'makeup')::int AS present_days,
                count(*) FILTER (WHERE source = 'makeup')::int AS makeup_days
         FROM hr.attendance_records
         WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
           AND extract(year from date) = $2::int AND extract(month from date) = extract(month from current_date)`, [targetId, year]),
      db.query(
        `SELECT cycle, status, overall_rating, completed_at FROM hr.performance_reviews
         WHERE tenant_id = platform.current_tenant_id() AND reviewee_person_id = $1
         ORDER BY created_at DESC LIMIT 5`, [targetId]),
      db.query(
        `SELECT (SELECT count(*)::int FROM platform.ai_conversations WHERE tenant_id = platform.current_tenant_id() AND person_id = $1) AS conversations,
                (SELECT count(*)::int FROM audit.audit_events WHERE tenant_id = platform.current_tenant_id() AND actor_id = 'ai:' || $1 AND action = 'ai.tool.execute') AS tool_calls`,
        [targetId]),
    ]);
    panorama.approvals = { initiated: approvalsMine.rows, waiting_me: Number(approvalsWaiting.rows[0].n) };
    panorama.finance = expenses.rows[0];
    panorama.attendance_this_month = attendance.rows[0];
    panorama.reviews = reviews.rows;
    panorama.ai_usage = aiUsage.rows[0];
  }
  return panorama;
}

get("/v1/people/:id/panorama", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const panorama = await withTenant(identity, async (db) => buildPanorama(db, identity, ctx.params.id));
  if (!panorama) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, panorama);
});

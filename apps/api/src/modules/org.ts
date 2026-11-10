import { get, patch, json } from "../router.ts";
import { withTenant, uuid, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { effectiveRoles, hasCapability } from "../authz.ts";
import { requireExecutiveRole, buildExecutiveDashboard } from "./dashboard.ts";

// ═══════════════════════════════════════════════════════════════
// 四级全景（docs/19）：个人(people.ts) → 团队 → 部门 → 公司。
// 组织树与飞书一致（source_of_truth='feishu'），支持本地灵活调整（PATCH 改名称/主管/挂靠，调整留审计）。
// ═══════════════════════════════════════════════════════════════

interface OrgNode { id: string; name: string; type: string; parent_id: string | null; manager: { person_id: string; name: string } | null; headcount: number; children: OrgNode[] }

get("/v1/org/tree", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const tree = await withTenant(identity, async (db) => {
    const { rows: units } = await db.query(
      `SELECT ou.id, ou.name, ou.type, ou.parent_id, ou.source_of_truth,
              p.id AS manager_id, p.display_name AS manager_name,
              (SELECT count(*)::int FROM platform.employments e WHERE e.tenant_id = ou.tenant_id AND e.org_unit_id = ou.id AND e.status = 'active' AND e.deleted_at IS NULL) AS headcount
       FROM platform.org_units ou
       LEFT JOIN platform.people p ON p.tenant_id = ou.tenant_id AND p.id = ou.manager_person_id
       WHERE ou.tenant_id = platform.current_tenant_id() AND ou.status = 'active' AND ou.deleted_at IS NULL
       ORDER BY ou.created_at`);
    const byId = new Map<string, OrgNode>();
    for (const u of units) {
      byId.set(u.id, {
        id: u.id, name: u.name, type: u.type, parent_id: u.parent_id, headcount: Number(u.headcount),
        manager: u.manager_id ? { person_id: u.manager_id, name: u.manager_name } : null,
        children: [],
      });
    }
    const roots: OrgNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
      if (parent) parent.children.push(node); else roots.push(node);
    }
    return { roots, total_units: units.length, source_note: "组织数据与飞书通讯录同步（source_of_truth=feishu 的节点随同步刷新）；本地可调整名称/主管/挂靠，调整记审计" };
  });
  json(res, 200, tree);
});

// 部门调整（管理员）：名称/主管/挂靠——灵活自治，全程审计
patch("/v1/org/units/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    const roles = await effectiveRoles(db, identity);
    if (!hasCapability(roles, "people.manage_roles") && !hasCapability(roles, "org.manage")) {
      throw new Error("permission_denied");
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (body.name != null) add("name", body.name);
    if (body.manager_person_id !== undefined) add("manager_person_id", body.manager_person_id);
    if (body.parent_id !== undefined) {
      if (body.parent_id === ctx.params.id) throw new Error("parent_cycle_not_allowed");
      // 沿新父链向上走，若遇到自身即成环
      if (body.parent_id) {
        let cursor = String(body.parent_id);
        for (let depth = 0; depth < 20 && cursor; depth++) {
          if (cursor === ctx.params.id) throw new Error("parent_cycle_not_allowed");
          const { rows: [up] } = await db.query(
            `SELECT parent_id FROM platform.org_units WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [cursor]);
          cursor = up?.parent_id ?? null;
        }
      }
      add("parent_id", body.parent_id);
    }
    if (body.type != null && ["company", "division", "department", "team", "virtual"].includes(String(body.type))) add("type", body.type);
    if (!sets.length) throw new Error("no_fields_to_update");
    add("updated_at", new Date());
    vals.push(ctx.params.id);
    const { rows } = await db.query(
      `UPDATE platform.org_units SET ${sets.join(", ")}, version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} AND deleted_at IS NULL RETURNING *`, vals);
    const unit = rows[0] ?? null;
    if (unit) {
      await db.query(
        `INSERT INTO audit.audit_events (id, tenant_id, actor_id, action, resource_id, resource_type, outcome, change_summary, client_context, trace_id)
         VALUES ($1, platform.current_tenant_id(), $2, 'org.unit.adjusted', $3, 'org_unit', 'success', $4::jsonb, '{"mode":"ui"}'::jsonb, $5)`,
        [uuid(), identity.personId, unit.id, JSON.stringify({ changes: body }), ctx.traceId]);
    }
    return unit;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// 部门全景：成员工作足迹聚合（full=主管/HR/管理员；limited=同事仅公开面）
get("/v1/org/units/:id/panorama", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const viewerRoles = await effectiveRoles(db, identity);
    const { rows: [unit] } = await db.query(
      `SELECT ou.*, p.display_name AS manager_name FROM platform.org_units ou
       LEFT JOIN platform.people p ON p.tenant_id = ou.tenant_id AND p.id = ou.manager_person_id
       WHERE ou.tenant_id = platform.current_tenant_id() AND ou.id = $1 AND ou.deleted_at IS NULL`, [ctx.params.id]);
    if (!unit) return null;
    const full = viewerRoles.includes("tenant_admin") || viewerRoles.some(r => ["hr_manager", "manager"].includes(r))
      || unit.manager_person_id === identity.personId;

    const { rows: members } = await db.query(
      `SELECT p.id AS person_id, p.display_name, e.employee_number,
              (SELECT count(*)::int FROM project.tasks t WHERE t.tenant_id = e.tenant_id AND t.assignee_person_id = p.id AND t.status IN ('todo','in_progress') AND t.deleted_at IS NULL) AS open_tasks,
              (SELECT count(*)::int FROM project.tasks t WHERE t.tenant_id = e.tenant_id AND t.assignee_person_id = p.id AND t.status = 'done' AND t.updated_at > now() - interval '30 days' AND t.deleted_at IS NULL) AS done_30d,
              (SELECT count(*)::int FROM sw.defects d WHERE d.tenant_id = e.tenant_id AND d.assignee_person_id = p.id AND d.status NOT IN ('closed','rejected')) AS open_defects
       FROM platform.employments e JOIN platform.people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
       WHERE e.tenant_id = platform.current_tenant_id() AND e.org_unit_id = $1 AND e.status = 'active' AND e.deleted_at IS NULL
       ORDER BY p.display_name`, [ctx.params.id]);

    const { rows: [projAgg] } = await db.query(
      `SELECT count(DISTINCT pr.id)::int AS projects
       FROM project.projects pr
       LEFT JOIN project.project_members m ON m.tenant_id = pr.tenant_id AND m.project_id = pr.id
       JOIN platform.employments e ON e.tenant_id = pr.tenant_id AND e.person_id = pr.owner_person_id AND e.org_unit_id = $1
       WHERE pr.tenant_id = platform.current_tenant_id() AND pr.status IN ('active','at_risk')`, [ctx.params.id]);

    const panorama: Record<string, unknown> = {
      generated_at: new Date().toISOString(),
      visibility: full ? "full" : "limited",
      unit: { id: unit.id, name: unit.name, type: unit.type, manager_name: unit.manager_name, source_of_truth: unit.source_of_truth },
      headcount: members.length,
      totals: {
        open_tasks: members.reduce((s, m) => s + Number(m.open_tasks), 0),
        done_30d: members.reduce((s, m) => s + Number(m.done_30d), 0),
        open_defects: members.reduce((s, m) => s + Number(m.open_defects), 0),
        active_projects: Number(projAgg.projects),
      },
    };
    if (full) {
      panorama.members = members;
      const { rows: [att] } = await db.query(
        `SELECT count(*)::int AS present_days, count(*) FILTER (WHERE source = 'makeup')::int AS makeup_days
         FROM hr.attendance_records ar
         JOIN platform.employments e ON e.tenant_id = ar.tenant_id AND e.person_id = ar.person_id AND e.org_unit_id = $1
         WHERE ar.tenant_id = platform.current_tenant_id()
           AND extract(year from ar.date) = extract(year from current_date)
           AND extract(month from ar.date) = extract(month from current_date)`, [ctx.params.id]);
      panorama.attendance_this_month = att;
    }
    return panorama;
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

// 团队全景：我直属的团队（manager 视角的第一层）
get("/v1/teams/my", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const team = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT p.id AS person_id, p.display_name, ou.name AS org_name,
              (SELECT count(*)::int FROM project.tasks t WHERE t.tenant_id = e.tenant_id AND t.assignee_person_id = p.id AND t.status IN ('todo','in_progress') AND t.deleted_at IS NULL) AS open_tasks,
              (SELECT count(*)::int FROM project.tasks t WHERE t.tenant_id = e.tenant_id AND t.assignee_person_id = p.id AND t.status = 'done' AND t.updated_at > now() - interval '30 days' AND t.deleted_at IS NULL) AS done_30d,
              (SELECT count(*)::int FROM sw.defects d WHERE d.tenant_id = e.tenant_id AND d.assignee_person_id = p.id AND d.status NOT IN ('closed','rejected')) AS open_defects
       FROM platform.employments e
       JOIN platform.people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
       LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
       WHERE e.tenant_id = platform.current_tenant_id() AND e.manager_person_id = $1
         AND e.status = 'active' AND e.deleted_at IS NULL
       ORDER BY p.display_name`, [identity.personId]);
    return {
      manager_person_id: identity.personId,
      members: rows,
      totals: {
        headcount: rows.length,
        open_tasks: rows.reduce((s, m) => s + Number(m.open_tasks), 0),
        done_30d: rows.reduce((s, m) => s + Number(m.done_30d), 0),
        open_defects: rows.reduce((s, m) => s + Number(m.open_defects), 0),
      },
    };
  });
  json(res, 200, team);
});

// 公司全景：与高层看板同源（管理层角色）
get("/v1/org/company/panorama", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const dashboard = await withTenant(identity, async (db) => {
    const allowed = await requireExecutiveRole(db, identity);
    if (!allowed) throw new Error("permission_denied");
    return buildExecutiveDashboard(db);
  });
  json(res, 200, dashboard);
});

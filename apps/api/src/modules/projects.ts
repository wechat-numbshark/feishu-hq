import { get, post, patch, del } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { json, readBody } from "../router.ts";
import { readSession } from "../session.ts";
import { notifyTaskAssigned } from "../notifications.ts";
import { resolveRowScope } from "../data-domain.ts";
import { emitEvent } from "../outbox.ts";
import { assertProjectAccess } from "../record-access.ts";
import { createNotification } from "../notification-center.ts";

// ── 项目列表
get("/v1/projects", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    // P2c 行级数据域：普通员工仅见本人拥有或参与的无归属项目；特权岗位/admin 不过滤
    const { sqlParam } = await resolveRowScope(db, identity);
    const { rows } = await db.query(
      `SELECT p.id, p.code, p.name, p.customer_name, p.status, p.progress,
              p.start_date, p.end_date, p.budget_cents, p.created_at, p.updated_at,
              pe.display_name AS owner_name
       FROM project.projects p
       LEFT JOIN platform.people pe ON pe.tenant_id = p.tenant_id AND pe.id = p.owner_person_id
       WHERE p.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR p.status = $1)
         AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%')
         AND ($5::uuid IS NULL OR p.owner_person_id IS NULL OR p.owner_person_id = $5
              OR EXISTS (SELECT 1 FROM project.project_members pm
                         WHERE pm.tenant_id = p.tenant_id AND pm.project_id = p.id
                           AND pm.person_id = $5 AND pm.left_at IS NULL))
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.search ?? null, limit, offset, sqlParam]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

// ── 单个项目
get("/v1/projects/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    await assertProjectAccess(db, identity, ctx.params.id);
    const { rows } = await db.query(
      `SELECT p.*, pe.display_name AS owner_name, pe.avatar_url AS owner_avatar
       FROM project.projects p
       LEFT JOIN platform.people pe ON pe.tenant_id = p.tenant_id AND pe.id = p.owner_person_id
       WHERE p.tenant_id = platform.current_tenant_id() AND p.id = $1`,
      [ctx.params.id]
    );
    return rows[0] ?? null;
  });

  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });

  const [members, tasks, milestones] = await withTenant(identity, async (db) => {
    const [m, t, ms] = await Promise.all([
      db.query(
        `SELECT pm.*, pe.display_name, pe.avatar_url
         FROM project.project_members pm
         JOIN platform.people pe ON pe.tenant_id = pm.tenant_id AND pe.id = pm.person_id
         WHERE pm.tenant_id = platform.current_tenant_id() AND pm.project_id = $1 AND pm.left_at IS NULL`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT t.id, t.title, t.status, t.priority, t.due_date,
                pe.display_name AS assignee_name
         FROM project.tasks t
         LEFT JOIN platform.people pe ON pe.tenant_id = t.tenant_id AND pe.id = t.assignee_person_id
         WHERE t.tenant_id = platform.current_tenant_id() AND t.project_id = $1 AND t.deleted_at IS NULL
         ORDER BY t.created_at DESC LIMIT 20`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT * FROM project.milestones
         WHERE tenant_id = platform.current_tenant_id() AND project_id = $1
         ORDER BY due_date ASC`,
        [ctx.params.id]
      )
    ]);
    return [m.rows, t.rows, ms.rows];
  });

  json(res, 200, { ...row, members, tasks, milestones });
});

// ── 创建项目
post("/v1/projects", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name || !body.customer_name) return json(res, 400, { error: "name_and_customer_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const id = uuid();
    const code = `PRJ-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO project.projects
         (id, tenant_id, code, name, customer_name, owner_person_id, budget_cents, status, start_date, end_date, source_opportunity_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, 'planning', $7, $8, $9)
       RETURNING *`,
      [id, code, body.name, body.customer_name, body.owner_person_id ?? identity.personId,
       body.budget_cents ?? 0, body.start_date ?? null, body.end_date ?? null,
       body.source_opportunity_id ?? null]
    );
    return rows[0];
  });

  json(res, 201, row);
});

// ── 更新项目
patch("/v1/projects/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","customer_name","status","progress","start_date","end_date","budget_cents","owner_person_id"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertProjectAccess(db, identity, ctx.params.id);
    const { rows } = await db.query(
      `UPDATE project.projects SET ${sets.join(",")}, updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 删除项目（软删除）
del("/v1/projects/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  if (identity.role !== "tenant_admin") return json(res, 403, { error: "administrator_required", traceId: ctx.traceId });
  await withTenant(identity, async (db) => {
    await assertProjectAccess(db, identity, ctx.params.id);
    await db.query(
      `UPDATE project.projects SET status = 'completed', updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]
    );
  });
  json(res, 200, { success: true });
});

// ── 项目任务列表
get("/v1/projects/:id/tasks", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT t.*, pe.display_name AS assignee_name, pe.avatar_url AS assignee_avatar,
              (SELECT count(*) FROM project.task_comments tc WHERE tc.task_id = t.id) AS comment_count
       FROM project.tasks t
       LEFT JOIN platform.people pe ON pe.tenant_id = t.tenant_id AND pe.id = t.assignee_person_id
       WHERE t.tenant_id = platform.current_tenant_id()
         AND t.project_id = $1 AND t.deleted_at IS NULL
         AND ($2::text IS NULL OR t.status = $2)
         AND ($3::text IS NULL OR t.assignee_person_id::text = $3)
       ORDER BY t.priority DESC, t.created_at DESC
       LIMIT $4 OFFSET $5`,
      [ctx.params.id, q.status ?? null, q.assignee ?? null, limit, offset]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

// ── 创建任务
post("/v1/projects/:id/tasks", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });

  const [row, project] = await withTenant(identity, async (db) => {
    await assertProjectAccess(db, identity, ctx.params.id);
    const id = uuid();
    const [t, p] = await Promise.all([
      db.query(
        `INSERT INTO project.tasks
           (id, tenant_id, project_id, title, description, assignee_person_id, reporter_person_id, priority, status, due_date, story_points, milestone_id)
         VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [id, ctx.params.id, body.title, body.description ?? null,
         body.assignee_person_id ?? null, identity.personId,
         body.priority ?? 'medium', body.status ?? 'todo',
         body.due_date ?? null, body.story_points ?? null, body.milestone_id ?? null]
      ),
      db.query(`SELECT name FROM project.projects WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id])
    ]);
    return [t.rows[0], p.rows[0]];
  });

  // 飞书通知：任务分配给负责人
  if (row && body.assignee_person_id && body.assignee_person_id !== identity.personId) {
    await withTenant(identity, async (db) => {
      await notifyTaskAssigned(db, row, project?.name ?? "项目", body.assignee_person_id as string);
      await createNotification(db, body.assignee_person_id as string, {
        kind: "task",
        title: `新任务：${row.title}`,
        body: `${project?.name ?? "项目"} · 截止 ${row.due_date ?? "未设置"}`,
        link: "/#projects",
        dedupeKey: `task:${row.id}:assigned`,
      });
    });
  }

  json(res, 201, row);
});

// ── 更新任务
patch("/v1/tasks/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["title","description","status","priority","assignee_person_id","due_date","story_points","estimated_hours","actual_hours","milestone_id"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if ("status" in body && body.status === "done") { sets.push(`completed_at = $${vals.length + 1}`); vals.push(new Date().toISOString()); }
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const task = await db.query(
      `SELECT project_id FROM project.tasks WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND deleted_at IS NULL`,
      [ctx.params.id]
    );
    if (!task.rows[0]) return null;
    await assertProjectAccess(db, identity, task.rows[0].project_id);
    const { rows } = await db.query(
      `UPDATE project.tasks SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} AND deleted_at IS NULL RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 任务评论
get("/v1/tasks/:id/comments", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT tc.*, pe.display_name AS author_name, pe.avatar_url AS author_avatar
       FROM project.task_comments tc
       JOIN platform.people pe ON pe.tenant_id = tc.tenant_id AND pe.id = tc.author_person_id
       WHERE tc.tenant_id = platform.current_tenant_id() AND tc.task_id = $1 AND tc.deleted_at IS NULL
       ORDER BY tc.created_at ASC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/tasks/:id/comments", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const commentBody = body.body || body.content;
  if (!commentBody) return json(res, 400, { error: "body_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO project.task_comments (id, tenant_id, task_id, author_person_id, body)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4) RETURNING *`,
      [uuid(), ctx.params.id, identity.personId, commentBody]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ── 工时记录
post("/v1/tasks/:id/time-logs", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.hours_logged) return json(res, 400, { error: "hours_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO project.time_logs (id, tenant_id, task_id, person_id, hours_logged, log_date, description)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6) RETURNING *`,
      [uuid(), ctx.params.id, identity.personId, body.hours_logged,
       body.log_date ?? new Date().toISOString().slice(0, 10), body.description ?? null]
    );
    await db.query(
      `UPDATE project.tasks SET actual_hours = COALESCE(actual_hours, 0) + $1 WHERE tenant_id = platform.current_tenant_id() AND id = $2`,
      [body.hours_logged, ctx.params.id]
    );
    return rows[0];
  });
  json(res, 201, row);
});

get("/v1/tasks/:id/time-logs", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT tl.*, pe.display_name AS person_name, pe.avatar_url AS person_avatar
       FROM project.time_logs tl
       JOIN platform.people pe ON pe.tenant_id = tl.tenant_id AND pe.id = tl.person_id
       WHERE tl.tenant_id = platform.current_tenant_id() AND tl.task_id = $1
       ORDER BY tl.log_date DESC, tl.created_at DESC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

// ── 项目风险管理
get("/v1/projects/:id/risks", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT r.*, pe.display_name AS owner_name
       FROM project.project_risks r
       LEFT JOIN platform.people pe ON pe.tenant_id = r.tenant_id AND pe.id = r.owner_person_id
       WHERE r.tenant_id = platform.current_tenant_id() AND r.project_id = $1
       ORDER BY CASE r.probability WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/projects/:id/risks", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO project.project_risks
         (id, tenant_id, project_id, title, description, probability, impact, status, mitigation_plan, owner_person_id, due_date)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, 'open', $7, $8, $9) RETURNING *`,
      [uuid(), ctx.params.id, body.title, body.description ?? null,
       body.probability ?? 'medium', body.impact ?? 'medium',
       body.mitigation_plan ?? null, body.owner_person_id ?? identity.personId, body.due_date ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/risks/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["title","description","probability","impact","status","mitigation_plan","owner_person_id","due_date"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE project.project_risks SET ${sets.join(",")}, updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`, vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 项目变更请求
get("/v1/projects/:id/change-requests", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT cr.*, pe.display_name AS requester_name, ap.display_name AS approver_name
       FROM project.change_requests cr
       LEFT JOIN platform.people pe ON pe.tenant_id = cr.tenant_id AND pe.id = cr.requester_person_id
       LEFT JOIN platform.people ap ON ap.tenant_id = cr.tenant_id AND ap.id = cr.approver_person_id
       WHERE cr.tenant_id = platform.current_tenant_id() AND cr.project_id = $1
       ORDER BY cr.created_at DESC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/projects/:id/change-requests", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO project.change_requests
         (id, tenant_id, project_id, title, description, change_type, impact_description,
          budget_impact_cents, timeline_impact_days, status, requester_person_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, 'submitted', $9) RETURNING *`,
      [uuid(), ctx.params.id, body.title, body.description ?? null,
       body.change_type ?? 'scope', body.impact_description ?? null,
       body.budget_impact_cents ?? 0, body.timeline_impact_days ?? 0, identity.personId]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/change-requests/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const allowed = ["title","description","change_type","impact_description","budget_impact_cents","timeline_impact_days","status"];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (body.status === 'approved') { sets.push(`approver_person_id = $${vals.length + 1}`, `approved_at = now()`); vals.push(identity.personId); }
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE project.change_requests SET ${sets.join(",")}, updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`, vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 里程碑 CRUD
get("/v1/projects/:id/milestones", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT m.*,
              (SELECT count(*) FROM project.tasks t WHERE t.milestone_id = m.id AND t.deleted_at IS NULL) AS task_count,
              (SELECT count(*) FROM project.tasks t WHERE t.milestone_id = m.id AND t.status = 'done' AND t.deleted_at IS NULL) AS done_count
       FROM project.milestones m
       WHERE m.tenant_id = platform.current_tenant_id() AND m.project_id = $1
       ORDER BY m.due_date ASC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/projects/:id/milestones", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name || !body.due_date) return json(res, 400, { error: "name_and_due_date_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO project.milestones (id, tenant_id, project_id, name, description, due_date, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, 'pending') RETURNING *`,
      [uuid(), ctx.params.id, body.name, body.description ?? null, body.due_date]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/milestones/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","description","due_date","status"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE project.milestones SET ${sets.join(",")}, updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`, vals
    );
    const milestone = rows[0] ?? null;
    // 里程碑达成 → 发事件（worker 推卡片；交付域自身的 outbox 生产者，docs/15 P1-5）
    if (milestone && body.status === "completed") {
      await emitEvent(db, identity.tenantId, {
        eventType: "project.milestone.completed.v1", aggregateType: "project.milestones", aggregateId: milestone.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { project_id: milestone.project_id, name: milestone.name, due_date: milestone.due_date },
      });
    }
    return milestone;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 项目人力成本：Σ actual_hours × 时薪（时薪 = 基本月薪 ÷ 174h；无薪资记 0 并标注）
get("/v1/projects/:id/labor-cost", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows: [project] } = await db.query(
      `SELECT id, code, name FROM project.projects WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]);
    if (!project) return null;
    const { rows } = await db.query(
      `SELECT t.assignee_person_id, pe.display_name AS assignee_name,
              coalesce(sum(t.actual_hours), 0) AS hours,
              (SELECT coalesce(sum(sc.amount_cents), 0) FROM hr.salary_components sc
               WHERE sc.tenant_id = t.tenant_id AND sc.person_id = t.assignee_person_id
                 AND sc.component_type = 'base'
                 AND (sc.effective_to IS NULL OR sc.effective_to >= current_date)) AS base_monthly_cents
       FROM project.tasks t
       LEFT JOIN platform.people pe ON pe.tenant_id = t.tenant_id AND pe.id = t.assignee_person_id
       WHERE t.tenant_id = platform.current_tenant_id() AND t.project_id = $1 AND t.deleted_at IS NULL
         AND t.assignee_person_id IS NOT NULL
       GROUP BY t.assignee_person_id, pe.display_name`,
      [ctx.params.id]);
    let totalCents = 0;
    const items = rows.map(r => {
      const hours = Number(r.hours);
      const hourlyCents = Math.round(Number(r.base_monthly_cents) / 174);
      const costCents = Math.round(hours * hourlyCents);
      totalCents += costCents;
      return {
        assignee_person_id: r.assignee_person_id, assignee_name: r.assignee_name,
        hours, hourly_cents: hourlyCents, cost_cents: costCents, rate_known: Number(r.base_monthly_cents) > 0,
      };
    });
    return { project, items, total_labor_cost_cents: totalCents, unpriced_persons: items.filter(i => !i.rate_known).length };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});
// ── 项目成员管理
post("/v1/projects/:id/members", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.person_id) return json(res, 400, { error: "person_id_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO project.project_members (id, tenant_id, project_id, person_id, role, joined_at)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, now())
       ON CONFLICT (tenant_id, project_id, person_id) DO UPDATE SET left_at = NULL, role = EXCLUDED.role
       RETURNING *`,
      [uuid(), ctx.params.id, body.person_id, body.role ?? 'member']
    );
    return rows[0];
  });
  json(res, 200, row);
});

del("/v1/projects/:id/members/:personId", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  await withTenant(identity, async (db) => {
    await db.query(
      `UPDATE project.project_members SET left_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND project_id = $1 AND person_id = $2 AND left_at IS NULL`,
      [ctx.params.id, ctx.params.personId]
    );
  });
  json(res, 200, { success: true });
});

// ── 项目工时汇总
get("/v1/projects/:id/time-summary", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT pe.id, pe.display_name, pe.avatar_url,
              sum(tl.hours_logged) AS total_hours,
              count(DISTINCT tl.task_id) AS task_count,
              max(tl.log_date) AS last_log_date
       FROM project.time_logs tl
       JOIN platform.people pe ON pe.tenant_id = tl.tenant_id AND pe.id = tl.person_id
       JOIN project.tasks t ON t.tenant_id = tl.tenant_id AND t.id = tl.task_id
       WHERE tl.tenant_id = platform.current_tenant_id() AND t.project_id = $1
       GROUP BY pe.id, pe.display_name, pe.avatar_url
       ORDER BY total_hours DESC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

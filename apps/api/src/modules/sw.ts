import { get, post, patch, json } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { readSession } from "../session.ts";
import { emitEvent } from "../outbox.ts";
import type { IncomingMessage } from "node:http";

// ═══════════════════════════════════════════════════════════════
// 软件研发域（docs/15 P0）：需求池 / 缺陷跟踪 / 迭代 Sprint（看板+燃尽）/ 版本发布。
// 表结构见迁移 0024；迭代-任务用 sw.iteration_items 联结（不跨 schema 改 project.tasks）。
// ═══════════════════════════════════════════════════════════════

function sess(req: IncomingMessage) { return readSession(req.headers.cookie); }

const REQ_STATUSES = ["new", "triaged", "queued", "doing", "done", "rejected"];
const DEFECT_STATUSES = ["new", "confirmed", "in_progress", "fixed", "verified", "closed", "rejected"];

// ── 需求池 ──────────────────────────────────────────────────────

get("/v1/sw/requirements", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT r.*, p.name AS project_name, pe.display_name AS owner_name
       FROM sw.requirements r
       LEFT JOIN project.projects p ON p.tenant_id = r.tenant_id AND p.id = r.project_id
       LEFT JOIN platform.people pe ON pe.tenant_id = r.tenant_id AND pe.id = r.owner_person_id
       WHERE r.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR r.status = $1)
         AND ($2::uuid IS NULL OR r.project_id = $2)
       ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.project_id ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/sw/requirements", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const code = `REQ-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO sw.requirements
         (id, tenant_id, project_id, milestone_id, code, title, description, source, priority, status, story_points, owner_person_id, requester_person_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, 'new', $9, $10, $11) RETURNING *`,
      [uuid(), body.project_id ?? null, body.milestone_id ?? null, code, body.title,
       body.description ?? null, body.source ?? "internal", body.priority ?? "medium",
       body.story_points ?? null, body.owner_person_id ?? null, identity.personId]
    );
    const req_ = rows[0];
    await emitEvent(db, identity.tenantId, {
      eventType: "sw.requirement.created.v1", aggregateType: "sw.requirements", aggregateId: req_.id,
      actorId: identity.personId, traceId: ctx.traceId,
      payload: { code: req_.code, title: req_.title, priority: req_.priority, project_id: req_.project_id },
    });
    return req_;
  });
  json(res, 201, row);
});

patch("/v1/sw/requirements/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (body.title != null) add("title", body.title);
    if (body.description != null) add("description", body.description);
    if (body.priority != null) add("priority", body.priority);
    if (body.status != null && REQ_STATUSES.includes(String(body.status))) add("status", body.status);
    if (body.story_points !== undefined) add("story_points", body.story_points);
    if (body.owner_person_id !== undefined) add("owner_person_id", body.owner_person_id);
    if (body.project_id !== undefined) add("project_id", body.project_id);
    if (!sets.length) throw new Error("no_fields_to_update");
    add("updated_at", new Date());
    vals.push(ctx.params.id);
    const { rows } = await db.query(
      `UPDATE sw.requirements SET ${sets.join(", ")}
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`, vals);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

get("/v1/sw/requirements/stats", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT status, count(*)::int AS count, coalesce(sum(story_points),0)::int AS points
       FROM sw.requirements WHERE tenant_id = platform.current_tenant_id() GROUP BY status`
    );
    return rows;
  });
  json(res, 200, { by_status: rows });
});

// ── 缺陷跟踪 ────────────────────────────────────────────────────

get("/v1/sw/defects", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT d.*, p.name AS project_name, pe.display_name AS assignee_name
       FROM sw.defects d
       LEFT JOIN project.projects p ON p.tenant_id = d.tenant_id AND p.id = d.project_id
       LEFT JOIN platform.people pe ON pe.tenant_id = d.tenant_id AND pe.id = d.assignee_person_id
       WHERE d.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR d.status = $1)
         AND ($2::text IS NULL OR d.severity = $2)
         AND ($3::uuid IS NULL OR d.project_id = $3)
       ORDER BY d.created_at DESC LIMIT $4 OFFSET $5`,
      [q.status ?? null, q.severity ?? null, q.project_id ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/sw/defects", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const code = `BUG-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await db.query(
      `INSERT INTO sw.defects
         (id, tenant_id, project_id, requirement_id, found_in_version_id, code, title, description,
          severity, priority, status, repro_steps, environment, assignee_person_id, reporter_person_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, 'new', $10, $11, $12, $13) RETURNING *`,
      [uuid(), body.project_id ?? null, body.requirement_id ?? null, body.found_in_version_id ?? null,
       code, body.title, body.description ?? null, body.severity ?? "major", body.priority ?? "medium",
       body.repro_steps ?? null, body.environment ?? null, body.assignee_person_id ?? null, identity.personId]
    );
    const defect = rows[0];
    await emitEvent(db, identity.tenantId, {
      eventType: "sw.defect.created.v1", aggregateType: "sw.defects", aggregateId: defect.id,
      actorId: identity.personId, traceId: ctx.traceId,
      payload: { code: defect.code, title: defect.title, severity: defect.severity, project_id: defect.project_id },
    });
    return defect;
  });
  json(res, 201, row);
});

patch("/v1/sw/defects/:id", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    if (body.status != null && !DEFECT_STATUSES.includes(String(body.status))) throw new Error("invalid_defect_status");
    const fields: Record<string, unknown> = {};
    for (const col of ["title", "description", "severity", "priority", "status", "repro_steps", "environment",
      "assignee_person_id", "fixed_in_version_id", "requirement_id"]) {
      if (body[col] !== undefined) fields[col] = body[col];
    }
    const keys = Object.keys(fields);
    if (!keys.length) throw new Error("no_fields_to_update");
    if (body.status === "verified" || body.status === "closed") fields.resolved_at = new Date();
    fields.updated_at = new Date();
    const fieldNames = Object.keys(fields);
    const sets = [...fieldNames.map((k, i) => `${k} = $${i + 1}`), "version = version + 1"].join(", ");
    const { rows } = await db.query(
      `UPDATE sw.defects SET ${sets}
       WHERE tenant_id = platform.current_tenant_id() AND id = $${fieldNames.length + 1} RETURNING *`,
      [...Object.values(fields), ctx.params.id]
    );
    const defect = rows[0] ?? null;
    if (defect && (body.status === "closed" || body.status === "verified")) {
      await emitEvent(db, identity.tenantId, {
        eventType: "sw.defect.closed.v1", aggregateType: "sw.defects", aggregateId: defect.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { code: defect.code, status: defect.status },
      });
    }
    return defect;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

get("/v1/sw/defects/stats", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const [bySeverity, byStatus] = await Promise.all([
      db.query(
        `SELECT severity, count(*)::int AS count FROM sw.defects
         WHERE tenant_id = platform.current_tenant_id() AND status NOT IN ('closed','rejected')
         GROUP BY severity`),
      db.query(
        `SELECT status, count(*)::int AS count FROM sw.defects
         WHERE tenant_id = platform.current_tenant_id() GROUP BY status`),
    ]);
    return { by_severity: bySeverity.rows, by_status: byStatus.rows };
  });
  json(res, 200, rows);
});

// ── 迭代 Sprint ─────────────────────────────────────────────────

get("/v1/sw/iterations", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, p.name AS project_name,
              (SELECT coalesce(sum(coalesce(ii.story_points, t.story_points)),0)::int
               FROM sw.iteration_items ii JOIN project.tasks t ON t.tenant_id = ii.tenant_id AND t.id = ii.task_id
               WHERE ii.tenant_id = i.tenant_id AND ii.iteration_id = i.id) AS total_points,
              (SELECT coalesce(sum(coalesce(ii.story_points, t.story_points)),0)::int
               FROM sw.iteration_items ii JOIN project.tasks t ON t.tenant_id = ii.tenant_id AND t.id = ii.task_id
               WHERE ii.tenant_id = i.tenant_id AND ii.iteration_id = i.id AND t.status = 'done') AS done_points
       FROM sw.iterations i
       LEFT JOIN project.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
       WHERE i.tenant_id = platform.current_tenant_id()
         AND ($1::uuid IS NULL OR i.project_id = $1)
         AND ($2::text IS NULL OR i.status = $2)
       ORDER BY i.start_date DESC LIMIT 50`,
      [q.project_id ?? null, q.status ?? null]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/sw/iterations", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.project_id || !body.name || !body.start_date || !body.end_date) {
    return json(res, 400, { error: "project_id_name_start_end_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO sw.iterations (id, tenant_id, project_id, name, goal, capacity_points, start_date, end_date)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7) RETURNING *`,
      [uuid(), body.project_id, body.name, body.goal ?? null, body.capacity_points ?? 0, body.start_date, body.end_date]
    );
    return rows[0];
  });
  json(res, 201, row);
});

post("/v1/sw/iterations/:id/start", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE sw.iterations SET status = 'active', updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'planned' RETURNING *`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "iteration_not_planned_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

post("/v1/sw/iterations/:id/complete", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE sw.iterations SET status = 'completed', completed_at = now(), updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'active' RETURNING *`, [ctx.params.id]);
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "iteration_not_active_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// 任务挂入迭代（联结表，不跨 schema 改 project.tasks）
post("/v1/sw/iterations/:id/items", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.task_id) return json(res, 400, { error: "task_id_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows: iterRows } = await db.query(
      `SELECT id FROM sw.iterations WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id]);
    if (!iterRows[0]) return null;
    const { rows: taskRows } = await db.query(
      `SELECT id, story_points FROM project.tasks WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND deleted_at IS NULL`,
      [body.task_id]);
    if (!taskRows[0]) throw new Error("task_not_found");
    const { rows } = await db.query(
      `INSERT INTO sw.iteration_items (id, tenant_id, iteration_id, task_id, story_points)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4)
       ON CONFLICT (tenant_id, iteration_id, task_id) DO UPDATE SET story_points = EXCLUDED.story_points
       RETURNING *`,
      [uuid(), ctx.params.id, body.task_id, body.story_points ?? taskRows[0].story_points ?? null]
    );
    return rows[0];
  });
  if (!row) return json(res, 404, { error: "iteration_not_found", traceId: ctx.traceId });
  json(res, 201, row);
});

// 迭代看板：按任务状态分组
get("/v1/sw/iterations/:id/board", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows: iterRows } = await db.query(
      `SELECT * FROM sw.iterations WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id]);
    const iteration = iterRows[0] ?? null;
    if (!iteration) return null;
    const { rows } = await db.query(
      `SELECT t.id, t.title, t.status, t.priority, t.story_points, t.assignee_person_id,
              pe.display_name AS assignee_name, ii.story_points AS iteration_story_points
       FROM sw.iteration_items ii
       JOIN project.tasks t ON t.tenant_id = ii.tenant_id AND t.id = ii.task_id AND t.deleted_at IS NULL
       LEFT JOIN platform.people pe ON pe.tenant_id = t.tenant_id AND pe.id = t.assignee_person_id
       WHERE ii.tenant_id = platform.current_tenant_id() AND ii.iteration_id = $1
       ORDER BY t.created_at`, [ctx.params.id]);
    const board: Record<string, unknown[]> = { todo: [], in_progress: [], done: [] };
    for (const r of rows) (board[r.status] ?? board.todo).push(r);
    return { iteration, board, total: rows.length };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

// 燃尽：理想线 vs 剩余点数（按任务完成时间回放）
get("/v1/sw/iterations/:id/burndown", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const result = await withTenant(identity, async (db) => {
    const { rows: iterRows } = await db.query(
      `SELECT * FROM sw.iterations WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [ctx.params.id]);
    const iteration = iterRows[0] ?? null;
    if (!iteration) return null;
    const { rows: items } = await db.query(
      `SELECT coalesce(ii.story_points, t.story_points, 0) AS points, t.status,
              t.updated_at::date::text AS completed_on
       FROM sw.iteration_items ii
       JOIN project.tasks t ON t.tenant_id = ii.tenant_id AND t.id = ii.task_id AND t.deleted_at IS NULL
       WHERE ii.tenant_id = platform.current_tenant_id() AND ii.iteration_id = $1`,
      [ctx.params.id]);
    const totalPoints = items.reduce((s, i) => s + Number(i.points), 0);
    const donePoints = items.filter(i => i.status === "done").reduce((s, i) => s + Number(i.points), 0);
    // 理想线 vs 实际剩余线：已完成点按任务最后更新日（done 的近似完成日）逐日扣减；
    // 未来日期 remaining 为 null（尚未发生，不伪造）。
    const days: Array<{ date: string; ideal: number; remaining: number | null }> = [];
    const start = new Date(iteration.start_date);
    const end = new Date(iteration.end_date);
    const today = new Date(new Date().toISOString().slice(0, 10));
    const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
    for (let d = 0; d < totalDays; d++) {
      const dateObj = new Date(start.getTime() + d * 86400000);
      const date = dateObj.toISOString().slice(0, 10);
      const ideal = Math.round((totalPoints * (1 - d / (totalDays - 1 || 1))) * 10) / 10;
      let remaining: number | null = null;
      if (dateObj <= today) {
        const burned = items
          .filter(i => i.status === "done" && i.completed_on && String(i.completed_on) <= date)
          .reduce((s, i) => s + Number(i.points), 0);
        remaining = totalPoints - burned;
      }
      days.push({ date, ideal, remaining });
    }
    return {
      iteration_id: iteration.id, name: iteration.name, status: iteration.status,
      total_points: totalPoints, done_points: donePoints, remaining_points: totalPoints - donePoints,
      days,
    };
  });
  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

// ── 版本发布 ────────────────────────────────────────────────────

get("/v1/sw/versions", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT v.*, p.name AS project_name, i.name AS iteration_name
       FROM sw.versions v
       LEFT JOIN project.projects p ON p.tenant_id = v.tenant_id AND p.id = v.project_id
       LEFT JOIN sw.iterations i ON i.tenant_id = v.tenant_id AND i.id = v.iteration_id
       WHERE v.tenant_id = platform.current_tenant_id()
         AND ($1::uuid IS NULL OR v.project_id = $1)
       ORDER BY v.created_at DESC LIMIT 50`,
      [q.project_id ?? null]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/sw/versions", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.project_id || !body.version_number) {
    return json(res, 400, { error: "project_id_and_version_number_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO sw.versions (id, tenant_id, project_id, iteration_id, version_number, release_notes, planned_release_date)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6) RETURNING *`,
      [uuid(), body.project_id, body.iteration_id ?? null, body.version_number,
       body.release_notes ?? null, body.planned_release_date ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

post("/v1/sw/versions/:id/release", async (req, res, ctx) => {
  const identity = sess(req);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE sw.versions SET status = 'released', released_at = now(), released_by_person_id = $2,
              updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status IN ('planned','releasing') RETURNING *`,
      [ctx.params.id, identity.personId]
    );
    const v = rows[0] ?? null;
    if (v) {
      // 发布时把本版本修复的开放缺陷自动置为 verified（fixed_in_version 指向本版本）
      await db.query(
        `UPDATE sw.defects SET status = 'verified', resolved_at = now(), updated_at = now()
         WHERE tenant_id = platform.current_tenant_id() AND fixed_in_version_id = $1
           AND status IN ('fixed','in_progress','confirmed','new')`, [v.id]);
      await emitEvent(db, identity.tenantId, {
        eventType: "sw.version.released.v1", aggregateType: "sw.versions", aggregateId: v.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { version_number: v.version_number, project_id: v.project_id },
      });
    }
    return v;
  });
  if (!row) return json(res, 409, { error: "version_not_releasable_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

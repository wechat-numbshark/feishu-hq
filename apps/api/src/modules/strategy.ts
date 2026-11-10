import { get, post, patch, del } from "../router.ts";
import { computeLiveMetric } from "./deep.ts";
import { withTenant, page, uuid } from "../db.ts";
import { json } from "../router.ts";
import { readSession } from "../session.ts";

// ── OKR 周期
get("/v1/strategy/periods", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT p.*,
              (SELECT count(*) FROM strategy.objectives o WHERE o.period_id = p.id) AS objective_count
       FROM strategy.periods p
       WHERE p.tenant_id = platform.current_tenant_id()
       ORDER BY p.start_date DESC`
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/strategy/periods", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const label = body.label || body.name;
  if (!label || !body.start_date || !body.end_date) return json(res, 400, { error: "label_start_end_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO strategy.periods (id, tenant_id, label, period_type, start_date, end_date, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6) RETURNING *`,
      [uuid(), label, body.period_type ?? 'quarter', body.start_date, body.end_date, body.status ?? 'active']
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ── 目标
get("/v1/strategy/periods/:id/objectives", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT o.*, pe.display_name AS owner_name, ou.name AS owner_org_name,
              json_agg(json_build_object(
                'id', kr.id, 'title', kr.title, 'kr_type', kr.kr_type,
                'target_value', kr.target_value, 'current_value', kr.current_value,
                'progress', kr.progress, 'confidence', kr.confidence, 'unit', kr.unit
              ) ORDER BY kr.created_at) FILTER (WHERE kr.id IS NOT NULL) AS key_results
       FROM strategy.objectives o
       LEFT JOIN platform.people pe ON pe.tenant_id = o.tenant_id AND pe.id = o.owner_person_id
       LEFT JOIN platform.org_units ou ON ou.tenant_id = o.tenant_id AND ou.id = o.owner_org_unit_id
       LEFT JOIN strategy.key_results kr ON kr.tenant_id = o.tenant_id AND kr.objective_id = o.id AND kr.status != 'cancelled'
       WHERE o.tenant_id = platform.current_tenant_id() AND o.period_id = $1
       GROUP BY o.id, pe.display_name, ou.name
       ORDER BY o.type, o.created_at`,
      [ctx.params.id]
    );
    return rows;
  });

  json(res, 200, { items: rows });
});

post("/v1/strategy/objectives", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.period_id || !body.title) return json(res, 400, { error: "period_id_and_title_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO strategy.objectives
         (id, tenant_id, period_id, parent_objective_id, owner_person_id, owner_org_unit_id, title, description, type, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), body.period_id, body.parent_objective_id ?? null,
       body.owner_person_id ?? identity.personId, body.owner_org_unit_id ?? null,
       body.title, body.description ?? null, body.type ?? 'company', 'active']
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/strategy/objectives/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["title","description","status","progress","confidence","owner_person_id","owner_org_unit_id"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE strategy.objectives SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 关键结果
post("/v1/strategy/objectives/:id/key-results", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO strategy.key_results
         (id, tenant_id, objective_id, title, description, kr_type, target_value, baseline_value, unit, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), ctx.params.id, body.title, body.description ?? null,
       body.kr_type ?? 'numeric', body.target_value ?? null,
       body.baseline_value ?? 0, body.unit ?? null, 'active']
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/strategy/key-results/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["title","current_value","status","confidence","metric_source"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if ("current_value" in body && body.target_value !== undefined) {
    const pct = Math.min(100, Math.round((Number(body.current_value) / Number(body.target_value)) * 100));
    sets.push(`progress = $${vals.length + 1}`);
    vals.push(pct);
  }
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE strategy.key_results SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 关键结果详情（含打卡历史和执行项）
get("/v1/strategy/key-results/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const [kr, checkins, initiatives] = await Promise.all([
      db.query(
        `SELECT kr.*, pe.display_name AS owner_name, o.title AS objective_title
         FROM strategy.key_results kr
         LEFT JOIN platform.people pe ON pe.tenant_id = kr.tenant_id AND pe.id = kr.owner_person_id
         LEFT JOIN strategy.objectives o ON o.tenant_id = kr.tenant_id AND o.id = kr.objective_id
         WHERE kr.tenant_id = platform.current_tenant_id() AND kr.id = $1`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT c.*, pe.display_name AS author_name FROM strategy.checkins c
         JOIN platform.people pe ON pe.tenant_id = c.tenant_id AND pe.id = c.author_person_id
         WHERE c.tenant_id = platform.current_tenant_id() AND c.key_result_id = $1
         ORDER BY c.checked_at DESC LIMIT 10`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT i.*, pe.display_name AS owner_name FROM strategy.initiatives i
         LEFT JOIN platform.people pe ON pe.tenant_id = i.tenant_id AND pe.id = i.owner_person_id
         WHERE i.tenant_id = platform.current_tenant_id() AND i.key_result_id = $1
         ORDER BY i.priority, i.created_at`,
        [ctx.params.id]
      )
    ]);
    if (!kr.rows[0]) return null;
    // docs/18：绑定 metric_source 的 KR 返回业务表实时值（手工打卡保留为历史记录）
    let live: { value: number; unit: string } | null = null;
    if (kr.rows[0].metric_source && kr.rows[0].metric_source !== "none") {
      live = await computeLiveMetric(db, kr.rows[0].metric_source as string, kr.rows[0].id);
    }
    const { rows: links } = await db.query(
      `SELECT l.id, l.link_type, l.link_id, l.weight,
              CASE l.link_type WHEN 'project' THEN (SELECT pr.name || '（进度 ' || pr.progress || '%）' FROM project.projects pr WHERE pr.tenant_id = l.tenant_id AND pr.id = l.link_id)
                               WHEN 'requirement' THEN (SELECT r.code || ' ' || r.title FROM sw.requirements r WHERE r.tenant_id = l.tenant_id AND r.id = l.link_id)
                               ELSE (SELECT m.name FROM project.milestones m WHERE m.tenant_id = l.tenant_id AND m.id = l.link_id) END AS label
       FROM strategy.kr_links l WHERE l.tenant_id = platform.current_tenant_id() AND l.kr_id = $1 ORDER BY l.created_at`,
      [ctx.params.id]);
    return { ...kr.rows[0], live_value: live?.value ?? null, live_unit: live?.unit ?? null,
             links, checkins: checkins.rows, initiatives: initiatives.rows };
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 执行项 (Initiatives)
get("/v1/strategy/key-results/:id/initiatives", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, pe.display_name AS owner_name FROM strategy.initiatives i
       LEFT JOIN platform.people pe ON pe.tenant_id = i.tenant_id AND pe.id = i.owner_person_id
       WHERE i.tenant_id = platform.current_tenant_id() AND i.key_result_id = $1
       ORDER BY i.priority, i.created_at`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/strategy/key-results/:id/initiatives", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO strategy.initiatives (id, tenant_id, key_result_id, title, description, owner_person_id, due_date, priority, status, progress)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, 0) RETURNING *`,
      [uuid(), ctx.params.id, body.title, body.description ?? null,
       body.owner_person_id ?? identity.personId, body.due_date ?? null,
       // 默认值须落在 strategy.initiatives.status 的 CHECK 枚举内（active），'planned' 会违反约束
       body.priority ?? 'medium', body.status ?? 'active']
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/strategy/initiatives/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["title","description","status","progress","priority","due_date","owner_person_id"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE strategy.initiatives SET ${sets.join(",")}, updated_at = now() WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 进度打卡
post("/v1/strategy/key-results/:id/checkins", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const checkinValue = body.value_at_checkin ?? body.current_value;
  if (checkinValue === undefined) return json(res, 400, { error: "value_at_checkin_required", traceId: ctx.traceId });
  const checkinNote = body.note || body.summary || null;

  const checkin = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO strategy.checkins (id, tenant_id, key_result_id, author_person_id, value_at_checkin, confidence, summary, blockers)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7) RETURNING *`,
      [uuid(), ctx.params.id, identity.personId, checkinValue,
       body.confidence ?? 70, checkinNote, body.blockers ?? null]
    );

    await db.query(
      `UPDATE strategy.key_results SET current_value = $1, confidence = $2
       WHERE tenant_id = platform.current_tenant_id() AND id = $3`,
      [checkinValue, body.confidence ?? 70, ctx.params.id]
    );

    return rows[0];
  });
  json(res, 201, checkin);
});

// ── KR 联动（docs/19 P2）：项目/里程碑/需求挂到 KR；metric_source='project' 时进度自动派生
post("/v1/strategy/key-results/:id/links", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const linkType = String(body.link_type ?? "");
  if (!["project", "milestone", "requirement"].includes(linkType) || !body.link_id) {
    return json(res, 400, { error: "link_type_and_link_id_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const table = linkType === "project" ? "project.projects" : linkType === "milestone" ? "project.milestones" : "sw.requirements";
    const { rows: exists } = await db.query(
      `SELECT 1 FROM ${table} WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [body.link_id]);
    if (!exists[0]) throw new Error("link_target_not_found");
    const { rows } = await db.query(
      `INSERT INTO strategy.kr_links (id, tenant_id, kr_id, link_type, link_id, weight)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5)
       ON CONFLICT (tenant_id, kr_id, link_type, link_id) DO UPDATE SET weight = EXCLUDED.weight
       RETURNING *`,
      [uuid(), ctx.params.id, linkType, body.link_id, Math.min(Math.max(Number(body.weight ?? 1), 1), 100)]);
    return rows[0];
  });
  json(res, 201, row);
});

del("/v1/strategy/key-results/:id/links/:linkId", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rowCount } = await db.query(
      `DELETE FROM strategy.kr_links WHERE tenant_id = platform.current_tenant_id() AND kr_id = $1 AND id = $2`,
      [ctx.params.id, ctx.params.linkId]);
    return rowCount;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { deleted: true });
});

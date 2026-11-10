import { get, post, patch, del } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { json } from "../router.ts";
import { readSession } from "../session.ts";
import { notifyCandidateStatusChanged, createApprovalRequest } from "../notifications.ts";
import { createApprovalInstance } from "./approvals.ts";
import { assertCapability, hasCapability, resolveRoles, effectiveRoles } from "../authz.ts";
import { resolveEmployeeFieldPolicy, applyEmployeeFieldPolicy, SALARY_FIELD, MOBILE_FIELD } from "../data-domain.ts";
import { emitEvent } from "../outbox.ts";
import { enqueueJob } from "../../../../packages/domain/src/job-queue.ts";

// ─── 招聘需求 ────────────────────────────────────────────

get("/v1/hr/requisitions", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT r.*,
              p.name AS project_name,
              (SELECT count(*) FROM hr.candidates c WHERE c.requisition_id = r.id AND c.deleted_at IS NULL) AS candidate_count
       FROM hr.job_requisitions r
       LEFT JOIN project.projects p ON p.tenant_id = r.tenant_id AND p.id = r.project_id
       WHERE r.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR r.status = $1)
         AND ($2::text IS NULL OR r.title ILIKE '%' || $2 || '%')
       ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

get("/v1/hr/requisitions/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const [req_row, candidates] = await withTenant(identity, async (db) => {
    const [r, c] = await Promise.all([
      db.query(
        `SELECT r.*, p.name AS project_name FROM hr.job_requisitions r
         LEFT JOIN project.projects p ON p.tenant_id = r.tenant_id AND p.id = r.project_id
         WHERE r.tenant_id = platform.current_tenant_id() AND r.id = $1`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT c.id, c.name, c.current_title, c.current_company, c.status, c.source, c.created_at,
                pe.display_name AS responsible_name
         FROM hr.candidates c
         LEFT JOIN platform.people pe ON pe.tenant_id = c.tenant_id AND pe.id = c.responsible_person_id
         WHERE c.tenant_id = platform.current_tenant_id() AND c.requisition_id = $1 AND c.deleted_at IS NULL
         ORDER BY c.created_at DESC`,
        [ctx.params.id]
      )
    ]);
    return [r.rows[0] ?? null, c.rows];
  });

  if (!req_row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { ...req_row, candidates });
});

post("/v1/hr/requisitions", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO hr.job_requisitions (id, tenant_id, project_id, title, headcount, reason, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6) RETURNING *`,
      [uuid(), body.project_id ?? null, body.title, body.headcount ?? 1,
       body.reason ?? '', body.status ?? 'open']
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/hr/requisitions/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["title","headcount","reason","status","project_id"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE hr.job_requisitions SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── 候选人 ─────────────────────────────────────────────

get("/v1/hr/candidates", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.current_title, c.current_company, c.email, c.years_of_experience,
              c.status, c.source, c.skills, c.created_at, c.updated_at,
              r.title AS requisition_title, pe.display_name AS responsible_name
       FROM hr.candidates c
       LEFT JOIN hr.job_requisitions r ON r.tenant_id = c.tenant_id AND r.id = c.requisition_id
       LEFT JOIN platform.people pe ON pe.tenant_id = c.tenant_id AND pe.id = c.responsible_person_id
       WHERE c.tenant_id = platform.current_tenant_id() AND c.deleted_at IS NULL
         AND ($1::text IS NULL OR c.status = $1)
         AND ($2::uuid IS NULL OR c.requisition_id = $2::uuid)
         AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' OR c.current_company ILIKE '%' || $3 || '%')
       ORDER BY c.created_at DESC LIMIT $4 OFFSET $5`,
      [q.status ?? null, q.requisition_id ?? null, q.search ?? null, limit, offset]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

get("/v1/hr/candidates/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const [candidate, interviews] = await withTenant(identity, async (db) => {
    const [c, i] = await Promise.all([
      db.query(
        `SELECT c.*, r.title AS requisition_title, pe.display_name AS responsible_name
         FROM hr.candidates c
         LEFT JOIN hr.job_requisitions r ON r.tenant_id = c.tenant_id AND r.id = c.requisition_id
         LEFT JOIN platform.people pe ON pe.tenant_id = c.tenant_id AND pe.id = c.responsible_person_id
         WHERE c.tenant_id = platform.current_tenant_id() AND c.id = $1 AND c.deleted_at IS NULL`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT iv.*,
                array_agg(json_build_object('name', pe.display_name, 'is_lead', ii.is_lead)) AS interviewers,
                (SELECT json_build_object('recommendation', e.recommendation, 'overall_score', e.overall_score, 'notes', e.notes)
                 FROM hr.interview_evaluations e WHERE e.interview_id = iv.id LIMIT 1) AS evaluation
         FROM hr.interviews iv
         LEFT JOIN hr.interview_interviewers ii ON ii.tenant_id = iv.tenant_id AND ii.interview_id = iv.id
         LEFT JOIN platform.people pe ON pe.tenant_id = iv.tenant_id AND pe.id = ii.interviewer_person_id
         WHERE iv.tenant_id = platform.current_tenant_id() AND iv.candidate_id = $1
         GROUP BY iv.id ORDER BY iv.scheduled_at`,
        [ctx.params.id]
      )
    ]);
    return [c.rows[0] ?? null, i.rows];
  });

  if (!candidate) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { ...candidate, interviews });
});

post("/v1/hr/candidates", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO hr.candidates
         (id, tenant_id, requisition_id, name, email, current_company, current_title,
          years_of_experience, source, status, responsible_person_id, skills, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [uuid(), body.requisition_id ?? null, body.name, body.email ?? null,
       body.current_company ?? null, body.current_title ?? null,
       body.years_of_experience ?? null, body.source ?? 'active_sourcing',
       'new', body.responsible_person_id ?? identity.personId,
       body.skills ?? [], body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/hr/candidates/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","email","current_company","current_title","years_of_experience","status","source","responsible_person_id","skills","notes","rejection_reason","requisition_id","resume_url"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE hr.candidates SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} AND deleted_at IS NULL RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── 面试 ────────────────────────────────────────────────

post("/v1/hr/candidates/:id/interviews", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.scheduled_at) return json(res, 400, { error: "scheduled_at_required", traceId: ctx.traceId });

  const interview = await withTenant(identity, async (db) => {
    const ivId = uuid();
    const { rows } = await db.query(
      `INSERT INTO hr.interviews
         (id, tenant_id, candidate_id, requisition_id, round, interview_type, status, scheduled_at, duration_minutes, location, meeting_link, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [ivId, ctx.params.id, body.requisition_id ?? null, body.round ?? 1,
       body.interview_type ?? 'onsite', 'scheduled', body.scheduled_at,
       body.duration_minutes ?? 60, body.location ?? null,
       body.meeting_link ?? null, body.notes ?? null]
    );
    const interview = rows[0];

    if (Array.isArray(body.interviewer_person_ids)) {
      for (const pid of body.interviewer_person_ids as string[]) {
        await db.query(
          `INSERT INTO hr.interview_interviewers (id, tenant_id, interview_id, interviewer_person_id, is_lead)
           VALUES ($1, platform.current_tenant_id(), $2, $3, $4) ON CONFLICT DO NOTHING`,
          [uuid(), ivId, pid, false]
        );
      }
    }
    return interview;
  });

  json(res, 201, interview);
});

patch("/v1/hr/interviews/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["status","scheduled_at","duration_minutes","location","meeting_link","notes"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE hr.interviews SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── 面试评价 ────────────────────────────────────────────

post("/v1/hr/interviews/:id/evaluations", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.recommendation) return json(res, 400, { error: "recommendation_required", traceId: ctx.traceId });

  // Normalize recommendation to DB enum values
  const recMap: Record<string, string> = {
    strong_yes: 'strongly_recommend', strongly_recommend: 'strongly_recommend',
    yes: 'recommend', recommend: 'recommend',
    maybe: 'pending', pending: 'pending',
    no: 'not_recommend', not_recommend: 'not_recommend',
  };
  const recommendation = recMap[body.recommendation as string] ?? 'recommend';
  // Scale score to 1-10 if given in 1-100 range
  let score = body.overall_score != null ? Number(body.overall_score) : null;
  if (score !== null && score > 10) score = Math.min(10, Math.round(score / 10));

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO hr.interview_evaluations
         (id, tenant_id, interview_id, interviewer_person_id, recommendation, overall_score, dimension_scores, strengths, weaknesses, notes, submitted_at)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (tenant_id, interview_id, interviewer_person_id) DO UPDATE
         SET recommendation = EXCLUDED.recommendation,
             overall_score = EXCLUDED.overall_score,
             dimension_scores = EXCLUDED.dimension_scores,
             strengths = EXCLUDED.strengths,
             weaknesses = EXCLUDED.weaknesses,
             notes = EXCLUDED.notes,
             submitted_at = now()
       RETURNING *`,
      [uuid(), ctx.params.id, identity.personId, recommendation,
       score, body.dimension_scores ?? {},
       body.strengths ?? null, body.weaknesses ?? null, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ─── Offer ───────────────────────────────────────────────

get("/v1/hr/candidates/:id/offers", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT o.*, pe.display_name AS approved_by_name FROM hr.offers o
       LEFT JOIN platform.people pe ON pe.tenant_id = o.tenant_id AND pe.id = o.approved_by_person_id
       WHERE o.tenant_id = platform.current_tenant_id() AND o.candidate_id = $1
       ORDER BY o.created_at DESC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/hr/candidates/:id/offers", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.position_title || !body.base_salary_annual) return json(res, 400, { error: "position_title_and_salary_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO hr.offers
         (id, tenant_id, candidate_id, requisition_id, position_title, department, base_salary_annual, bonus_annual, stock_options, probation_months, expected_start_date, offer_expires_at, status, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [uuid(), ctx.params.id, body.requisition_id ?? null,
       body.position_title, body.department ?? null,
       body.base_salary_annual, body.bonus_annual ?? null,
       body.stock_options ?? null, body.probation_months ?? 3,
       body.expected_start_date ?? null, body.offer_expires_at ?? null,
       'draft', body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/hr/offers/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["status","position_title","department","base_salary_annual","bonus_annual","expected_start_date","offer_expires_at","notes","decline_reason"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if ("status" in body && body.status === "sent") { sets.push(`sent_at = $${vals.length + 1}`); vals.push(new Date().toISOString()); }
  if ("status" in body && (body.status === "accepted" || body.status === "declined")) { sets.push(`responded_at = $${vals.length + 1}`); vals.push(new Date().toISOString()); }
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE hr.offers SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    const offer = rows[0] ?? null;
    // Offer 接受 → 发事件 + 入队入职编排作业（幂等 key 保证重复接受不重复编排）
    if (offer && body.status === "accepted") {
      await emitEvent(db, identity.tenantId, {
        eventType: "hr.offer.accepted.v1", aggregateType: "hr.offers", aggregateId: offer.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { offer_id: offer.id, candidate_id: offer.candidate_id, position_title: offer.position_title },
      });
      await enqueueJob(db, {
        tenantId: identity.tenantId, kind: "onboard_from_offer",
        payload: { offer_id: offer.id },
        idempotencyKey: `hr.onboarding:${offer.id}`,
        createdBy: identity.personId,
      });
    }
    return offer;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── HR 统计 ─────────────────────────────────────────────

get("/v1/hr/stats", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const stats = await withTenant(identity, async (db) => {
    const [reqs, candidates, funnel] = await Promise.all([
      db.query(
        `SELECT count(*) FILTER (WHERE status = 'open') AS open_reqs,
                count(*) FILTER (WHERE status = 'approved') AS approved_reqs,
                sum(headcount) FILTER (WHERE status IN ('open','approved')) AS open_headcount
         FROM hr.job_requisitions WHERE tenant_id = platform.current_tenant_id()`
      ),
      db.query(
        `SELECT status, count(*) AS count FROM hr.candidates
         WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL
         GROUP BY status`
      ),
      db.query(
        `SELECT count(*) FILTER (WHERE status IN ('hr_interview','technical_interview','final_interview')) AS active_interviews,
                count(*) FILTER (WHERE status = 'offer_sent') AS offers_out,
                count(*) FILTER (WHERE status = 'hired' AND updated_at > now() - interval '30 days') AS hired_30d
         FROM hr.candidates WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL`
      )
    ]);
    return {
      requisitions: reqs.rows[0],
      candidatesByStatus: candidates.rows,
      funnel: funnel.rows[0]
    };
  });

  json(res, 200, stats);
});

// ─── 员工名册 ────────────────────────────────────────────

get("/v1/hr/employees", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT e.id, e.employee_number, e.employment_type, e.status, e.start_date,
              e.work_location, e.probation_end_date,
              p.id AS person_id, p.display_name, p.primary_email, p.avatar_url, p.mobile,
              ou.name AS org_unit_name, ou.id AS org_unit_id,
              pos.name AS position_name, pos.id AS position_id,
              mgr.display_name AS manager_name, mgr.id AS manager_person_id
       FROM platform.employments e
       JOIN platform.people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
       LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
       LEFT JOIN platform.positions pos ON pos.tenant_id = e.tenant_id AND pos.id = e.position_id
       LEFT JOIN platform.people mgr ON mgr.tenant_id = e.tenant_id AND mgr.id = e.manager_person_id
       WHERE e.tenant_id = platform.current_tenant_id() AND e.deleted_at IS NULL
         AND ($1::text IS NULL OR e.status = $1)
         AND ($2::uuid IS NULL OR e.org_unit_id = $2::uuid)
         AND ($3::text IS NULL OR p.display_name ILIKE '%' || $3 || '%'
              OR e.employee_number ILIKE '%' || $3 || '%')
       ORDER BY p.display_name
       LIMIT $4 OFFSET $5`,
      [q.status ?? null, q.org_unit_id ?? null, q.search ?? null, limit, offset]
    );
    // 数据域/ABAC：非特权查看者（普通同事/主管/财务）他人手机号脱敏，本人行保留完整
    const otherPolicy = await resolveEmployeeFieldPolicy(db, identity, "__other__");
    const restrict = otherPolicy.mask.includes(MOBILE_FIELD) || otherPolicy.hidden.includes(SALARY_FIELD);
    return restrict
      ? rows.map((r: { person_id: string }) => (r.person_id === identity.personId ? r : applyEmployeeFieldPolicy(r, otherPolicy)))
      : rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

// ─── 员工详情 ─────────────────────────────────────────────

get("/v1/hr/employees/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const data = await withTenant(identity, async (db) => {
    const [emp, contracts, leaves] = await Promise.all([
      db.query(
        `SELECT e.*,
                p.display_name, p.primary_email, p.avatar_url, p.mobile,
                p.gender, p.city, p.hire_date AS feishu_hire_date,
                ou.name AS org_unit_name, ou.id AS org_unit_id,
                pos.name AS position_name,
                mgr.display_name AS manager_name, mgr.id AS manager_person_id
         FROM platform.employments e
         JOIN platform.people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
         LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
         LEFT JOIN platform.positions pos ON pos.tenant_id = e.tenant_id AND pos.id = e.position_id
         LEFT JOIN platform.people mgr ON mgr.tenant_id = e.tenant_id AND mgr.id = e.manager_person_id
         WHERE e.tenant_id = platform.current_tenant_id() AND e.id = $1 AND e.deleted_at IS NULL`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT c.id, c.contract_type, c.start_date, c.end_date, c.base_salary_cents,
                c.status, c.created_at
         FROM hr.employee_contracts c
         JOIN platform.employments e ON e.tenant_id = c.tenant_id AND e.person_id = c.person_id
         WHERE c.tenant_id = platform.current_tenant_id() AND e.id = $1
         ORDER BY c.created_at DESC`,
        [ctx.params.id]
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT lr.id, lr.leave_type, lr.start_date, lr.end_date, lr.days,
                lr.status, lr.reason, lr.created_at
         FROM hr.leave_requests lr
         JOIN platform.employments e ON e.tenant_id = lr.tenant_id AND e.person_id = lr.person_id
         WHERE lr.tenant_id = platform.current_tenant_id() AND e.id = $1
         ORDER BY lr.created_at DESC LIMIT 20`,
        [ctx.params.id]
      ).catch(() => ({ rows: [] }))
    ]);
    if (!emp.rows[0]) return null;
    const profile = { ...emp.rows[0], contracts: contracts.rows, leave_history: leaves.rows };
    // 数据域/ABAC：薪资记录级可见性 + 他人手机号脱敏（决策来自 packages/authz）
    const policy = await resolveEmployeeFieldPolicy(db, identity, emp.rows[0].person_id);
    return applyEmployeeFieldPolicy(profile, policy);
  });

  if (!data) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, data);
});

// ─── 更新员工信息 ──────────────────────────────────────────

patch("/v1/hr/employees/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["employment_type","status","work_location","org_unit_id","position_id",
                   "manager_person_id","probation_end_date","termination_date","termination_reason",
                   "emergency_contact_name","emergency_contact_phone","notes"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.manage");
    const { rows } = await db.query(
      `UPDATE platform.employments SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} AND deleted_at IS NULL RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── 新建员工（直接入职） ──────────────────────────────────

post("/v1/hr/employees", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.display_name) return json(res, 400, { error: "display_name_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.manage");
    // Resolve defaults: legal entity and root org unit
    const { rows: leRows } = await db.query(
      `SELECT id FROM platform.legal_entities WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL ORDER BY created_at LIMIT 1`
    );
    const { rows: ouRows } = await db.query(
      `SELECT id FROM platform.org_units WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL ORDER BY created_at LIMIT 1`
    );
    const legalEntityId = (body.legal_entity_id as string) ?? leRows[0]?.id;
    const orgUnitId = (body.org_unit_id as string) ?? ouRows[0]?.id;
    if (!legalEntityId) throw new Error("no_legal_entity");
    if (!orgUnitId) throw new Error("no_org_unit");

    const personId = uuid();
    const empId = uuid();
    await db.query(
      `INSERT INTO platform.people (id, tenant_id, display_name, primary_email, mobile, status, classification)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, 'active', 'internal')`,
      [personId, body.display_name, body.primary_email ?? null, body.mobile ?? null]
    );
    const { rows } = await db.query(
      `INSERT INTO platform.employments
         (id, tenant_id, person_id, legal_entity_id, org_unit_id, employee_number,
          employment_type, status, start_date, position_id, manager_person_id,
          work_location, probation_end_date)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [empId, personId, legalEntityId, orgUnitId,
       body.employee_number ?? null,
       body.employment_type ?? 'employee', body.status ?? 'active',
       body.start_date ?? new Date().toISOString().slice(0,10),
       body.position_id ?? null, body.manager_person_id ?? null,
       body.work_location ?? null, body.probation_end_date ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ─── 员工合同 ──────────────────────────────────────────────

get("/v1/hr/employees/:id/contracts", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT c.*, e.person_id FROM hr.employee_contracts c
       JOIN platform.employments e ON e.tenant_id = c.tenant_id AND e.person_id = c.person_id
       WHERE c.tenant_id = platform.current_tenant_id() AND e.id = $1
       ORDER BY c.created_at DESC`,
      [ctx.params.id]
    );
    if (!rows.length) return rows;
    // 与员工详情同一字段策略：非本人且无 hr.salary.read 时移除薪资
    const policy = await resolveEmployeeFieldPolicy(db, identity, rows[0].person_id);
    if (policy.hidden.includes(SALARY_FIELD)) {
      for (const r of rows) delete (r as Record<string, unknown>).base_salary_cents;
    }
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/hr/employees/:id/contracts", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.salary.write");
    const emp = await db.query(
      `SELECT person_id FROM platform.employments WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]
    );
    if (!emp.rows[0]) return null;
    const { rows } = await db.query(
      `INSERT INTO hr.employee_contracts
         (id, tenant_id, person_id, contract_type, start_date, end_date, base_salary_cents, status, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [uuid(), emp.rows[0].person_id,
       body.contract_type ?? 'full_time', body.start_date, body.end_date ?? null,
       body.base_salary_cents ?? null, 'active', body.notes ?? null]
    );
    return rows[0];
  });
  if (!row) return json(res, 404, { error: "employee_not_found", traceId: ctx.traceId });
  json(res, 201, row);
});

// ─── 请假政策 ──────────────────────────────────────────────

get("/v1/hr/leave-policies", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM hr.leave_policies
       WHERE tenant_id = platform.current_tenant_id()
       ORDER BY leave_type`
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

patch("/v1/hr/leave-policies/:type", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["annual_entitlement_days","carry_over_max_days","min_notice_days",
                   "allow_half_day","requires_approval","max_consecutive_days","description","is_active"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  sets.push(`updated_at = now()`);
  vals.push(ctx.params.type);
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.manage");
    const { rows } = await db.query(
      `INSERT INTO hr.leave_policies (tenant_id, leave_type, updated_at)
       VALUES (platform.current_tenant_id(), $${vals.length}, now())
       ON CONFLICT (tenant_id, leave_type) DO UPDATE SET ${sets.join(",")}
       RETURNING *`,
      vals
    );
    return rows[0];
  });
  json(res, 200, row);
});

// ─── 职位体系 ──────────────────────────────────────────────

get("/v1/hr/job-positions", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT jp.*,
              (SELECT count(*) FROM platform.employments e WHERE e.tenant_id = jp.tenant_id
               AND e.position_id IN (SELECT id FROM platform.positions WHERE name = jp.title LIMIT 1)
               AND e.deleted_at IS NULL AND e.status != 'terminated') AS current_headcount
       FROM hr.job_positions jp
       WHERE jp.tenant_id = platform.current_tenant_id()
         AND ($1::boolean IS NULL OR jp.is_active = $1)
       ORDER BY jp.level NULLS LAST, jp.title`,
      [q.active != null ? q.active === 'true' : null]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/hr/job-positions", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.manage");
    const { rows } = await db.query(
      `INSERT INTO hr.job_positions
         (id, tenant_id, title, code, level, department, description,
          salary_min_cents, salary_max_cents, headcount_budget)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), body.title, body.code ?? null, body.level ?? null, body.department ?? null,
       body.description ?? null, body.salary_min_cents ?? null, body.salary_max_cents ?? null,
       body.headcount_budget ?? 1]
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/hr/job-positions/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["title","code","level","department","description","salary_min_cents","salary_max_cents","headcount_budget","is_active"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  sets.push("updated_at = now()");
  if (sets.length < 2) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.manage");
    const { rows } = await db.query(
      `UPDATE hr.job_positions SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`, vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── 组织架构树 ────────────────────────────────────────────

get("/v1/hr/org-chart", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `WITH RECURSIVE org AS (
         SELECT ou.id, ou.name, ou.parent_id, ou.type, 0 AS depth
         FROM platform.org_units ou
         WHERE ou.tenant_id = platform.current_tenant_id()
           AND ou.deleted_at IS NULL AND ou.parent_id IS NULL
         UNION ALL
         SELECT ou.id, ou.name, ou.parent_id, ou.type, org.depth + 1
         FROM platform.org_units ou
         JOIN org ON org.id = ou.parent_id
         WHERE ou.tenant_id = platform.current_tenant_id() AND ou.deleted_at IS NULL
       )
       SELECT o.*, count(e.id) AS headcount
       FROM org o
       LEFT JOIN platform.employments e ON e.tenant_id = platform.current_tenant_id()
         AND e.org_unit_id = o.id AND e.deleted_at IS NULL AND e.status != 'terminated'
       GROUP BY o.id, o.name, o.parent_id, o.type, o.depth
       ORDER BY o.depth, o.name`
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

// ─── 请假申请（含请假统计） ────────────────────────────────

get("/v1/hr/leave-requests", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT lr.*, p.display_name AS person_name,
              approver.display_name AS approver_name
       FROM hr.leave_requests lr
       JOIN platform.people p ON p.tenant_id = lr.tenant_id AND p.id = lr.person_id
       LEFT JOIN platform.people approver ON approver.tenant_id = lr.tenant_id AND approver.id = lr.approver_person_id
       WHERE lr.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR lr.status = $1)
         AND ($2::text IS NULL OR lr.leave_type = $2)
       ORDER BY lr.created_at DESC LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.leave_type ?? null, limit, offset]
    );
    return rows;
  });
  json(res, 200, { items: rows, limit, offset });
});

post("/v1/hr/leave-requests", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.leave_type || !body.start_date || !body.end_date || !body.days) {
    return json(res, 400, { error: "leave_type_start_end_days_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO hr.leave_requests (id, tenant_id, person_id, leave_type, start_date, end_date, days, reason, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, 'pending') RETURNING *`,
      [uuid(), identity.personId, body.leave_type, body.start_date, body.end_date, body.days, body.reason ?? null]
    );
    const leave = rows[0];
    const { rows: empRows } = await db.query(
      `SELECT manager_person_id FROM platform.employments
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
         AND status != 'terminated' AND deleted_at IS NULL LIMIT 1`,
      [identity.personId]
    );
    try {
      await createApprovalInstance(db, {
        tenantId: identity.tenantId,
        flowCode: "leave_request",
        resourceType: "leave_request",
        resourceId: leave.id,
        requesterPersonId: identity.personId ?? leave.person_id,
        title: `${body.leave_type} 请假 ${body.start_date} ~ ${body.end_date}（${body.days}天）`,
        summary: { leave_type: body.leave_type, days: body.days, start_date: body.start_date, end_date: body.end_date, reason: body.reason ?? null },
        managerPersonId: empRows[0]?.manager_person_id ?? null,
      });
    } catch { /* approval instance creation is best-effort */ }
    return leave;
  });
  json(res, 201, row);
});

patch("/v1/hr/leave-requests/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["status","approver_notes"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if ("status" in body && (body.status === "approved" || body.status === "rejected")) {
    sets.push(`approver_person_id = $${vals.length + 1}`);
    vals.push(identity.personId);
    sets.push(`approved_at = now()`);
  }
  if (!sets.length) return json(res, 400, { error: "no_fields", traceId: ctx.traceId });
  const isDecision = "status" in body && (body.status === "approved" || body.status === "rejected");
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    if (isDecision) {
      // 审批请假需 hr.leave.approve；且不能审批自己的申请（职责分离）
      await assertCapability(db, identity, "hr.leave.approve");
      const { rows: reqRows } = await db.query(
        `SELECT person_id FROM hr.leave_requests
         WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
        [ctx.params.id]
      );
      if (reqRows[0]?.person_id === identity.personId) throw new Error("self_approval_forbidden");
    }
    const { rows } = await db.query(
      `UPDATE hr.leave_requests SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ═══════════════════════════════════════════════════════════════
// 假期余额（docs/15 P0/P1）：人×年×假种 额度/已用/结转；请假批准由审批内核同事务扣减。
// ═══════════════════════════════════════════════════════════════

// ── 试用期到期提醒（docs/17 细节；口径=入职+6 个月，见 docs/17 说明）
get("/v1/hr/probation-due", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.manage");
    const { rows } = await db.query(
      `SELECT e.id AS employment_id, p.display_name, ou.name AS org_name, e.start_date,
              (e.start_date + interval '6 months')::date AS probation_end,
              (e.start_date + interval '6 months')::date - current_date AS days_left
       FROM platform.employments e
       JOIN platform.people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
       LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
       WHERE e.tenant_id = platform.current_tenant_id() AND e.status = 'active' AND e.deleted_at IS NULL
         AND e.start_date + interval '6 months' BETWEEN current_date - 7 AND current_date + 60
       ORDER BY probation_end`);
    return rows;
  });
  json(res, 200, { items: rows });
});

get("/v1/hr/leave-balances", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const rows = await withTenant(identity, async (db) => {
    const target = q.person_id ?? identity.personId;
    if (target !== identity.personId) {
      const roles = await effectiveRoles(db, identity);
      if (!hasCapability(roles, "hr.manage")) throw new Error("permission_denied");
    }
    const year = Number(q.year ?? new Date().getFullYear());
    const { rows } = await db.query(
      `SELECT lb.*, p.display_name AS person_name,
              (lb.entitled_days + lb.accrued_days + lb.carried_over_days - lb.used_days) AS remaining_days
       FROM hr.leave_balances lb
       JOIN platform.people p ON p.tenant_id = lb.tenant_id AND p.id = lb.person_id
       WHERE lb.tenant_id = platform.current_tenant_id()
         AND lb.person_id = $1 AND lb.year = $2::int
       ORDER BY lb.leave_type`,
      [target, year]
    );
    return rows;
  });
  json(res, 200, { items: rows, year: Number(q.year ?? new Date().getFullYear()) });
});

// 发放/调整额度（需 hr.employee.write）：entitled_days 直接设值，或 adjust_days 增减
post("/v1/hr/leave-balances", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.person_id || !body.leave_type || !body.year) {
    return json(res, 400, { error: "person_id_leave_type_year_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.manage");
    const { rows } = await db.query(
      `INSERT INTO hr.leave_balances (id, tenant_id, person_id, leave_type, year, entitled_days)
       VALUES ($1::uuid, platform.current_tenant_id(), $2::uuid, $3::varchar, $4::int, $5::numeric)
       ON CONFLICT (tenant_id, person_id, leave_type, year)
       DO UPDATE SET entitled_days = CASE WHEN $6::numeric IS NOT NULL THEN $6::numeric ELSE hr.leave_balances.entitled_days + $7::numeric END,
                     updated_at = now(), version = hr.leave_balances.version + 1
       RETURNING *`,
      [uuid(), body.person_id, body.leave_type, Number(body.year),
       Number(body.entitled_days ?? 0), body.entitled_days != null ? Number(body.entitled_days) : null,
       Number(body.adjust_days ?? 0)]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ═══════════════════════════════════════════════════════════════
// 绩效考核（docs/15 P0）：HR 建周期考核 → 被评人自评 → 上级评定 → 完成（总分=均值）。
// ═══════════════════════════════════════════════════════════════

get("/v1/hr/performance-reviews", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const rows = await withTenant(identity, async (db) => {
    const roles = await effectiveRoles(db, identity);
    const privileged = hasCapability(roles, "hr.manage");
    const { rows } = await db.query(
      `SELECT pr.*, pe.display_name AS reviewee_name, pr2.display_name AS reviewer_name
       FROM hr.performance_reviews pr
       JOIN platform.people pe ON pe.tenant_id = pr.tenant_id AND pe.id = pr.reviewee_person_id
       LEFT JOIN platform.people pr2 ON pr2.tenant_id = pr.tenant_id AND pr2.id = pr.reviewer_person_id
       WHERE pr.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR pr.cycle = $1)
         AND ( $2::bool OR pr.reviewee_person_id = $3 OR pr.reviewer_person_id = $3 )
       ORDER BY pr.created_at DESC LIMIT 100`,
      [q.cycle ?? null, privileged, identity.personId]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/hr/performance-reviews", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.cycle || !body.reviewee_person_id) {
    return json(res, 400, { error: "cycle_and_reviewee_required", traceId: ctx.traceId });
  }
  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.manage");
    const { rows } = await db.query(
      `INSERT INTO hr.performance_reviews
         (id, tenant_id, cycle, reviewee_person_id, reviewer_person_id, project_id, goals, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6::jsonb, 'self_review')
       ON CONFLICT (tenant_id, cycle, reviewee_person_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [uuid(), body.cycle, body.reviewee_person_id, body.reviewer_person_id ?? null,
       body.project_id ?? null, JSON.stringify(body.goals ?? [])]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// 自评（仅被评人本人）
post("/v1/hr/performance-reviews/:id/self-review", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE hr.performance_reviews
       SET self_rating = $2::int, self_comments = $3, self_submitted_at = now(), status = 'pending_review',
           updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $1
         AND reviewee_person_id = $4 AND status IN ('self_review','pending_review')
       RETURNING *`,
      [ctx.params.id, Number(body.self_rating ?? 0) || null, body.self_comments ?? null, identity.personId]
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 409, { error: "review_not_self_or_missing", traceId: ctx.traceId });
  json(res, 200, row);
});

// 上级评定（仅指定评审人）：完成后总分 = (自评+上级评)/2，并发事件
post("/v1/hr/performance-reviews/:id/manager-review", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const row = await withTenant(identity, async (db) => {
    // docs/18 360°：有同事反馈时 总分=0.5×上级+0.3×同事均值+0.2×自评；否则 (上级+自评)/2
    const { rows } = await db.query(
      `WITH peer AS (
         SELECT round(avg(rating)::numeric, 4) AS avg_rating, count(*)::int AS n
         FROM hr.review_feedbacks
         WHERE tenant_id = platform.current_tenant_id() AND review_id = $1
       )
       UPDATE hr.performance_reviews pr
       SET manager_rating = $2::int, manager_comments = $3, status = 'completed', completed_at = now(),
           overall_rating = CASE
             WHEN peer.n > 0 THEN round(( $2::int * 0.5 + peer.avg_rating * 0.3 + coalesce(pr.self_rating, $2::int) * 0.2 )::numeric, 2)
             ELSE round((($2::int + coalesce(pr.self_rating, $2::int))::numeric / 2), 2)
           END,
           updated_at = now(), version = version + 1
       FROM peer
       WHERE pr.tenant_id = platform.current_tenant_id() AND pr.id = $1
         AND pr.reviewer_person_id = $4 AND pr.status = 'pending_review'
       RETURNING pr.*`,
      [ctx.params.id, Number(body.manager_rating ?? 0) || null, body.manager_comments ?? null, identity.personId]
    );
    const review = rows[0] ?? null;
    if (review) {
      await emitEvent(db, identity.tenantId, {
        eventType: "hr.review.completed.v1", aggregateType: "hr.performance_reviews", aggregateId: review.id,
        actorId: identity.personId, traceId: ctx.traceId,
        payload: { cycle: review.cycle, reviewee_person_id: review.reviewee_person_id, overall_rating: review.overall_rating },
      });
    }
    return review;
  });
  if (!row) return json(res, 409, { error: "review_not_pending_or_not_reviewer", traceId: ctx.traceId });
  json(res, 200, row);
});

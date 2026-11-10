import { get, post, patch } from "../router.ts";
import { withTenant, uuid, type DbClient } from "../db.ts";
import { json } from "../router.ts";
import { readSession } from "../session.ts";
import { assertCapability, hasCapability, resolveRoles } from "../authz.ts";
import type { SessionIdentity } from "../session.ts";
import { createNotification } from "../notification-center.ts";

async function hasAnyRoleCapability(db: DbClient, identity: SessionIdentity, caps: string[]): Promise<boolean> {
  const roles = await resolveRoles(db, identity.personId);
  if (roles.length === 0 && identity.mode === "demo" && identity.role === "tenant_admin") return true;
  return caps.some((c) => hasCapability(roles.length > 0 ? roles : ["employee"], c));
}

// ─── 审批流辅助：创建审批实例 ─────────────────────────────────
export async function createApprovalInstance(
  db: DbClient,
  params: {
    tenantId: string;
    flowCode: string;
    resourceType: string;
    resourceId: string;
    requesterPersonId: string;
    title: string;
    summary: Record<string, unknown>;
    managerPersonId?: string | null;
  }
): Promise<string | null> {
  const { rows: flowRows } = await db.query(
    `SELECT id, steps, timeout_hours, auto_approve_if_no_approver
     FROM platform.approval_flows
     WHERE tenant_id = platform.current_tenant_id() AND code = $1 AND is_active = true`,
    [params.flowCode]
  );
  if (!flowRows.length) return null;

  const flow = flowRows[0];
  const rawSteps: Array<{ order: number; type: string; label: string; person_id?: string; min_amount_cents?: number }> =
    Array.isArray(flow.steps) ? flow.steps : JSON.parse(flow.steps);

  // 条件分支：步骤可声明 min_amount_cents，按审批单摘要金额过滤；过滤后重新编号，保证 1..N。
  const amount = Number((params.summary as Record<string, unknown> | undefined)?.amount_cents ?? 0);
  let steps = rawSteps
    .filter((step) => !step.min_amount_cents || amount >= Number(step.min_amount_cents))
    .sort((a, b) => a.order - b.order)
    .map((step, index) => ({ ...step, order: index + 1 }));
  // 全部被条件过滤掉时退回原流程，避免"无审批人"死单。
  if (steps.length === 0) steps = rawSteps.map((step, index) => ({ ...step, order: index + 1 }));

  // 幂等检查：同一资源同一申请人同一流程的重复请求被拒绝
  const idempotencyKey = `${params.flowCode}:${params.resourceType}:${params.resourceId}:${params.requesterPersonId}`;
  const { rows: idempRows } = await db.query(
    `SELECT id FROM platform.approval_idempotency_keys
     WHERE tenant_id = platform.current_tenant_id() AND idempotency_key = $1`,
    [idempotencyKey]
  );
  if (idempRows.length > 0) {
    return null;
  }

  const instanceId = uuid();
  await db.query(
    `INSERT INTO platform.approval_instances
       (id, tenant_id, flow_id, resource_type, resource_id, requester_person_id, title, summary,
        total_steps, steps_snapshot, due_at)
     VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             now() + make_interval(hours => $10::int))`,
    [instanceId, flow.id, params.resourceType, params.resourceId,
     params.requesterPersonId, params.title, JSON.stringify(params.summary), steps.length,
     JSON.stringify(steps), Number(flow.timeout_hours ?? 48)]
  );

  const firstStep = steps.find(s => s.order === 1);
  if (firstStep) {
    let approverPersonId: string | null = null;
    if (firstStep.type === "manager") {
      // 无主管时不回退申请人，审批人为 null 进入待指派队列
      approverPersonId = params.managerPersonId ?? null;
    } else if (firstStep.type === "person" && firstStep.person_id) {
      approverPersonId = firstStep.person_id;
    } else if (firstStep.type === "role") {
      // role 步骤不自动指定申请人，审批人为 null 进入待指派队列
      approverPersonId = null;
    }

    await db.query(
      `INSERT INTO platform.approval_actions (id, tenant_id, instance_id, step_order, approver_person_id)
       VALUES ($1, platform.current_tenant_id(), $2, 1, $3)`,
      [uuid(), instanceId, approverPersonId]
    );
    await createNotification(db, approverPersonId, {
      kind: "approval",
      title: `待你审批：${params.title}`,
      body: "有一条新的审批请求等待处理。",
      link: "/#approvals",
      dedupeKey: `approval:${instanceId}:step1`,
    });
  }

  // 记录幂等键
  await db.query(
    `INSERT INTO platform.approval_idempotency_keys (id, tenant_id, resource_type, resource_id, requester_person_id, flow_code, idempotency_key)
     VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6)`,
    [uuid(), params.resourceType, params.resourceId, params.requesterPersonId, params.flowCode, idempotencyKey]
  );

  return instanceId;
}

// ─── 审批决定辅助（批准或拒绝）────────────────────────────────
export async function processApprovalDecision(
  db: DbClient,
  instanceId: string,
  decidingPersonId: string,
  decision: "approved" | "rejected",
  comment: string | null
): Promise<{ ok: boolean; newStatus: string }> {
  const { rows: [instance] } = await db.query(
    `SELECT ai.*, COALESCE(ai.steps_snapshot, af.steps) AS steps, af.code AS flow_code
     FROM platform.approval_instances ai
     JOIN platform.approval_flows af ON af.id = ai.flow_id
     WHERE ai.tenant_id = platform.current_tenant_id() AND ai.id = $1 AND ai.status = 'pending'
     FOR UPDATE`,
    [instanceId]
  );
  if (!instance) return { ok: false, newStatus: "" };

  const { rows: [action] } = await db.query(
    `SELECT * FROM platform.approval_actions
     WHERE instance_id = $1 AND step_order = $2 AND status = 'pending'
     FOR UPDATE`,
    [instanceId, instance.current_step]
  );
  if (!action) return { ok: false, newStatus: "" };

  // 只有被指派的审批人可决策；未指派（角色型步骤，approver_person_id 为 null）直接拒绝
  if (!action.approver_person_id) {
    throw new Error("permission_denied");
  }
  if (action.approver_person_id !== decidingPersonId) {
    throw new Error("permission_denied");
  }

  await db.query(
    `UPDATE platform.approval_actions SET status = $1, comment = $2, decided_at = now(),
     approver_person_id = COALESCE(approver_person_id, $3)
     WHERE id = $4`,
    [decision, comment ?? null, decidingPersonId, action.id]
  );

  // 版本快照记录
  await db.query(
    `INSERT INTO platform.approval_flow_versions (id, tenant_id, flow_code, instance_id, snapshot_jsonb)
     VALUES ($1, platform.current_tenant_id(), $2, $3, $4)
     ON CONFLICT (tenant_id, instance_id) DO UPDATE SET snapshot_jsonb = EXCLUDED.snapshot_jsonb, captured_at = now()`,
    [uuid(), instance.flow_code ?? 'approval', instanceId, JSON.stringify({ decision, decided_at: new Date().toISOString(), step: instance.current_step, instance_status: instance.status })]
  );

  if (decision === "rejected") {
    await db.query(
      `UPDATE platform.approval_instances SET status = 'rejected', resolved_at = now() WHERE id = $1`,
      [instanceId]
    );
    await createNotification(db, instance.requester_person_id, {
      kind: "approval",
      title: `审批被拒绝：${instance.title}`,
      body: comment || "审批人拒绝了该申请。",
      link: "/#approvals",
      dedupeKey: `approval:${instanceId}:result`,
    });
    return { ok: true, newStatus: "rejected" };
  }

  const steps: Array<{ order: number; type: string; label: string; person_id?: string }> =
    Array.isArray(instance.steps) ? instance.steps : JSON.parse(instance.steps);
  const nextStep = steps
    .filter((s) => s.order > instance.current_step)
    .sort((a, b) => a.order - b.order)[0];

  if (!nextStep) {
    await db.query(
      `UPDATE platform.approval_instances SET status = 'approved', resolved_at = now() WHERE id = $1`,
      [instanceId]
    );
    await createNotification(db, instance.requester_person_id, {
      kind: "approval",
      title: `审批已通过：${instance.title}`,
      body: "该申请已完成全部审批。",
      link: "/#approvals",
      dedupeKey: `approval:${instanceId}:result`,
    });
    return { ok: true, newStatus: "approved" };
  } else {
    let nextApproverPersonId: string | null = null;
    if (nextStep.type === "manager") {
      const { rows } = await db.query(
        `SELECT e.manager_person_id FROM platform.employments e
         WHERE e.tenant_id = platform.current_tenant_id() AND e.person_id = $1
           AND e.status != 'terminated' AND e.deleted_at IS NULL LIMIT 1`,
        [instance.requester_person_id]
      );
      nextApproverPersonId = rows[0]?.manager_person_id ?? null;
    } else if (nextStep.type === "person" && nextStep.person_id) {
      nextApproverPersonId = nextStep.person_id;
    } else if (nextStep.type === "role") {
      // role 步骤不自动指定上一位审批人，审批人为 null 进入待指派队列
      nextApproverPersonId = null;
    }

    await db.query(
      `UPDATE platform.approval_instances SET current_step = $2 WHERE id = $1`,
      [instanceId, nextStep.order]
    );
    await db.query(
      `INSERT INTO platform.approval_actions (id, tenant_id, instance_id, step_order, approver_person_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4)`,
      [uuid(), instanceId, nextStep.order, nextApproverPersonId]
    );
    await createNotification(db, nextApproverPersonId, {
      kind: "approval",
      title: `待你审批：${instance.title}`,
      body: "上一步已通过，流程进入你这一环节。",
      link: "/#approvals",
      dedupeKey: `approval:${instanceId}:step${nextStep.order}`,
    });
    return { ok: true, newStatus: "pending" };
  }
}

// ─── 同步资源状态（审批结果回写到业务表）────────────────────
export async function syncResourceStatus(
  db: DbClient,
  resourceType: string,
  resourceId: string,
  decision: string
): Promise<void> {
  const hrStatus = decision === "approved" ? "approved" : "rejected";
  const isApproved = decision === "approved";

  if (resourceType === "leave_request") {
    const { rows: [leave] } = await db.query(
      `SELECT person_id, leave_type, days, start_date FROM hr.leave_requests
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [resourceId]);
    await db.query(
      `UPDATE hr.leave_requests SET status = $1, approved_at = CASE WHEN $2 THEN now() ELSE NULL END
       WHERE tenant_id = platform.current_tenant_id() AND id = $3`,
      [hrStatus, isApproved, resourceId]
    );
    // 批准 → 同事务扣减假期余额（人×年×假种；余额可记负并在看板告警，不阻断审批语义）
    if (leave && isApproved) {
      // PG 返回 date 列为 Date 对象；统一走 Date 解析取年，避免 String(date) 截取出 NaN
      const year = new Date(leave.start_date as string | Date).getFullYear();
      await db.query(
        `INSERT INTO hr.leave_balances (id, tenant_id, person_id, leave_type, year, used_days)
         VALUES ($1::uuid, platform.current_tenant_id(), $2::uuid, $3::varchar, $4::int, $5::numeric)
         ON CONFLICT (tenant_id, person_id, leave_type, year)
         DO UPDATE SET used_days = hr.leave_balances.used_days + EXCLUDED.used_days,
                       updated_at = now(), version = hr.leave_balances.version + 1`,
        [uuid(), leave.person_id, leave.leave_type, year, leave.days]
      );
    }
  } else if (resourceType === "expense") {
    await db.query(
      `UPDATE finance.expenses SET status = $1, approved_at = CASE WHEN $2 THEN now() ELSE NULL END
       WHERE tenant_id = platform.current_tenant_id() AND id = $3`,
      [hrStatus, isApproved, resourceId]
    );
  } else if (resourceType === "contract") {
    // 合同评审终态回写（approved/rejected），与费用/请假同一模式
    await db.query(
      `UPDATE sales.contracts SET status = $1, approved_at = CASE WHEN $2 THEN now() ELSE NULL END,
              updated_at = now(), version = version + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $3`,
      [hrStatus, isApproved, resourceId]
    );
  } else if (resourceType === "requisition" && decision === "approved") {
    await db.query(
      `UPDATE hr.job_requisitions SET status = 'approved'
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [resourceId]
    );
  }
}

// ─── 待我审批列表 ─────────────────────────────────────────────

// ── 审批统计（docs/17 细节）：平均时长 / 通过率 / 各模块待办分布
get("/v1/approvals/stats", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const stats = await withTenant(identity, async (db) => {
    const [totals, byModule, avg] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'approved')::int AS approved,
                count(*) FILTER (WHERE status = 'rejected')::int AS rejected
         FROM platform.approval_instances WHERE tenant_id = platform.current_tenant_id()`),
      db.query(
        `SELECT af.module, count(*)::int AS pending FROM platform.approval_instances ai
         JOIN platform.approval_flows af ON af.id = ai.flow_id
         WHERE ai.tenant_id = platform.current_tenant_id() AND ai.status = 'pending'
         GROUP BY af.module ORDER BY pending DESC`),
      db.query(
        `SELECT coalesce(round(avg(EXTRACT(EPOCH FROM (ai.resolved_at - ai.created_at)) / 3600), 1), 0)::numeric AS avg_hours
         FROM platform.approval_instances ai
         WHERE ai.tenant_id = platform.current_tenant_id() AND ai.status IN ('approved','rejected')
           AND ai.resolved_at > now() - interval '90 days'`),
    ]);
    const t = totals.rows[0];
    const decided = Number(t.approved) + Number(t.rejected);
    return {
      ...t,
      approve_rate_pct: decided > 0 ? Math.round(Number(t.approved) / decided * 10000) / 100 : null,
      avg_resolve_hours_90d: Number(avg.rows[0].avg_hours),
      pending_by_module: byModule.rows,
    };
  });
  json(res, 200, stats);
});

get("/v1/approvals/pending", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const items = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT ai.id, ai.resource_type, ai.resource_id, ai.title, ai.summary,
              ai.current_step, ai.total_steps, ai.status, ai.created_at,
              p.display_name AS requester_name, p.avatar_url AS requester_avatar,
              af.name AS flow_name, af.module,
              aa.step_order, aa.approver_person_id
       FROM platform.approval_instances ai
       JOIN platform.approval_flows af ON af.id = ai.flow_id
       JOIN platform.people p ON p.tenant_id = ai.tenant_id AND p.id = ai.requester_person_id
       JOIN platform.approval_actions aa ON aa.instance_id = ai.id AND aa.status = 'pending'
            AND aa.step_order = ai.current_step
       WHERE ai.tenant_id = platform.current_tenant_id()
         AND ai.status = 'pending'
         AND (aa.approver_person_id = $1 OR aa.approver_person_id IS NULL)
       ORDER BY ai.created_at DESC LIMIT 50`,
      [identity.personId]
    );
    return rows;
  });
  json(res, 200, { items });
});

// ─── 我发起的审批列表 ─────────────────────────────────────────

get("/v1/approvals/my-requests", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const items = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT ai.id, ai.resource_type, ai.resource_id, ai.title, ai.summary,
              ai.current_step, ai.total_steps, ai.status, ai.created_at, ai.resolved_at,
              af.name AS flow_name, af.module,
              (SELECT count(*) FROM platform.approval_actions aa
               WHERE aa.instance_id = ai.id AND aa.status = 'approved') AS approved_steps,
              (SELECT p.display_name FROM platform.people p
               JOIN platform.approval_actions aa ON aa.approver_person_id = p.id
               WHERE aa.instance_id = ai.id AND aa.step_order = ai.current_step LIMIT 1) AS current_approver_name
       FROM platform.approval_instances ai
       JOIN platform.approval_flows af ON af.id = ai.flow_id
       WHERE ai.tenant_id = platform.current_tenant_id() AND ai.requester_person_id = $1
       ORDER BY ai.created_at DESC LIMIT 50`,
      [identity.personId]
    );
    return rows;
  });
  json(res, 200, { items });
});

// ─── 所有审批（管理员视角）────────────────────────────────────

get("/v1/approvals", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);

  const items = await withTenant(identity, async (db) => {
    // 可见性：管理员/HR/财务看全量；其余人只看"我发起的 + 我需要审批的"。
    const canViewAll = await hasAnyRoleCapability(db, identity, ["approval.manage", "hr.manage", "finance.manage"]);
    const { rows } = await db.query(
      `SELECT ai.id, ai.resource_type, ai.resource_id, ai.title, ai.summary, ai.status,
              ai.current_step, ai.total_steps, ai.created_at, ai.resolved_at,
              p.display_name AS requester_name,
              af.name AS flow_name, af.module
       FROM platform.approval_instances ai
       JOIN platform.approval_flows af ON af.id = ai.flow_id
       JOIN platform.people p ON p.tenant_id = ai.tenant_id AND p.id = ai.requester_person_id
       WHERE ai.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR ai.status = $1)
         AND ($2::text IS NULL OR af.module = $2)
         AND ($3::boolean OR ai.requester_person_id = $4
              OR EXISTS (SELECT 1 FROM platform.approval_actions aa
                         WHERE aa.tenant_id = ai.tenant_id AND aa.instance_id = ai.id
                           AND aa.approver_person_id = $4))
       ORDER BY ai.created_at DESC LIMIT 100`,
      [q.status ?? null, q.module ?? null, canViewAll, identity.personId]
    );
    return rows;
  });
  json(res, 200, { items });
});

// ─── 审批详情 ─────────────────────────────────────────────────

get("/v1/approvals/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const result = await withTenant(identity, async (db) => {
    const canViewAll = await hasAnyRoleCapability(db, identity, ["approval.manage", "hr.manage", "finance.manage"]);
    const { rows: [instance] } = await db.query(
      `SELECT ai.*, af.name AS flow_name, af.module, af.steps AS flow_steps,
              p.display_name AS requester_name, p.avatar_url AS requester_avatar
       FROM platform.approval_instances ai
       JOIN platform.approval_flows af ON af.id = ai.flow_id
       JOIN platform.people p ON p.tenant_id = ai.tenant_id AND p.id = ai.requester_person_id
       WHERE ai.tenant_id = platform.current_tenant_id() AND ai.id = $1
         AND ($2::boolean OR ai.requester_person_id = $3
              OR EXISTS (SELECT 1 FROM platform.approval_actions aa
                         WHERE aa.tenant_id = ai.tenant_id AND aa.instance_id = ai.id
                           AND aa.approver_person_id = $3))`,
      [ctx.params.id, canViewAll, identity.personId]
    );
    if (!instance) return null;

    const { rows: actions } = await db.query(
      `SELECT aa.*, p.display_name AS approver_name, p.avatar_url AS approver_avatar
       FROM platform.approval_actions aa
       LEFT JOIN platform.people p ON p.tenant_id = aa.tenant_id AND p.id = aa.approver_person_id
       WHERE aa.instance_id = $1 ORDER BY aa.step_order`,
      [ctx.params.id]
    );
    return { ...instance, actions };
  });

  if (!result) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, result);
});

// ─── 审批操作（同意/拒绝）────────────────────────────────────

post("/v1/approvals/:id/decide", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const decision = body.decision as string;
  if (!["approved", "rejected"].includes(decision)) {
    return json(res, 400, { error: "decision must be 'approved' or 'rejected'", traceId: ctx.traceId });
  }

  const result = await withTenant(identity, async (db) => {
    const { ok, newStatus } = await processApprovalDecision(
      db, ctx.params.id, identity.personId, decision as "approved" | "rejected",
      body.comment as string ?? null
    );
    if (!ok) throw new Error("approval_not_found_or_not_authorized");

    if (newStatus !== "pending") {
      const { rows: [inst] } = await db.query(
        `SELECT resource_type, resource_id FROM platform.approval_instances WHERE id = $1`,
        [ctx.params.id]
      );
      if (inst) await syncResourceStatus(db, inst.resource_type, inst.resource_id, newStatus);
    }
    return { ok: true, newStatus };
  });

  json(res, 200, result);
});

// ─── 转交 / 委托 ─────────────────────────────────────────────
post("/v1/approvals/:id/transfer", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as { person_id?: string; reason?: string };
  if (!body.person_id) return json(res, 400, { error: "person_id_required", traceId: ctx.traceId });

  const ok = await withTenant(identity, async (db) => {
    const { rows: [instance] } = await db.query(
      `SELECT * FROM platform.approval_instances
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'pending' FOR UPDATE`,
      [ctx.params.id]
    );
    if (!instance) throw new Error("not_found");
    const { rows: [action] } = await db.query(
      `SELECT * FROM platform.approval_actions
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $1
         AND step_order = $2 AND status = 'pending' FOR UPDATE`,
      [ctx.params.id, instance.current_step]
    );
    if (!action) throw new Error("not_found");

    const canManage = await hasAnyRoleCapability(db, identity, ["approval.manage"]);
    if (action.approver_person_id !== identity.personId && !canManage) throw new Error("permission_denied");

    const target = await db.query(
      `SELECT id FROM platform.people WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND deleted_at IS NULL`,
      [body.person_id]
    );
    if (!target.rows[0]) throw new Error("person_not_found");

    await db.query(
      `UPDATE platform.approval_actions
       SET approver_person_id = $1, delegated_from_person_id = COALESCE(delegated_from_person_id, $2),
           delegated_at = now(), transfer_reason = $3
       WHERE id = $4`,
      [body.person_id, action.approver_person_id, body.reason ?? null, action.id]
    );
    await createNotification(db, body.person_id, {
      kind: "approval",
      title: `转交给你审批：${instance.title}`,
      body: body.reason || "原审批人已将审批转交给你。",
      link: "/#approvals",
      dedupeKey: `approval:${instance.id}:transfer:${action.id}`,
    });
    await db.query(
      `INSERT INTO audit.audit_events
         (id, tenant_id, actor_id, action, resource_id, resource_type, outcome, change_summary, client_context, trace_id)
       VALUES ($1, platform.current_tenant_id(), $2, 'approval.transferred', $3, 'approval_instance', 'success', $4::jsonb, '{}'::jsonb, $5)`,
      [uuid(), `person:${identity.personId}`, ctx.params.id,
       JSON.stringify({ from: action.approver_person_id, to: body.person_id, reason: body.reason ?? null }), ctx.traceId]
    );
    return true;
  });
  json(res, 200, { ok, approver_person_id: body.person_id });
});

// ─── 加签（在当前步骤前/后插入一位审批人）──────────────────────
post("/v1/approvals/:id/add-sign", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as { person_id?: string; position?: "before" | "after"; reason?: string };
  if (!body.person_id) return json(res, 400, { error: "person_id_required", traceId: ctx.traceId });

  const result = await withTenant(identity, async (db) => {
    const { rows: [instance] } = await db.query(
      `SELECT ai.*, COALESCE(ai.steps_snapshot, af.steps) AS steps
       FROM platform.approval_instances ai
       JOIN platform.approval_flows af ON af.id = ai.flow_id
       WHERE ai.tenant_id = platform.current_tenant_id() AND ai.id = $1 AND ai.status = 'pending'
       FOR UPDATE`,
      [ctx.params.id]
    );
    if (!instance) throw new Error("not_found");

    const canManage = await hasAnyRoleCapability(db, identity, ["approval.manage"]);
    const { rows: [action] } = await db.query(
      `SELECT * FROM platform.approval_actions
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $1
         AND step_order = $2 AND status = 'pending'`,
      [ctx.params.id, instance.current_step]
    );
    if (action?.approver_person_id !== identity.personId && !canManage) throw new Error("permission_denied");

    const target = await db.query(
      `SELECT id FROM platform.people WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND deleted_at IS NULL`,
      [body.person_id]
    );
    if (!target.rows[0]) throw new Error("person_not_found");

    const rawSteps = (Array.isArray(instance.steps) ? instance.steps : JSON.parse(instance.steps)) as Array<Record<string, unknown>>;
    const position = body.position === "before" ? "before" : "after";
    const insertOrder = position === "before" ? instance.current_step : instance.current_step + 1;
    const shifted: Array<Record<string, unknown>> = rawSteps.map((s) => ({
      ...s,
      order: Number(s.order) >= insertOrder ? Number(s.order) + 1 : Number(s.order),
    }));
    const nextSteps: Array<Record<string, unknown>> = [
      ...shifted,
      { order: insertOrder, type: "person", person_id: body.person_id, label: "加签", is_added: true },
    ].sort((a, b) => Number(a.order) - Number(b.order));

    await db.query(
      `UPDATE platform.approval_actions SET step_order = step_order + 1
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $1 AND step_order >= $2 AND status = 'pending'`,
      [ctx.params.id, insertOrder]
    );
    await db.query(
      `UPDATE platform.approval_instances
       SET steps_snapshot = $2::jsonb, total_steps = $3::int, current_step = $4::int
       WHERE id = $1`,
      [ctx.params.id, JSON.stringify(nextSteps), nextSteps.length,
       position === "before" ? insertOrder : instance.current_step]
    );
    await db.query(
      `INSERT INTO platform.approval_actions (id, tenant_id, instance_id, step_order, approver_person_id, is_added)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, true)`,
      [uuid(), ctx.params.id, insertOrder, body.person_id]
    );
    await createNotification(db, body.person_id, {
      kind: "approval",
      title: `加签审批：${instance.title}`,
      body: body.reason || "你被加签为本单审批人。",
      link: "/#approvals",
      dedupeKey: `approval:${instance.id}:addsign:${insertOrder}:${body.person_id}`,
    });
    await db.query(
      `INSERT INTO audit.audit_events
         (id, tenant_id, actor_id, action, resource_id, resource_type, outcome, change_summary, client_context, trace_id)
       VALUES ($1, platform.current_tenant_id(), $2, 'approval.add_sign', $3, 'approval_instance', 'success', $4::jsonb, '{}'::jsonb, $5)`,
      [uuid(), `person:${identity.personId}`, ctx.params.id,
       JSON.stringify({ person_id: body.person_id, position }), ctx.traceId]
    );
    return { ok: true, step_order: insertOrder };
  });
  json(res, 200, result);
});

// ─── 撤回申请 ─────────────────────────────────────────────────

post("/v1/approvals/:id/withdraw", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const withdrawn = await withTenant(identity, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE platform.approval_instances SET status = 'withdrawn', resolved_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND status = 'pending'
         AND requester_person_id = $2`,
      [ctx.params.id, identity.personId]
    );
    if (!rowCount) return false;
    await db.query(
      `UPDATE platform.approval_actions SET status = 'delegated'
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $1 AND status = 'pending'`,
      [ctx.params.id]
    );
    return true;
  });
  if (!withdrawn) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { ok: true });
});

// ─── 审批流配置列表 ──────────────────────────────────────────

get("/v1/approval-flows", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const items = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT id, code, name, module, description, steps, auto_approve_if_no_approver, is_active, timeout_hours, updated_at
       FROM platform.approval_flows WHERE tenant_id = platform.current_tenant_id()
       ORDER BY module, name`
    );
    return rows;
  });
  json(res, 200, { items });
});

// ─── 更新审批流配置 ───────────────────────────────────────────

patch("/v1/approval-flows/:code", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;

  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "approval.manage");
    const { rows } = await db.query(
      `UPDATE platform.approval_flows
       SET steps = COALESCE($1::jsonb, steps),
           auto_approve_if_no_approver = COALESCE($2, auto_approve_if_no_approver),
           is_active = COALESCE($3, is_active),
           timeout_hours = COALESCE($5::int, timeout_hours),
           updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND code = $4
       RETURNING *`,
      [body.steps ? JSON.stringify(body.steps) : null,
       body.auto_approve_if_no_approver ?? null,
       body.is_active ?? null,
       ctx.params.code,
       body.timeout_hours != null ? Number(body.timeout_hours) : null]
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── 考勤记录 ────────────────────────────────────────────────

get("/v1/hr/attendance", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);

  const items = await withTenant(identity, async (db) => {
    // 普通员工只能看自己的考勤；HR/主管/管理员可看全员（或按 person_id 过滤）
    const canReadAll = await hasAnyRoleCapability(db, identity, ["hr.manage", "hr.employee.read"]);
    const personFilter = canReadAll ? (q.person_id ?? null) : identity.personId;
    const { rows } = await db.query(
      `SELECT ar.*, p.display_name AS person_name
       FROM hr.attendance_records ar
       JOIN platform.people p ON p.tenant_id = ar.tenant_id AND p.id = ar.person_id
       WHERE ar.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR ar.person_id::text = $1)
         AND ($2::date IS NULL OR ar.date >= $2::date)
         AND ($3::date IS NULL OR ar.date <= $3::date)
       ORDER BY ar.date DESC, p.display_name LIMIT 100`,
      [personFilter, q.from_date ?? null, q.to_date ?? null]
    );
    return rows;
  });
  json(res, 200, { items });
});

post("/v1/hr/attendance/checkin", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;

  const row = await withTenant(identity, async (db) => {
    const today = new Date().toISOString().slice(0, 10);
    const personId = (body.person_id as string) ?? identity.personId;
    if (personId !== identity.personId && !(await hasAnyRoleCapability(db, identity, ["hr.manage"]))) {
      throw new Error("permission_denied");
    }
    const { rows } = await db.query(
      `INSERT INTO hr.attendance_records (id, tenant_id, person_id, date, check_in, source, note)
       VALUES ($1, platform.current_tenant_id(), $2, $3, now(), 'manual', $4)
       ON CONFLICT (tenant_id, person_id, date)
       DO UPDATE SET check_in = EXCLUDED.check_in, note = COALESCE(EXCLUDED.note, hr.attendance_records.note)
       RETURNING *`,
      [uuid(), personId, today, body.note ?? null]
    );
    return rows[0];
  });
  json(res, 200, row);
});

post("/v1/hr/attendance/checkout", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;

  const row = await withTenant(identity, async (db) => {
    const today = new Date().toISOString().slice(0, 10);
    const personId = (body.person_id as string) ?? identity.personId;
    if (personId !== identity.personId && !(await hasAnyRoleCapability(db, identity, ["hr.manage"]))) {
      throw new Error("permission_denied");
    }
    const { rows } = await db.query(
      `UPDATE hr.attendance_records SET check_out = now()
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1 AND date = $2
       RETURNING *`,
      [personId, today]
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "no_checkin_record", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── 薪资组成 ────────────────────────────────────────────────

get("/v1/hr/employees/:id/salary", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const items = await withTenant(identity, async (db) => {
    // 薪资敏感：本人可读，读取他人需 hr.salary.read
    const { rows: empRows } = await db.query(
      `SELECT person_id FROM platform.employments
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]
    );
    const isSelf = empRows[0]?.person_id === identity.personId;
    if (!isSelf && !(await hasAnyRoleCapability(db, identity, ["hr.salary.read"]))) {
      throw new Error("permission_denied");
    }
    const { rows } = await db.query(
      `SELECT sc.* FROM hr.salary_components sc
       JOIN platform.employments e ON e.id = sc.employment_id
       WHERE sc.tenant_id = platform.current_tenant_id() AND e.id = $1
         AND (sc.effective_to IS NULL OR sc.effective_to >= current_date)
       ORDER BY sc.component_type, sc.effective_from DESC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items });
});

post("/v1/hr/employees/:id/salary", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;

  const row = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "hr.salary.write");
    const { rows: [emp] } = await db.query(
      `SELECT id, person_id FROM platform.employments
       WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]
    );
    if (!emp) throw new Error("employment_not_found");
    const { rows } = await db.query(
      `INSERT INTO hr.salary_components
         (id, tenant_id, person_id, employment_id, component_type, name, amount_cents, is_fixed, effective_from, effective_to, notes)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [uuid(), emp.person_id, emp.id,
       body.component_type ?? "base", body.name ?? "基本工资",
       Math.round(Number(body.amount_cents ?? 0)),
       body.is_fixed !== false,
       body.effective_from ?? new Date().toISOString().slice(0, 10),
       body.effective_to ?? null, body.notes ?? null]
    );
    return rows[0];
  });
  json(res, 201, row);
});

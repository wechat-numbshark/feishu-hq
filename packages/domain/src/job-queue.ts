// ──────────────────────────────────────────────────────────────
// 持久作业队列（durable job queue）——可恢复 / 可重试 / 可人工接管
// ──────────────────────────────────────────────────────────────
// 单一事实源：worker 与验收 harness 都从这里取同一套 claim/retry/dead 逻辑，避免漂移。
// 依赖仅一个鸭子类型的 db client（Node 的 pg.Client/PoolClient 或 withTenant 的 client）：
//   client.query(sql, params?) => Promise<{ rows: any[]; rowCount: number }>
// 租约(lease_until) + FOR UPDATE SKIP LOCKED：进程崩溃后，running 作业租约到期即被重新领取。

export interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead";

export interface JobRow {
  id: string;
  tenant_id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
}

export interface EnqueueInput {
  tenantId: string;
  kind: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  createdBy?: string | null;
  availableAt?: string | null;
}

// 幂等入队：给定 idempotencyKey 时，同租户重复入队返回既有作业（不新建）。
export async function enqueueJob(client: QueryClient, input: EnqueueInput): Promise<JobRow> {
  const params = [
    input.tenantId,
    input.kind,
    JSON.stringify(input.payload ?? {}),
    input.maxAttempts ?? 3,
    input.idempotencyKey ?? null,
    input.createdBy ?? null,
    input.availableAt ?? null,
  ];
  const { rows } = await client.query(
    `INSERT INTO platform.jobs
       (id, tenant_id, kind, payload, status, max_attempts, idempotency_key, created_by, available_at)
     VALUES (gen_random_uuid(), $1, $2, $3::jsonb, 'queued', $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    params
  );
  if (rows[0]) return rows[0] as JobRow;
  // 命中幂等冲突：回读既有作业
  const existing = await client.query(
    `SELECT * FROM platform.jobs WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [input.tenantId, input.idempotencyKey]
  );
  return existing.rows[0] as JobRow;
}

// 领取一批到期作业：queued 且 available_at<=now，或 running 但租约已过期（崩溃恢复）。
export async function claimJobs(
  client: QueryClient,
  opts: { limit?: number; leaseSeconds?: number } = {}
): Promise<JobRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const lease = opts.leaseSeconds ?? 120;
  const { rows } = await client.query(
    `UPDATE platform.jobs
     SET status = 'running', attempts = attempts + 1,
         lease_until = now() + make_interval(secs => $2::int), updated_at = now()
     WHERE id IN (
       SELECT id FROM platform.jobs
       WHERE available_at <= now()
         AND (status = 'queued' OR (status = 'running' AND lease_until < now()))
       ORDER BY available_at
       LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit, lease]
  );
  return rows as JobRow[];
}

export async function markJobSucceeded(
  client: QueryClient,
  id: string,
  result: Record<string, unknown>
): Promise<void> {
  await client.query(
    `UPDATE platform.jobs
     SET status = 'succeeded', result = $2::jsonb, last_error = NULL,
         lease_until = NULL, completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(result ?? {})]
  );
}

// 失败：attempts 已在领取时自增。达到 max_attempts 转 dead（死信，人工接管），否则重排并退避。
export async function markJobFailed(
  client: QueryClient,
  id: string,
  error: string,
  opts: { backoffSeconds?: number } = {}
): Promise<JobStatus> {
  const backoff = opts.backoffSeconds ?? 30;
  const { rows } = await client.query(
    `UPDATE platform.jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
         available_at = CASE WHEN attempts >= max_attempts THEN available_at
                             ELSE now() + make_interval(secs => $3::int * attempts) END,
         last_error = $2, lease_until = NULL, updated_at = now()
     WHERE id = $1
     RETURNING status`,
    [id, error.slice(0, 1000), backoff]
  );
  return (rows[0]?.status ?? "queued") as JobStatus;
}

export type JobHandler = (job: JobRow, client: QueryClient) => Promise<Record<string, unknown>>;

// 内置真实处理器：从业务库聚合一份周报（纯读、无外部依赖），结果落 jobs.result。
export const defaultHandlers: Record<string, JobHandler> = {
  async generate_weekly_report(job, client) {
    const t = job.tenant_id;
    const [projects, crm, hr, finance] = await Promise.all([
      client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'active')::int AS active,
                count(*) FILTER (WHERE status = 'at_risk')::int AS at_risk
         FROM project.projects WHERE tenant_id = $1`, [t]),
      client.query(
        `SELECT count(*)::int AS open, COALESCE(sum(amount_cents),0)::bigint AS pipeline_cents
         FROM crm.opportunities WHERE tenant_id = $1 AND stage NOT IN ('won','lost')`, [t]),
      client.query(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open_reqs
         FROM hr.job_requisitions WHERE tenant_id = $1`, [t]),
      client.query(
        `SELECT COALESCE(sum(amount_cents) FILTER (WHERE status IN ('submitted','approved')),0)::bigint AS pending_expense_cents
         FROM finance.expenses WHERE tenant_id = $1`, [t]),
    ]);
    return {
      kind: "weekly_report",
      generated_at: new Date().toISOString(),
      projects: projects.rows[0],
      crm: crm.rows[0],
      hr: hr.rows[0],
      finance: finance.rows[0],
    };
  },

  // 入职编排（P1-7）：Offer 被接受后由作业驱动——建员工档案(person) + 生效雇佣(employment)
  // + 入职清单(账号/考勤组/安全培训)。幂等：同一候选人邮箱只建一份档案，在职雇佣不重复，清单不重复。
  async onboard_from_offer(job, client) {
    const offerId = String(job.payload.offer_id ?? "");
    if (!offerId) throw new Error("payload_missing_offer_id");
    const { rows: offers } = await client.query(
      `SELECT o.id, o.status, o.position_title, o.department, o.expected_start_date, o.approved_by_person_id,
              c.name AS candidate_name, c.email AS candidate_email, c.id AS candidate_id
       FROM hr.offers o JOIN hr.candidates c ON c.tenant_id = o.tenant_id AND c.id = o.candidate_id
       WHERE o.tenant_id = $1 AND o.id = $2`, [job.tenant_id, offerId]);
    const offer = offers[0];
    if (!offer) throw new Error("offer_not_found");
    if (offer.status !== "accepted") return { skipped: "offer_not_accepted", status: offer.status };

    const { rows: le } = await client.query(
      `SELECT id FROM platform.legal_entities WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`, [job.tenant_id]);
    const { rows: ou } = await client.query(
      `SELECT id FROM platform.org_units WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [job.tenant_id]);
    if (!le[0] || !ou[0]) throw new Error("tenant_missing_legal_entity_or_org_unit");

    let personId: string | null = null;
    if (offer.candidate_email) {
      const { rows } = await client.query(
        `SELECT id FROM platform.people WHERE tenant_id = $1 AND primary_email = $2 AND deleted_at IS NULL`,
        [job.tenant_id, offer.candidate_email]);
      personId = rows[0]?.id ?? null;
    }
    let personCreated = false;
    if (!personId) {
      const { rows } = await client.query(
        `INSERT INTO platform.people (id, tenant_id, display_name, primary_email, status, classification)
         VALUES (gen_random_uuid(), $1, $2, $3, 'active', 'internal') RETURNING id`,
        [job.tenant_id, offer.candidate_name, offer.candidate_email ?? null]);
      personId = rows[0].id;
      personCreated = true;
    }

    let employmentId: string | null = null;
    let employmentCreated = false;
    const { rows: emp } = await client.query(
      `SELECT id FROM platform.employments WHERE tenant_id = $1 AND person_id = $2 AND status IN ('preboarding','active') AND deleted_at IS NULL`,
      [job.tenant_id, personId]);
    if (!emp[0]) {
      const employeeNumber = `EMP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const { rows } = await client.query(
        `INSERT INTO platform.employments
           (id, tenant_id, person_id, legal_entity_id, org_unit_id, employee_number, employment_type, status, start_date)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'employee', 'active', coalesce($6, current_date)) RETURNING id`,
        [job.tenant_id, personId, le[0].id, ou[0].id, employeeNumber, offer.expected_start_date ?? null]);
      employmentId = rows[0].id;
      employmentCreated = true;
      await client.query(
        `UPDATE hr.candidates SET status = 'hired', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status <> 'hired'`,
        [job.tenant_id, offer.candidate_id]);
    } else {
      employmentId = emp[0].id;
    }

    // 入职清单：账号 / 考勤组与门禁 / 安全培训（同模板只对同一雇佣创建一次）
    let tasksCreated = 0;
    const templates: Array<[string, string]> = [
      ["开通企业账号与邮箱", "it"],
      ["加入考勤组并办理门禁", "hr"],
      ["岗位安全培训与首日引导", "training"],
    ];
    for (const [title, category] of templates) {
      const { rowCount } = await client.query(
        // 参数显式定型：INSERT..SELECT 中同一参数出现在 SELECT 列表(unknown 默认推为 text)
        // 与子查询比较(varchar)两处时，PG 会报 inconsistent types deduced for parameter。
        `INSERT INTO hr.onboarding_tasks (id, tenant_id, candidate_id, person_id, title, category, assignee_person_id, sort_order)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::varchar, $5::varchar, $6::uuid, $7::int
         WHERE NOT EXISTS (
           SELECT 1 FROM hr.onboarding_tasks t
           WHERE t.tenant_id = $1 AND t.person_id = $3 AND t.title = $4)`,
        [job.tenant_id, offer.candidate_id, personId, title, category, offer.approved_by_person_id ?? null, tasksCreated + 1]);
      tasksCreated += rowCount ?? 0;
    }
    return { person_id: personId, person_created: personCreated, employment_id: employmentId, employment_created: employmentCreated, tasks_created: tasksCreated };
  },

  // 赢单→自动立项（docs/15 P1-2）：crm.opportunity.won.v1 由 worker 转入本作业；幂等=同商机不重复立项。
  async create_project_from_opportunity(job, client) {
    const opportunityId = String(job.payload.opportunity_id ?? "");
    if (!opportunityId) throw new Error("payload_missing_opportunity_id");
    const { rows: opps } = await client.query(
      `SELECT o.id, o.name, o.customer_name, o.amount_cents, o.owner_person_id, o.account_id
       FROM crm.opportunities o WHERE o.tenant_id = $1 AND o.id = $2`, [job.tenant_id, opportunityId]);
    const opp = opps[0];
    if (!opp) throw new Error("opportunity_not_found");
    const { rows: existing } = await client.query(
      `SELECT id, code FROM project.projects WHERE tenant_id = $1 AND source_opportunity_id = $2 LIMIT 1`,
      [job.tenant_id, opportunityId]);
    if (existing[0]) return { skipped: "project_already_exists", project_id: existing[0].id, code: existing[0].code };

    const code = "PRJ-" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const { rows: created } = await client.query(
      `INSERT INTO project.projects
         (id, tenant_id, source_opportunity_id, code, name, customer_name, owner_person_id,
          budget_cents, status, start_date, progress)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'active', current_date, 0)
       RETURNING id, code`,
      [job.tenant_id, opportunityId, code,
       String(opp.name).slice(0, 180) + " 交付项目", opp.customer_name ?? "未知客户",
       opp.owner_person_id ?? null, Number(opp.amount_cents ?? 0)]);
    const project = created[0];
    // 首个里程碑：项目启动（+14 天）
    const { rowCount: msCount } = await client.query(
      `INSERT INTO project.milestones (id, tenant_id, project_id, name, status, due_date)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, '项目启动', 'pending', current_date + 14
       WHERE NOT EXISTS (SELECT 1 FROM project.milestones m WHERE m.tenant_id = $1 AND m.project_id = $2)`,
      [job.tenant_id, project.id]);
    return { project_id: project.id, code: project.code, milestone_created: (msCount ?? 0) > 0, auto: true };
  },
};

export interface ProcessResult {
  id: string;
  kind: string;
  status: JobStatus;
  error?: string;
}

// 领取并处理到期作业；handler(kind) 抛错或无处理器即走失败/重试/死信。返回逐作业结果。
export async function processDueJobs(
  client: QueryClient,
  opts: { limit?: number; leaseSeconds?: number; backoffSeconds?: number; handlers?: Record<string, JobHandler> } = {}
): Promise<ProcessResult[]> {
  const handlers = { ...defaultHandlers, ...(opts.handlers ?? {}) };
  const jobs = await claimJobs(client, opts);
  const out: ProcessResult[] = [];
  for (const job of jobs) {
    const handler = handlers[job.kind];
    try {
      if (!handler) throw new Error(`no_handler:${job.kind}`);
      const result = await handler(job, client);
      await markJobSucceeded(client, job.id, result);
      out.push({ id: job.id, kind: job.kind, status: "succeeded" });
    } catch (e) {
      const status = await markJobFailed(client, job.id, String((e as Error)?.message ?? e), opts);
      out.push({ id: job.id, kind: job.kind, status, error: String((e as Error)?.message ?? e) });
    }
  }
  return out;
}

import pg from "pg";
pg.types.setTypeParser(1082, (value: string) => value);
import { processDueJobs, enqueueJob, type JobHandler, type JobRow, type QueryClient } from "../../../packages/domain/src/job-queue.ts";
import { startFeishuWs } from "./feishu-ws.ts";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000 }) : null;

const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? "";
const INTERVAL_OUTBOX = Number(process.env.WORKER_OUTBOX_INTERVAL ?? 5_000);
const INTERVAL_SNAPSHOT = Number(process.env.WORKER_SNAPSHOT_INTERVAL ?? 3_600_000);
const INTERVAL_JOBS = Number(process.env.WORKER_JOBS_INTERVAL ?? 10_000);
const INTERVAL_STOCK_SCAN = Number(process.env.WORKER_STOCK_SCAN_INTERVAL ?? 86_400_000);
const INTERVAL_AI_SCHEDULE = Number(process.env.WORKER_AI_SCHEDULE_INTERVAL ?? 60_000);

// ── Feishu Tenant Token 缓存
let feishuToken: string | null = null;
let feishuTokenExpiry = 0;

async function getFeishuToken(): Promise<string | null> {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) return null;
  if (feishuToken && Date.now() < feishuTokenExpiry) return feishuToken;
  try {
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
    });
    const data = await res.json() as { tenant_access_token: string; expire: number };
    feishuToken = data.tenant_access_token;
    feishuTokenExpiry = Date.now() + (data.expire - 300) * 1000;
    return feishuToken;
  } catch (e) {
    log("warn", "feishu_token_error", String(e));
    return null;
  }
}

async function sendFeishuMessage(receiveId: string, receiveIdType: string, content: unknown, msgType = "interactive"): Promise<boolean> {
  const token = await getFeishuToken();
  if (!token) return false;
  try {
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) })
    });
    return res.ok;
  } catch { return false; }
}

async function sendFeishuText(receiveId: string, receiveIdType: string, text: string): Promise<boolean> {
  return sendFeishuMessage(receiveId, receiveIdType, { text }, "text");
}

async function sendFeishuCard(receiveId: string, receiveIdType: string, card: unknown): Promise<boolean> {
  return sendFeishuMessage(receiveId, receiveIdType, card, "interactive");
}

async function wsQuery(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
  if (!pool) throw new Error("database_not_configured");
  return pool.query(sql, params) as unknown as { rows: Record<string, unknown>[] };
}

function log(level: string, event: string, detail?: string): void {
  console.log(JSON.stringify({ service: "feishu-hq-worker", level, event, detail, ts: new Date().toISOString() }));
}

// ── Outbox 事件处理
async function processOutboxEvents(): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE platform.outbox_events
       SET attempts = attempts + 1, available_at = now() + interval '30 seconds'
       WHERE id IN (
         SELECT id FROM platform.outbox_events
         WHERE published_at IS NULL AND available_at <= now() AND attempts < 5
         LIMIT 10 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, event_type, actor_id, payload`
    );

    for (const event of rows) {
      try {
        await processEvent(event, client);
        await client.query(`UPDATE platform.outbox_events SET published_at = now() WHERE id = $1`, [event.id]);
        log("info", "event_processed", event.event_type);
      } catch (err) {
        log("warn", "event_failed", String(err));
        await client.query(`UPDATE platform.outbox_events SET last_error = $1 WHERE id = $2`, [String(err), event.id]);
      }
    }
  } finally { client.release(); }
}

async function processEvent(event: { tenant_id: string; event_type: string; actor_id: string; payload: Record<string, unknown> }, client: pg.PoolClient): Promise<void> {
  const { event_type, payload, tenant_id } = event;
  switch (event_type) {
    case "project.task.created": {
      const openId = await getPersonFeishuOpenId(client, tenant_id, payload.assignee_person_id as string);
      if (openId) {
        await sendFeishuMessage(openId, "open_id", buildTaskCard(payload));
      }
      break;
    }
    case "finance.payment.pending_approval": {
      const openId = await getPersonFeishuOpenId(client, tenant_id, payload.approver_person_id as string);
      if (openId) {
        await sendFeishuMessage(openId, "open_id", buildApprovalCard(payload));
      }
      break;
    }
    // 制造域业务事件：向经办人推飞书卡片通知（无飞书凭据时静默降级，不影响事件完成）
    case "mfg.work_order.completed.v1":
    case "mfg.work_order.released.v1":
    case "equipment.inspection.abnormal.v1":
    case "qms.inspection.failed.v1":
    case "purchase.invoice.matched.v1":
    case "hr.offer.accepted.v1":
    case "sales.shipment.created.v1": {
      const openId = await getPersonFeishuOpenId(client, tenant_id, event.actor_id);
      if (openId) {
        await sendFeishuMessage(openId, "open_id", buildBusinessCard(event_type, payload));
      }
      break;
    }
    // 赢单→自动立项（docs/15 P1-2）：转入持久作业（幂等：同商机只立一次），真实执行在 job 处理器
    case "crm.opportunity.won.v1": {
      await enqueueJob(client, {
        tenantId: tenant_id,
        kind: "create_project_from_opportunity",
        payload: { opportunity_id: payload.opportunity_id ?? null, name: payload.name ?? null },
        maxAttempts: 3,
        idempotencyKey: `auto_project:${payload.opportunity_id ?? ""}`,
      }).catch(err => log("warn", "auto_project_enqueue_failed", String(err)));
      const openId = await getPersonFeishuOpenId(client, tenant_id, event.actor_id);
      if (openId) {
        await sendFeishuMessage(openId, "open_id", buildBusinessCard(event_type, payload));
      }
      break;
    }
    // 新增业务事件（合同/订阅/研发/绩效/里程碑）：仅通知
    case "sales.contract.signed.v1":
    case "sales.subscription.activated.v1":
    case "sw.requirement.created.v1":
    case "sw.defect.created.v1":
    case "sw.defect.closed.v1":
    case "sw.version.released.v1":
    case "project.milestone.completed.v1":
    case "hr.review.completed.v1": {
      const openId = await getPersonFeishuOpenId(client, tenant_id, event.actor_id);
      if (openId) {
        await sendFeishuMessage(openId, "open_id", buildBusinessCard(event_type, payload));
      }
      break;
    }
    default:
      log("debug", "unhandled_event", event_type);
  }
}

async function getPersonFeishuOpenId(client: pg.PoolClient, tenantId: string, personId?: string): Promise<string | null> {
  if (!personId) return null;
  const { rows } = await client.query(
    `SELECT external_subject FROM platform.external_identities WHERE tenant_id = $1 AND person_id = $2 AND provider = 'feishu' LIMIT 1`,
    [tenantId, personId]
  );
  return rows[0]?.external_subject ?? null;
}

function buildTaskCard(p: Record<string, unknown>): unknown {
  return {
    schema: "2.0",
    header: { template: "blue", title: { tag: "plain_text", content: "◫ 新任务分配给你" } },
    body: { elements: [
      { tag: "markdown", content: `**${p.title}**\n优先级：${p.priority ?? "中"}` },
      { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "查看" }, type: "primary", url: `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/#projects` }] }
    ]}
  };
}

function buildApprovalCard(p: Record<string, unknown>): unknown {
  return {
    schema: "2.0",
    header: { template: "orange", title: { tag: "plain_text", content: "⚡ 待你审批" } },
    body: { elements: [
      { tag: "markdown", content: `**${p.title ?? "审批请求"}**\n金额：¥ ${Number(p.amount_cents ?? 0) / 100}` },
      { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "审批" }, type: "primary", url: `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/#finance` }] }
    ]}
  };
}

const BUSINESS_EVENT_TITLES: Record<string, string> = {
  "mfg.work_order.completed.v1": "🏭 工单完工入库",
  "mfg.work_order.released.v1": "🏭 生产工单已下达",
  "equipment.inspection.abnormal.v1": "⚠️ 设备点检异常",
  "qms.inspection.failed.v1": "🚫 质检判定不合格",
  "purchase.invoice.matched.v1": "🧾 采购三单匹配完成，已生应付",
  "hr.offer.accepted.v1": "🎉 Offer 已接受，入职编排已启动",
  "sales.shipment.created.v1": "🚚 销售发货已出库",
  "crm.opportunity.won.v1": "🏆 商机赢单，自动立项已排队",
  "sales.contract.signed.v1": "📝 合同已签署生效",
  "sales.subscription.activated.v1": "🔁 订阅已生效（MRR 更新）",
  "sw.requirement.created.v1": "📋 新需求进入需求池",
  "sw.defect.created.v1": "🐞 新缺陷已登记",
  "sw.defect.closed.v1": "✅ 缺陷已验证关闭",
  "sw.version.released.v1": "🚀 版本已发布",
  "project.milestone.completed.v1": "🏁 里程碑达成",
  "hr.review.completed.v1": "🎖️ 绩效评定完成",
};

function buildBusinessCard(eventType: string, p: Record<string, unknown>): unknown {
  const title = BUSINESS_EVENT_TITLES[eventType] ?? eventType;
  const detail = Object.entries(p).slice(0, 4).map(([k, v]) => `${k}：${String(v)}`).join("\n");
  return {
    schema: "2.0",
    header: { template: "turquoise", title: { tag: "plain_text", content: title } },
    body: { elements: [{ tag: "markdown", content: detail || "业务事件已发生" }] }
  };
}

// ── 工作区快照
async function updateWorkspaceSnapshots(): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const { rows: tenants } = await client.query(`SELECT id FROM platform.tenants WHERE status = 'active'`);
    for (const tenant of tenants) {
      try { await updateSnapshotForTenant(client, tenant.id); }
      catch (e) { log("warn", "snapshot_failed", `tenant=${tenant.id} ${String(e)}`); }
    }
  } finally { client.release(); }
}

async function updateSnapshotForTenant(client: pg.PoolClient, tenantId: string): Promise<void> {
  // 所有查询都显式带 tenant_id，不依赖会话级设置；避免 set_config(..., true) 在自动提交下失效。
  const [projects, crm, hr, finance, it, knowledge] = await Promise.all([
    client.query(`SELECT count(*) AS total, avg(progress) AS avg_progress FROM project.projects WHERE tenant_id = $1`, [tenantId]),
    client.query(`SELECT count(*) AS opportunities, sum(amount_cents) AS pipeline FROM crm.opportunities WHERE tenant_id = $1 AND stage NOT IN ('won','lost')`, [tenantId]),
    client.query(`SELECT count(*) FILTER (WHERE status = 'active') AS employees FROM platform.employments WHERE tenant_id = $1`, [tenantId]),
    client.query(`SELECT sum(amount_cents) FILTER (WHERE status = 'paid' AND due_date >= date_trunc('month', current_date)) AS month_receipts FROM finance.payment_plans WHERE tenant_id = $1`, [tenantId]),
    client.query(`SELECT count(*) AS total FROM it.assets WHERE tenant_id = $1 AND deleted_at IS NULL`, [tenantId]),
    client.query(`SELECT count(*) AS indexed FROM knowledge.items WHERE tenant_id = $1 AND index_status = 'indexed' AND deleted_at IS NULL`, [tenantId])
  ]);

  const metrics = {
    monthly_receipts: { value: `¥ ${Number(finance.rows[0].month_receipts ?? 0).toLocaleString("zh-CN")}` },
    sales_pipeline: { value: `¥ ${Number(crm.rows[0].pipeline ?? 0).toLocaleString("zh-CN")}`, new_this_week: crm.rows[0].opportunities },
    project_health: { value: Math.round(Number(projects.rows[0].avg_progress ?? 0)), total: projects.rows[0].total },
    headcount: { value: hr.rows[0].employees }
  };

  const modules = {
    projects: projects.rows[0].total,
    crm_opportunities: crm.rows[0].opportunities,
    employees: hr.rows[0].employees,
    it_assets: it.rows[0].total,
    knowledge_items: knowledge.rows[0].indexed
  };

  const connections = [
    { key: "feishu", name: "飞书组织与协作", status: FEISHU_APP_ID ? "connected" : "awaiting_credentials", records: 0 },
    { key: "postgres", name: "总部数据平台", status: "connected", records: Number(projects.rows[0].total ?? 0) },
    { key: "ai", name: "企业 AI 网关", status: process.env.MODEL_API_KEY ? "configured" : "awaiting_credentials", records: 0 }
  ];

  await client.query(
    `INSERT INTO platform.workspace_snapshots (id, tenant_id, snapshot_date, metrics, decisions, connections, modules)
     VALUES (gen_random_uuid(), $1, current_date, $2, '[]', $3, $4)
     ON CONFLICT (tenant_id, snapshot_date)
     DO UPDATE SET metrics = $2, connections = $3, modules = $4, updated_at = now()`,
    [tenantId, JSON.stringify(metrics), JSON.stringify(connections), JSON.stringify(modules)]
  );
  log("info", "snapshot_updated", `tenant=${tenantId}`);
}

// ── 持久作业队列：领取到期作业并处理（可恢复/重试/死信），与验收 harness 共用同一实现。
async function processJobs(): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const results = await processDueJobs(client, { limit: 20, handlers: aiScheduledRunHandler });
    for (const r of results) {
      log(r.status === "succeeded" ? "info" : "warn", `job_${r.status}`, `${r.kind}:${r.id}${r.error ? " " + r.error : ""}`);
    }
  } finally { client.release(); }
}

// ── 知识库索引（简单触发）
// PostgreSQL 不支持 `UPDATE ... LIMIT`；用与 outbox 一致的 `WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` 批量取一批。
async function processKnowledgeIndexing(): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE knowledge.items
       SET index_status = 'indexed', last_indexed_at = now()
       WHERE id IN (
         SELECT id FROM knowledge.items
         WHERE index_status = 'pending' AND deleted_at IS NULL
           AND content IS NOT NULL AND char_length(content) > 50
         ORDER BY id
         LIMIT 50 FOR UPDATE SKIP LOCKED
       )`
    );
    if (rowCount) log("info", "knowledge_indexed", `count=${rowCount}`);
  } finally { client.release(); }
}

// ── AI 定时任务（docs/19 P4）：以任务所属用户身份执行受控工具；执行前再走一次授权（回收即停摆）
const aiScheduledRunHandler: Record<string, JobHandler> = {
  ai_scheduled_run: async (job: JobRow, _client: QueryClient) => {
    const scheduleId = String(job.payload.schedule_id ?? "");
    const { rows } = await _client.query(
      `SELECT s.*, p.status AS person_status FROM platform.ai_schedules s
       JOIN platform.people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
       WHERE s.tenant_id = $1 AND s.id = $2`, [job.tenant_id, scheduleId]);
    const schedule = rows[0];
    if (!schedule || schedule.status !== "active" || schedule.person_status !== "active") {
      return { skipped: "schedule_inactive" };
    }
    const { executeTool } = await import("../../../apps/api/src/ai.ts");
    const identity = { tenantId: schedule.tenant_id, personId: schedule.person_id, role: "employee", mode: "feishu" };
    const result = await executeTool(String(schedule.tool_name), schedule.args ?? {}, identity as never, {
      traceId: "schedule:" + scheduleId + ":" + job.id.slice(0, 8),
    });
    return { tool: schedule.tool_name, executed: true, result_keys: result && typeof result === "object" ? Object.keys(result as Record<string, unknown>) : [] };
  },
};

// 扫描到期任务 → 幂等入队 + 推进 next_run_at
async function scanAiSchedules(): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE platform.ai_schedules
       SET next_run_at = now() + make_interval(mins => interval_minutes::int),
           run_count = run_count + 1, last_run_at = now(), updated_at = now(), version = version + 1
       WHERE id IN (
         SELECT id FROM platform.ai_schedules
         WHERE status = 'active' AND next_run_at <= now()
           AND (max_runs IS NULL OR run_count < max_runs)
         LIMIT 20 FOR UPDATE SKIP LOCKED
       ) RETURNING id, tenant_id, run_count`);
    for (const schedule of rows) {
      await enqueueJob(client, {
        tenantId: schedule.tenant_id,
        kind: "ai_scheduled_run",
        payload: { schedule_id: schedule.id },
        maxAttempts: 3,
        idempotencyKey: `ai_schedule:${schedule.id}:${schedule.run_count}`,
      }).catch(err => log("warn", "ai_schedule_enqueue_failed", String(err)));
    }
    await client.query(
      `UPDATE platform.ai_schedules SET status = 'paused', updated_at = now()
       WHERE status = 'active' AND max_runs IS NOT NULL AND run_count >= max_runs`);
    if (rows.length) log("info", "ai_schedules_enqueued", `count=${rows.length}`);
  } finally { client.release(); }
}

// ── 库存安全库存扫描：低于安全库存的料号发 outbox 事件（按 天+料号 幂等）
async function scanStockAlerts(): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT id FROM platform.tenants WHERE status = 'active'");
    for (const tenant of rows) {
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenant.id]);
      const { rows: alerts } = await client.query(
        `SELECT p.id, p.part_number, p.safety_stock,
                coalesce(sum(o.quantity - o.blocked_quantity), 0)::numeric AS available
         FROM mfg.parts p
         LEFT JOIN stock.onhand o ON o.tenant_id = p.tenant_id AND o.part_id = p.id
         WHERE p.tenant_id = platform.current_tenant_id() AND p.safety_stock > 0 AND p.status = 'active'
         GROUP BY p.id, p.tenant_id
         HAVING coalesce(sum(o.quantity - o.blocked_quantity), 0) < p.safety_stock`);
      for (const a of alerts) {
        const day = new Date().toISOString().slice(0, 10);
        await client.query(
          `INSERT INTO platform.outbox_events
             (id, tenant_id, event_type, event_version, aggregate_type, aggregate_id, actor_id, trace_id, idempotency_key, payload)
           VALUES (gen_random_uuid(), platform.current_tenant_id(), 'stock.below_safety.v1', 1, 'mfg.parts', $1, NULL, 'stock-scan', $2, $3::jsonb)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
          [a.id, `stock_alert:${tenant.id}:${a.id}:${day}`,
           JSON.stringify({ part_number: a.part_number, safety_stock: Number(a.safety_stock), available: Number(a.available) })]);
      }
    }
  } finally {
    await client.query("RESET app.tenant_id").catch(() => undefined);
    client.release();
  }
}

// ── 审批超时扫描：到期待办提醒审批人与申请人（幂等，只提醒一次）
async function scanApprovalTimeouts(): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT ai.id, ai.tenant_id, ai.title, ai.requester_person_id, ai.due_at,
              (SELECT approver_person_id FROM platform.approval_actions aa
               WHERE aa.tenant_id = ai.tenant_id AND aa.instance_id = ai.id
                 AND aa.step_order = ai.current_step AND aa.status = 'pending' LIMIT 1) AS approver_person_id
       FROM platform.approval_instances ai
       WHERE ai.status = 'pending' AND ai.due_at IS NOT NULL
         AND ai.due_at < now() AND ai.escalated_at IS NULL
       ORDER BY ai.due_at LIMIT 100`
    );
    for (const a of rows) {
      for (const personId of new Set([a.approver_person_id, a.requester_person_id].filter(Boolean))) {
        await client.query(
          `INSERT INTO platform.notifications (id, tenant_id, person_id, kind, title, body, link, dedupe_key)
           VALUES (gen_random_uuid(), $1, $2, 'approval', $3, $4, '/#approvals', $5)
           ON CONFLICT (tenant_id, person_id, dedupe_key) DO NOTHING`,
          [a.tenant_id, personId, `审批已超时：${a.title}`,
           `应于 ${new Date(a.due_at).toLocaleString("zh-CN")} 前完成，请尽快处理。`,
           `approval:timeout:${a.id}:${personId}`]
        );
      }
      await client.query(
        `UPDATE platform.approval_instances SET escalated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [a.tenant_id, a.id]
      );
      log("warn", "approval_timeout", `instance=${a.id}`);
    }
  } finally { client.release(); }
}

// ── 主入口
async function runWorker(): Promise<void> {
  log("info", "worker_starting", `pid=${process.pid}`);

  if (!pool) {
    log("warn", "no_database", "DATABASE_URL not set, running in stub mode");
  }

  await updateWorkspaceSnapshots().catch(e => log("warn", "initial_snapshot_failed", String(e)));

  setInterval(() => processOutboxEvents().catch(e => log("warn", "outbox_error", String(e))), INTERVAL_OUTBOX);
  setInterval(() => processJobs().catch(e => log("warn", "jobs_error", String(e))), INTERVAL_JOBS);
  setInterval(() => processKnowledgeIndexing().catch(e => log("warn", "indexing_error", String(e))), 30_000);
  setInterval(() => updateWorkspaceSnapshots().catch(e => log("warn", "snapshot_error", String(e))), INTERVAL_SNAPSHOT);
  // Kodbox 权限同步：每小时运行一次
  setInterval(() => processKodboxSync().catch(e => log("warn", "kodbox_sync_error", String(e))), 3_600_000);
  // 库存安全库存扫描（docs/18）：触警料号发事件（按天幂等）
  setInterval(() => scanStockAlerts().catch(e => log("warn", "stock_scan_error", String(e))), INTERVAL_STOCK_SCAN);
  // AI 定时任务扫描（docs/19）：到点入持久作业（幂等），由 ai_scheduled_run 处理器以本人身份执行
  setInterval(() => scanAiSchedules().catch(e => log("warn", "ai_schedule_scan_error", String(e))), INTERVAL_AI_SCHEDULE);
  const INTERVAL_APPROVAL_SCAN = Number(process.env.WORKER_APPROVAL_SCAN_INTERVAL ?? 900_000);
  setInterval(() => scanApprovalTimeouts().catch(e => log("warn", "approval_scan_error", String(e))), INTERVAL_APPROVAL_SCAN);

  // 飞书长连接（WebSocket）：无需公网域名即可接收事件与卡片回调；凭据缺失时静默跳过
  if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
    startFeishuWs({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, log, sendText: sendFeishuText, sendCard: sendFeishuCard, query: wsQuery });
    log("info", "feishu_ws_starting", `app_id=${FEISHU_APP_ID}`);
  }

  log("info", "worker_ready", `outbox=${INTERVAL_OUTBOX}ms jobs=${INTERVAL_JOBS}ms snapshot=${INTERVAL_SNAPSHOT}ms`);
}

async function processKodboxSync(): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const { rows: instances } = await client.query(
      `SELECT i.*, pgp_sym_decrypt(admin_password_encrypted, current_setting('app.encryption_key')) AS admin_password
       FROM integrations.kodbox_instances i
       WHERE i.status = 'active'`
    );

    for (const inst of instances) {
      try {
        await syncKodboxInstance(client, inst);
      } catch (err) {
        log("warn", "kodbox_sync_failed", `instance=${inst.id} ${String(err)}`);
        await client.query(
          `UPDATE integrations.kodbox_instances SET last_sync_status = 'error', last_sync_error = $1, last_sync_at = now() WHERE id = $2`,
          [String(err), inst.id]
        );
      }
    }
  } finally {
    await client.query("RESET app.tenant_id").catch(() => undefined);
    client.release();
  }
}

async function syncKodboxInstance(client: pg.PoolClient, inst: any): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, false)", [inst.tenant_id]);

  // 获取飞书配置
  const { rows: feishuConfig } = await client.query(
    `SELECT app_id, app_secret, encrypt_key FROM platform.tenant_settings WHERE tenant_id = $1 AND namespace = 'feishu' AND key = 'app_config'`,
    [inst.tenant_id]
  );
  if (!feishuConfig[0]?.app_id || !feishuConfig[0]?.app_secret) {
    throw new Error("Feishu not configured for this tenant");
  }

  // 获取飞书组织数据
  const token = await getFeishuTenantToken(feishuConfig[0].app_id, feishuConfig[0].app_secret);
  if (!token) throw new Error("Failed to get Feishu token");

  const [users, departments] = await Promise.all([
    fetchFeishuUsers(token),
    fetchFeishuDepartments(token)
  ]);

  // 获取权限映射规则
  const { rows: rules } = await client.query(
    `SELECT * FROM integrations.kodbox_permission_rules WHERE tenant_id = $1 AND instance_id = $2 AND is_active`,
    [inst.tenant_id, inst.id]
  );

  // 获取现有映射
  const { rows: existingUsers } = await client.query(
    `SELECT * FROM integrations.kodbox_user_mappings WHERE tenant_id = $1 AND instance_id = $2`,
    [inst.tenant_id, inst.id]
  );
  const { rows: existingDirs } = await client.query(
    `SELECT * FROM integrations.kodbox_directory_mappings WHERE tenant_id = $1 AND instance_id = $2`,
    [inst.tenant_id, inst.id]
  );

  // 创建 Kodbox 客户端（使用动态导入避免循环依赖）
  const { KodboxClient } = await import("../../../packages/connectors/kodbox/src/kodbox-client.ts");
  const kodbox = new KodboxClient({
    baseUrl: inst.base_url,
    username: inst.admin_username,
    password: inst.admin_password
  });

  const runId = crypto.randomUUID();
  const syncBatchId = runId;
  const stats = { usersCreated: 0, usersUpdated: 0, usersDisabled: 0, directoriesCreated: 0, permissionsApplied: 0, permissionsRevoked: 0 };

  // 记录同步任务开始
  await client.query(
    `INSERT INTO integrations.kodbox_sync_runs (id, tenant_id, instance_id, sync_type, status, sync_batch_id, triggered_by)
     VALUES ($1, $2, $3, 'full', 'running', $4, 'auto')`,
    [runId, inst.tenant_id, inst.id, syncBatchId]
  );

  try {
    // 同步用户
    const existingUserMap = new Map<string, any>();
    for (const u of existingUsers) existingUserMap.set(u.feishu_open_id, u);

    for (const user of users) {
      if (user.status !== "active") continue;
      const existing = existingUserMap.get(user.open_id);
      const homePath = `/个人文件/${user.name}_${user.open_id.slice(0, 8)}`;

      if (existing) {
        stats.usersUpdated++;
        await client.query(
          `UPDATE integrations.kodbox_user_mappings SET kodbox_home_path = $1, status = 'active', last_synced_at = now(), version = version + 1
           WHERE tenant_id = $2 AND instance_id = $3 AND feishu_open_id = $4`,
          [homePath, inst.tenant_id, inst.id, user.open_id]
        );
      } else {
        // 创建 Kodbox 用户
        const kodboxUsername = `fs_${user.open_id.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50)}`;
        const password = generateRandomPassword(16);
        const createResp = await kodbox.createUser(kodboxUsername, password, "user", homePath);
        if (createResp.code === 0) {
          stats.usersCreated++;
          await client.query(
            `INSERT INTO integrations.kodbox_user_mappings
               (id, tenant_id, instance_id, feishu_open_id, feishu_union_id, feishu_user_id, kodbox_user_id, kodbox_username, kodbox_home_path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [crypto.randomUUID(), inst.tenant_id, inst.id, user.open_id, user.union_id ?? null, user.user_id ?? null, 1, kodboxUsername, homePath]
          );
          // 记录审计
          await client.query(
            `INSERT INTO integrations.kodbox_permission_audit
               (id, tenant_id, instance_id, action, target_type, target_id, kodbox_path, new_permission, operator_feishu_open_id, reason, sync_batch_id)
             VALUES ($1, $2, $3, 'sync', 'user', $4, $5, 'read_write', $6, 'auto sync', $7)`,
            [crypto.randomUUID(), inst.tenant_id, inst.id, user.open_id, homePath, user.open_id, syncBatchId]
          );
        }
      }
    }

    // 禁用离职用户
    const activeOpenIds = new Set(users.filter(u => u.status === "active").map(u => u.open_id));
    for (const mapping of existingUsers) {
      if (!activeOpenIds.has(mapping.feishu_open_id) && mapping.status === "active") {
        stats.usersDisabled++;
        await client.query(
          `UPDATE integrations.kodbox_user_mappings SET status = 'disabled', updated_at = now() WHERE id = $1`,
          [mapping.id]
        );
        await client.query(
          `INSERT INTO integrations.kodbox_permission_audit
             (id, tenant_id, instance_id, action, target_type, target_id, new_permission, operator_feishu_open_id, reason, sync_batch_id)
           VALUES ($1, $2, $3, 'sync', 'user', $4, 'disabled', $5, 'user resigned', $6)`,
          [crypto.randomUUID(), inst.tenant_id, inst.id, mapping.feishu_open_id, mapping.feishu_open_id, syncBatchId]
        );
      }
    }

    // 同步部门目录
    const deptPathMap = new Map<string, string>();
    const existingDirMap = new Map<string, any>();
    for (const d of existingDirs) existingDirMap.set(d.feishu_department_id, d);

    // 拓扑排序部门
    const sortedDepts = topologicalSortDepartments(departments);

    for (const dept of sortedDepts) {
      if (dept.status !== "active") continue;

      let parentPath = "/共享文件/部门文件";
      if (dept.parent_open_department_id) {
        parentPath = deptPathMap.get(dept.parent_open_department_id) || parentPath;
      }

      const deptName = dept.name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 100);
      const deptPath = parentPath.endsWith("/") ? `${parentPath}${deptName}` : `${parentPath}/${deptName}`;
      deptPathMap.set(dept.open_department_id, deptPath);

      const existingDir = existingDirMap.get(dept.open_department_id);
      if (!existingDir) {
        // 在 Kodbox 创建目录
        await ensureKodboxDirectory(kodbox, deptPath);
        stats.directoriesCreated++;
        await client.query(
          `INSERT INTO integrations.kodbox_directory_mappings
             (id, tenant_id, instance_id, feishu_department_id, feishu_department_name, parent_feishu_department_id, kodbox_path, permissions_applied)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)`,
          [crypto.randomUUID(), inst.tenant_id, inst.id, dept.open_department_id, dept.name, dept.parent_open_department_id ?? null, deptPath]
        );
      }
    }

    // 应用权限映射规则
    for (const rule of rules) {
      const deptPath = deptPathMap.get(rule.feishu_department_id);
      if (!deptPath) continue;

      // 获取该部门及子部门的用户
      const targetUserIds = getDepartmentUserIds(departments, users, rule.feishu_department_id, rule.inherit_to_children);

      for (const openId of targetUserIds) {
        const userMapping = existingUserMap.get(openId);
        if (!userMapping) continue;

        const permResp = await kodbox.setPathPermission(deptPath, String(userMapping.kodbox_user_id), rule.permission);
        if (permResp.code === 0) {
          stats.permissionsApplied++;
          // 更新目录映射的权限应用状态
          await client.query(
            `UPDATE integrations.kodbox_directory_mappings SET permissions_applied = true, updated_at = now()
             WHERE tenant_id = $1 AND instance_id = $2 AND feishu_department_id = $3`,
            [inst.tenant_id, inst.id, rule.feishu_department_id]
          );
        }
      }
    }

    // 更新同步任务状态
    await client.query(
      `UPDATE integrations.kodbox_sync_runs SET status = 'completed', completed_at = now(), stats = $1
       WHERE id = $2`,
      [JSON.stringify(stats), runId]
    );
    await client.query(
      `UPDATE integrations.kodbox_instances SET last_sync_status = 'completed', last_sync_at = now(), last_sync_error = NULL WHERE id = $1`,
      [inst.id]
    );

    log("info", "kodbox_sync_completed", `instance=${inst.id} stats=${JSON.stringify(stats)}`);
  } catch (err) {
    await client.query(
      `UPDATE integrations.kodbox_sync_runs SET status = 'failed', completed_at = now(), error_message = $1 WHERE id = $2`,
      [String(err), runId]
    );
    throw err;
  }
}

async function getFeishuTenantToken(appId: string, appSecret: string): Promise<string | null> {
  try {
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    const data = await res.json() as { tenant_access_token: string; expire: number };
    return data.tenant_access_token;
  } catch {
    return null;
  }
}

async function fetchFeishuUsers(token: string): Promise<any[]> {
  const users: any[] = [];
  let pageToken = "";
  do {
    const res = await fetch(`https://open.feishu.cn/open-apis/contact/v3/users?page_size=100${pageToken ? `&page_token=${pageToken}` : ""}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await res.json() as { data?: { items?: any[]; has_more?: boolean; page_token?: string } };
    if (data.data?.items) users.push(...data.data.items);
    pageToken = data.data?.page_token ?? "";
  } while (pageToken);
  return users;
}

async function fetchFeishuDepartments(token: string): Promise<any[]> {
  const departments: any[] = [];
  let pageToken = "";
  do {
    const res = await fetch(`https://open.feishu.cn/open-apis/contact/v3/departments?page_size=100${pageToken ? `&page_token=${pageToken}` : ""}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await res.json() as { data?: { items?: any[]; has_more?: boolean; page_token?: string } };
    if (data.data?.items) departments.push(...data.data.items);
    pageToken = data.data?.page_token ?? "";
  } while (pageToken);
  return departments;
}

function topologicalSortDepartments(departments: any[]): any[] {
  const byId = new Map(departments.map(d => [d.open_department_id, d]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: any[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const dept = byId.get(id);
    if (!dept) return;
    if (dept.parent_open_department_id && byId.has(dept.parent_open_department_id)) {
      visit(dept.parent_open_department_id);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(dept);
  }

  for (const dept of departments) visit(dept.open_department_id);
  return sorted;
}

function getDepartmentUserIds(departments: any[], users: any[], rootDeptId: string, includeChildren: boolean): string[] {
  const activeDepartments = departments.filter(d => d.status === "active");
  const activeDeptIds = new Set(activeDepartments.map(d => d.open_department_id));
  if (!activeDeptIds.has(rootDeptId)) return [];

  const targetDeptIds = new Set<string>([rootDeptId]);
  if (includeChildren) {
    const deptByParent = new Map<string, string[]>();
    for (const dept of activeDepartments) {
      if (dept.parent_open_department_id && activeDeptIds.has(dept.parent_open_department_id)) {
        const arr = deptByParent.get(dept.parent_open_department_id) || [];
        arr.push(dept.open_department_id);
        deptByParent.set(dept.parent_open_department_id, arr);
      }
    }
    const queue = [rootDeptId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = deptByParent.get(current) || [];
      for (const child of children) {
        if (!targetDeptIds.has(child)) {
          targetDeptIds.add(child);
          queue.push(child);
        }
      }
    }
  }
  return users.filter(u => u.status === "active" && u.department_ids?.some((d: string) => targetDeptIds.has(d))).map(u => u.open_id);
}

async function ensureKodboxDirectory(kodbox: any, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let currentPath = "/";
  for (const part of parts) {
    currentPath = `${currentPath}${part}`;
    if (!(await kodbox.exists(currentPath))) {
      const parentPath = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
      await kodbox.mkdir(parentPath, part);
    }
    currentPath += "/";
  }
}

function generateRandomPassword(length: number): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let password = "";
  for (let i = 0; i < length; i++) password += charset.charAt(Math.floor(Math.random() * charset.length));
  return password;
}

runWorker().catch(e => { log("error", "worker_crash", String(e)); process.exit(1); });

process.on("SIGTERM", async () => {
  log("info", "worker_stopping");
  if (pool) await pool.end();
  process.exit(0);
});

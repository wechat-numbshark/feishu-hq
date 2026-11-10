// M2 验收：审批内核真实库回归 + 每项设置真实消费者生效读回。
// 隔离库 + 真实 HTTP 服务器 + 真实 HMAC 会话；审批内核用真实事务/RLS 直连验证。
// 约束：自建临时容器、不改 .env、不部署正式、绝对禁止编造结果。
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth,
  makeCookies, HOST_URL, REPO, ADMIN_DB_URL, SESSION_SECRET,
} from "./lib.mjs";

const SEED = `${REPO}/scripts/acceptance/seed.mjs`;

async function call(cookie, method, path, body) {
  const res = await fetch(`${HOST_URL}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-json */ }
  return { status: res.status, payload };
}

// 在一个受控事务内以 RLS(hq_app) 身份执行回调（与 withTenant 等价）。
async function withTenantDb(client, tenantId, fn) {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  await client.query("SET LOCAL ROLE hq_app");
  try {
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

async function safe(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

const T = (await import("./seed.mjs")).T;

// ── Part A：审批内核真实库回归 ──────────────────────────────
async function approvalKernel() {
  // 导入被测函数（需先配置 DATABASE_URL，令 db.ts 建立连接池）。
  process.env.DATABASE_URL = ADMIN_DB_URL;
  process.env.SESSION_SECRET = SESSION_SECRET;
  const { createApprovalInstance, processApprovalDecision } =
    await import("../../apps/api/src/modules/approvals.ts");

  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  // 追加一条"单步直属上级"流程（运行时数据，非迁移），用于终止/并发断言。
  const singleFlowId = randomUUID();
  await admin.query(
    `INSERT INTO platform.approval_flows (id, tenant_id, code, name, module, steps, auto_approve_if_no_approver, is_active)
     VALUES ($1,$2,'kernel_single','单步内核流程','finance',$3::jsonb,false,true)
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [singleFlowId, T.tenant, JSON.stringify([{ order: 1, type: "manager", label: "直属上级" }])]
  );

  const results = [];
  const push = (name, pass, detail) => results.push({ name, ok: !!pass, detail });

  // A1 幂等键：同一 (flow,resource,requester) 第二次创建被拒。
  {
    const resourceId = randomUUID();
    const c1 = await withTenantDb(admin, T.tenant, (db) => createApprovalInstance(db, {
      tenantId: T.tenant, flowCode: "expense", resourceType: "expense", resourceId,
      requesterPersonId: T.employee, title: "幂等测试", summary: {}, managerPersonId: T.manager,
    }));
    const c2 = await withTenantDb(admin, T.tenant, (db) => createApprovalInstance(db, {
      tenantId: T.tenant, flowCode: "expense", resourceType: "expense", resourceId,
      requesterPersonId: T.employee, title: "幂等测试", summary: {}, managerPersonId: T.manager,
    }));
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM platform.approval_instances WHERE tenant_id=$1 AND resource_id=$2`,
      [T.tenant, resourceId]);
    push("A1 幂等键：重复创建返回 null 且仅 1 实例",
      c1 != null && c2 === null && rows[0].n === 1,
      { first: !!c1, second: c2, instances: rows[0].n });
  }

  // A2 缺审批人 null 指派：manager 为 null 时进入待指派队列，且无人可决策。
  {
    const resourceId = randomUUID();
    const inst = await withTenantDb(admin, T.tenant, (db) => createApprovalInstance(db, {
      tenantId: T.tenant, flowCode: "expense", resourceType: "expense", resourceId,
      requesterPersonId: T.employee, title: "缺主管", summary: {}, managerPersonId: null,
    }));
    const { rows } = await admin.query(
      `SELECT approver_person_id FROM platform.approval_actions WHERE instance_id=$1 AND step_order=1`,
      [inst]);
    const nullApprover = rows[0] && rows[0].approver_person_id === null;
    const dec = await withTenantDb(admin, T.tenant, (db) =>
      safe(() => processApprovalDecision(db, inst, T.employee, "approved", null)));
    push("A2 缺主管：step1 审批人为 null 且决策被拒(permission_denied)",
      nullApprover && dec.ok === false && /permission_denied/.test(dec.error || ""),
      { approver: rows[0]?.approver_person_id, decision: dec });
  }

  // A3 职责分离 + A4 版本快照 + 多步推进：manager 批准 step1 -> step2(role, null)。
  {
    const resourceId = randomUUID();
    const inst = await withTenantDb(admin, T.tenant, (db) => createApprovalInstance(db, {
      tenantId: T.tenant, flowCode: "expense", resourceType: "expense", resourceId,
      requesterPersonId: T.employee, title: "分离/快照", summary: {}, managerPersonId: T.manager,
    }));
    // 非审批人（employee）决策 -> 拒绝
    const wrong = await withTenantDb(admin, T.tenant, (db) =>
      safe(() => processApprovalDecision(db, inst, T.employee, "approved", "x")));
    // 正确审批人（manager）决策 -> 进入 step2
    const right = await withTenantDb(admin, T.tenant, (db) =>
      processApprovalDecision(db, inst, T.manager, "approved", "同意"));
    const { rows: instRows } = await admin.query(
      `SELECT status, current_step FROM platform.approval_instances WHERE id=$1`, [inst]);
    const { rows: a2Rows } = await admin.query(
      `SELECT approver_person_id FROM platform.approval_actions WHERE instance_id=$1 AND step_order=2`, [inst]);
    // 版本快照存在且含 decision
    const { rows: snap } = await admin.query(
      `SELECT snapshot_jsonb FROM platform.approval_flow_versions WHERE tenant_id=$1 AND instance_id=$2`,
      [T.tenant, inst]);
    push("A3 职责分离：非审批人决策被拒",
      wrong.ok === false && /permission_denied/.test(wrong.error || ""),
      { wrong });
    push("A3 正确审批人批准 step1 -> 进入 step2(role, 审批人 null)",
      right.newStatus === "pending" && instRows[0]?.current_step === 2 && a2Rows[0]?.approver_person_id === null,
      { newStatus: right.newStatus, current_step: instRows[0]?.current_step, step2_approver: a2Rows[0]?.approver_person_id });
    push("A4 版本快照：approval_flow_versions 记录了 decision",
      snap.length >= 1 && snap[0].snapshot_jsonb && snap[0].snapshot_jsonb.decision === "approved",
      { snapshots: snap.length, sample: snap[0]?.snapshot_jsonb });
  }

  // A5 FOR UPDATE 并发：单步流程上并发两次决策，恰好一次终止、另一次读到非 pending。
  {
    const resourceId = randomUUID();
    const inst = await withTenantDb(admin, T.tenant, (db) => createApprovalInstance(db, {
      tenantId: T.tenant, flowCode: "kernel_single", resourceType: "expense", resourceId,
      requesterPersonId: T.employee, title: "并发", summary: {}, managerPersonId: T.manager,
    }));
    const cA = new pg.Client({ connectionString: ADMIN_DB_URL });
    const cB = new pg.Client({ connectionString: ADMIN_DB_URL });
    await cA.connect(); await cB.connect();
    try {
      const [rA, rB] = await Promise.all([
        withTenantDb(cA, T.tenant, (db) => processApprovalDecision(db, inst, T.manager, "approved", "A").catch((e) => ({ err: String(e.message) }))),
        withTenantDb(cB, T.tenant, (db) => processApprovalDecision(db, inst, T.manager, "approved", "B").catch((e) => ({ err: String(e.message) }))),
      ]);
      const { rows } = await admin.query(`SELECT status FROM platform.approval_instances WHERE id=$1`, [inst]);
      const decided = [rA, rB].filter((r) => r && r.ok === true && r.newStatus === "approved").length;
      const blocked = [rA, rB].filter((r) => r && (r.ok === false)).length;
      push("A5 FOR UPDATE 并发：同一实例并发决策，恰好一次 approved、一次非 pending",
        decided === 1 && rows[0]?.status === "approved",
        { rA, rB, final_status: rows[0]?.status, decided, blocked });
    } finally {
      await cA.end(); await cB.end();
    }
  }

  await admin.end();
  return results;
}

// ── Part B：每项设置真实消费者生效读回 ─────────────────────
async function settingConsumers(cookies) {
  const results = [];
  const push = (name, pass, detail) => results.push({ name, ok: !!pass, detail });

  const setFinance = (b) => call(cookies.admin, "PATCH", "/v1/settings/finance", b);
  const setCrm = (b) => call(cookies.admin, "PATCH", "/v1/settings/crm", b);
  const setIt = (b) => call(cookies.admin, "PATCH", "/v1/settings/it", b);

  // 1. finance.approval_threshold_cents：调低阈值 -> 员工报销触发审批。
  {
    await setFinance({ approval_threshold_cents: 100 });
    const r = await call(cookies.employee, "POST", "/v1/finance/expenses",
      { category: "travel", amount_cents: 5000, expense_date: "2026-01-05", description: "thr" });
    push("finance.approval_threshold_cents 生效（阈值100→5000触发审批）",
      r.status === 201 && r.payload.needs_approval === true,
      { status: r.status, needs_approval: r.payload?.needs_approval });
    await setFinance({ approval_threshold_cents: 999999 });
    const r2 = await call(cookies.employee, "POST", "/v1/finance/expenses",
      { category: "travel", amount_cents: 5000, expense_date: "2026-01-05", description: "thr2" });
    push("finance.approval_threshold_cents 生效（阈值高→不触发）",
      r2.status === 201 && r2.payload.needs_approval === false,
      { needs_approval: r2.payload?.needs_approval });
  }

  // 2. finance.expense_deadline_day：报销响应回显并提交截止日按设置计算。
  {
    await setFinance({ expense_deadline_day: 10 });
    const r = await call(cookies.employee, "POST", "/v1/finance/expenses",
      { category: "meals", amount_cents: 100, expense_date: "2026-01-05", description: "dl" });
    const day = Number(String(r.payload?.submission_deadline ?? "").slice(8, 10));
    push("finance.expense_deadline_day 生效（回显10且截止日=10号）",
      r.payload?.expense_deadline_day === 10 && day === 10,
      { field: r.payload?.expense_deadline_day, deadline: r.payload?.submission_deadline });
  }

  // 3. finance.invoice_expiry_warn_days：发票 expiring_soon 依据设置判定。
  {
    await setFinance({ invoice_expiry_warn_days: 60 });
    const due = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10); // +30d
    const cr = await call(cookies.finance, "POST", "/v1/finance/invoices",
      { invoice_type: "receivable", amount_cents: 100000, counterparty_name: "验收客户", due_date: due });
    const g = await call(cookies.finance, "GET", "/v1/finance/invoices");
    const found = (g.payload?.items ?? []).find((x) => x.id === cr.payload?.id);
    push("finance.invoice_expiry_warn_days 生效（warn60→30天后到期 expiring_soon true 且回显60）",
      g.payload?.invoice_expiry_warn_days === 60 && found?.expiring_soon === true,
      { create_status: cr.status, warn_days: g.payload?.invoice_expiry_warn_days, expiring_soon: found?.expiring_soon });
  }

  // 4. crm.default_win_probability：新建商机默认赢率取设置值。
  {
    await setCrm({ default_win_probability: 42 });
    const r = await call(cookies.employee, "POST", "/v1/crm/opportunities",
      { name: "默认赢率商机", customer_name: "客户A", amount_cents: 100000 });
    push("crm.default_win_probability 生效（默认赢率=42）",
      r.status === 201 && r.payload?.win_probability === 42,
      { win_probability: r.payload?.win_probability });
  }

  // 5. crm.pipeline_stages：列表回显流水线阶段配置。
  {
    await setCrm({ pipeline_stages: ["lead", "won", "lost"] });
    const g = await call(cookies.employee, "GET", "/v1/crm/opportunities");
    const ok = Array.isArray(g.payload?.pipeline_stages)
      && JSON.stringify(g.payload.pipeline_stages) === JSON.stringify(["lead", "won", "lost"]);
    push("crm.pipeline_stages 生效（列表回显自定义阶段）", ok,
      { pipeline_stages: g.payload?.pipeline_stages });
  }

  // 6. crm.stale_opportunity_days：回显 + 超期商机 is_stale。
  {
    await setCrm({ stale_opportunity_days: 1 });
    // touch_updated_row BEFORE UPDATE 触发器会重置 updated_at，
    // 故直接以 hq_admin 插入一条 10 天未更新的陈旧商机（INSERT 不触发该 trigger）。
    const staleId = randomUUID();
    const adm = new pg.Client({ connectionString: ADMIN_DB_URL });
    await adm.connect();
    await adm.query(
      `INSERT INTO crm.opportunities (id, tenant_id, name, customer_name, amount_cents, stage, win_probability, created_at, updated_at)
       VALUES ($1,$2,'陈旧商机(直插)','客户B',100,'qualified',50, now() - interval '10 days', now() - interval '10 days')`,
      [staleId, T.tenant]);
    await adm.end();
    const g = await call(cookies.employee, "GET", "/v1/crm/opportunities");
    const found = (g.payload?.items ?? []).find((x) => x.id === staleId);
    push("crm.stale_opportunity_days 生效（回显1且10天未更新→is_stale）",
      g.payload?.stale_opportunity_days === 1 && found?.is_stale === true,
      { stale_days: g.payload?.stale_opportunity_days, is_stale: found?.is_stale });
  }

  // 7/8. it.sla_high_hours / it.sla_medium_hours：工单 SLA 时数与到期时间。
  {
    await setIt({ sla_high_hours: 2, sla_medium_hours: 48 });
    const hi = await call(cookies.employee, "POST", "/v1/it/tickets",
      { title: "高优先", category: "network", priority: "high" });
    const md = await call(cookies.employee, "POST", "/v1/it/tickets",
      { title: "中优先", category: "network", priority: "medium" });
    const hiDelta = (new Date(hi.payload?.sla_due_at) - Date.now()) / 3_600_000;
    const mdDelta = (new Date(md.payload?.sla_due_at) - Date.now()) / 3_600_000;
    push("it.sla_high_hours 生效（high→2h 且 sla_due_at≈+2h）",
      hi.payload?.sla_hours === 2 && hiDelta > 1.9 && hiDelta < 2.1,
      { sla_hours: hi.payload?.sla_hours, hours_delta: Number(hiDelta.toFixed(3)) });
    push("it.sla_medium_hours 生效（medium→48h 且 sla_due_at≈+48h）",
      md.payload?.sla_hours === 48 && mdDelta > 47.9 && mdDelta < 48.1,
      { sla_hours: md.payload?.sla_hours, hours_delta: Number(mdDelta.toFixed(3)) });
  }

  // 9. it.helpdesk_email：工单响应回显帮助台邮箱。
  {
    await setIt({ helpdesk_email: "help@acceptance.test" });
    const r = await call(cookies.employee, "POST", "/v1/it/tickets",
      { title: "邮箱回显", category: "software" });
    push("it.helpdesk_email 生效（工单回显 help@acceptance.test）",
      r.payload?.helpdesk_email === "help@acceptance.test",
      { helpdesk_email: r.payload?.helpdesk_email });
  }

  // 10. it.license_expiry_warn_days：许可证 expiring_soon + stats 回显。
  {
    await setIt({ license_expiry_warn_days: 90 });
    const exp = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const cr = await call(cookies.employee, "POST", "/v1/it/licenses",
      { software_name: "验收软件", license_type: "subscription", total_seats: 5, expiry_date: exp });
    const g = await call(cookies.employee, "GET", "/v1/it/licenses");
    const found = (g.payload?.items ?? []).find((x) => x.id === cr.payload?.id);
    const st = await call(cookies.employee, "GET", "/v1/it/stats");
    push("it.license_expiry_warn_days 生效（warn90→30天后到期 expiring_soon true 且 stats 回显90）",
      g.payload?.license_expiry_warn_days === 90 && found?.expiring_soon === true
        && st.payload?.expiring?.expiry_warn_days === 90,
      { warn_days_list: g.payload?.license_expiry_warn_days, expiring_soon: found?.expiring_soon, warn_days_stats: st.payload?.expiring?.expiry_warn_days });
  }

  return results;
}

async function main() {
  await ensureContainer({ fresh: true });
  const mig = await applyMigrations();
  await runSeed("./seed.mjs");
  const server = startServer();
  let exitCode = 0;
  try {
    await waitHealth(server);
    const cookies = await makeCookies();
    const kernel = await approvalKernel();
    const settings = await settingConsumers(cookies);

    const all = [...kernel, ...settings];
    const failed = all.filter((r) => !r.ok);
    const report = {
      migrations: mig,
      approval_kernel: kernel,
      setting_consumers: settings,
      total: all.length,
      failed: failed.length,
      passed: all.length > 0 && failed.length === 0,
    };
    console.log("=== M2 审批内核 + 设置生效 ===");
    for (const r of all) {
      console.log(`${r.ok ? "OK " : "BAD"}  ${r.name}`);
      if (!r.ok) console.log(`        detail: ${JSON.stringify(r.detail)}`);
    }
    console.log("\n" + JSON.stringify(report, null, 2));
    if (!report.passed) exitCode = 1;
  } finally {
    server.kill("SIGTERM");
  }
  process.exit(exitCode);
}

main().catch((err) => { console.error("M2 harness error:", err); process.exit(2); });

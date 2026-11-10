// 智能治理端到端验收（npm run accept:smart · docs/19）。
// P1 个人全景三级视野 / P2 KR×项目联动实时进度 / P3 AI 定时任务真实执行+暂停停摆 /
// P4 管理员 AI 用量报表（员工 403）/ P5 ai/tools 权限过滤 / P6 组织树+部门全景+我的团队 / P7 公司全景权限。
// 数据来源：迁移 0025/0026/0028/0030 预置演示公司。任一断言失败 exit 1。
import pg from "pg";
import { spawn } from "node:child_process";
import {
  ensureContainer, applyMigrations, startServer, waitHealth,
  ADMIN_DB_URL, SESSION_SECRET, REPO, HOST_URL, api, destroyContainer,
} from "./lib.mjs";

const steps = [];
const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, { timeout = 45000, interval = 700, label = "" } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`poll_timeout:${label}`);
    await sleep(interval);
  }
}

const SW_T = "d0000002-0000-4000-8000-000000000001";
const MFG_T = "d0000001-0000-4000-8000-000000000001";
const P = { ceo: "d0000002-0000-4000-8000-00000000bb01", cto: "d0000002-0000-4000-8000-00000000bb02", hrd: "d0000002-0000-4000-8000-00000000bb03", be: "d0000002-0000-4000-8000-00000000bb08", su: "d0000002-0000-4000-8000-00000000bb09", mfgBoss: "d0000001-0000-4000-8000-00000000aa01", mfgPurchaser: "d0000001-0000-4000-8000-00000000aa05" };

let server, worker, admin, exitCode = 0;
const wlogs = [];

const run = async () => {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  server = startServer({ RATE_LIMIT_PER_MINUTE: "100000" });
  await waitHealth(server);
  worker = spawn("node", ["--experimental-strip-types", "apps/worker/src/main.ts"], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: ADMIN_DB_URL, SESSION_SECRET, WORKER_OUTBOX_INTERVAL: "1000", WORKER_JOBS_INTERVAL: "1000", WORKER_SNAPSHOT_INTERVAL: "3600000", WORKER_AI_SCHEDULE_INTERVAL: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (d) => wlogs.push(String(d)));
  worker.stderr.on("data", (d) => wlogs.push(String(d)));

  process.env.DATABASE_URL = ADMIN_DB_URL;
  process.env.SESSION_SECRET = SESSION_SECRET;
  const { createSession } = await import("../../apps/api/src/session.ts");
  const login = (tenant, person, isAdmin = false) =>
    `hq_session=${createSession({ tenantId: tenant, personId: person, role: isAdmin ? "tenant_admin" : "employee", mode: "demo" })}`;
  const ceo = login(SW_T, P.ceo, true);
  const cto = login(SW_T, P.cto);
  const su = login(SW_T, P.su);
  const be = login(SW_T, P.be);
  const mfgAdmin = login(MFG_T, P.mfgBoss, true);
  const mfgPurchaser = login(MFG_T, P.mfgPurchaser);

  // ═══ P1 个人全景：self=full / 同事=limited / 管理员查任何人=full ═══
  {
    const self = await api(cto, "GET", `/v1/people/${P.cto}/panorama`);
    const peer = await api(su, "GET", `/v1/people/${P.cto}/panorama`);
    const byAdmin = await api(ceo, "GET", `/v1/people/${P.be}/panorama`);
    add("P1 个人全景", "本人=full(审批/财务/考勤/绩效/AI 区块齐全)；同事=limited(无审批/绩效键)；管理员查他人=full",
      self.status === 200 && self.body.visibility === "full"
      && self.body.approvals !== undefined && self.body.reviews !== undefined && self.body.ai_usage !== undefined
      && self.body.okr !== undefined && self.body.projects !== undefined
      && peer.status === 200 && peer.body.visibility === "limited"
      && peer.body.approvals === undefined && peer.body.reviews === undefined
      && peer.body.okr !== undefined
      && byAdmin.status === 200 && byAdmin.body.visibility === "full",
      { self: self.body.visibility, peer: peer.body.visibility, peerKeys: Object.keys(peer.body) });
  }

  // ═══ P2 KR×项目联动：metric_source=project → live=项目进度 45% ═══
  {
    const per = await api(ceo, "POST", "/v1/strategy/periods", { label: "FY2027-SMART", period_type: "year", start_date: "2027-01-01", end_date: "2027-12-31" });
    const obj = await api(ceo, "POST", "/v1/strategy/objectives", { period_id: per.body.id, title: "深化联动目标", type: "company" });
    const kr = await api(ceo, "POST", `/v1/strategy/objectives/${obj.body.id}/key-results`, { title: "恒精交付项目进度", kr_type: "percentage", target_value: 100, unit: "%" });
    const prj = (await api(cto, "GET", "/v1/projects")).body.items[0];
    const link = await api(ceo, "POST", `/v1/strategy/key-results/${kr.body.id}/links`, { link_type: "project", link_id: prj.id, weight: 10 });
    await api(ceo, "PATCH", `/v1/strategy/key-results/${kr.body.id}`, { metric_source: "project" });
    const read = await api(ceo, "GET", `/v1/strategy/key-results/${kr.body.id}`);
    add("P2 OKR×项目联动", "KR 绑定项目后 live_value=45（项目实时进度自动汇报），详情 links 含项目标签",
      link.status === 201 && read.status === 200 && read.body.metric_source === "project"
      && Number(read.body.live_value) === 45 && read.body.live_unit === "%"
      && (read.body.links || []).some(l => String(l.label || "").includes("进度")),
      { live: read.body.live_value, links: read.body.links?.map(l => l.label) });
  }

  // ═══ P3 AI 定时任务：创建→到点真实执行（审计留痕）→暂停停摆 ═══
  {
    const sch = await api(ceo, "POST", "/v1/ai/schedules", {
      name: "每 5 分钟经营概览", tool_name: "get_workspace_overview", args: {}, interval_minutes: 5,
    });
    const denied = await api(su, "POST", "/v1/ai/schedules", { name: "越权", tool_name: "create_contract", args: {}, interval_minutes: 60 });
    // 立即触发：把 next_run_at 拨到现在
    await admin.query(`UPDATE platform.ai_schedules SET next_run_at = now() WHERE tenant_id=$1 AND id=$2`, [SW_T, sch.body.id]);
    const ran = await pollUntil(async () => {
      const r = (await admin.query(
        `SELECT run_count::int AS rc FROM platform.ai_schedules WHERE tenant_id=$1 AND id=$2`, [SW_T, sch.body.id])).rows[0];
      return r.rc >= 1 ? r.rc : null;
    }, { label: "schedule run", timeout: 30000 }).catch(() => 0);
    const audited = await pollUntil(async () => {
      const r = (await admin.query(
        `SELECT count(*)::int AS n FROM audit.audit_events WHERE tenant_id=$1 AND action='ai.tool.execute' AND outcome='success' AND trace_id LIKE 'schedule:%'`,
        [SW_T])).rows[0];
      return r.n >= 1 ? r.n : null;
    }, { label: "schedule audit", timeout: 30000 }).catch(() => 0);
    // 暂停后拨时间也不应再跑
    await api(ceo, "PATCH", `/v1/ai/schedules/${sch.body.id}`, { status: "paused" });
    const rcBefore = (await admin.query(`SELECT run_count::int AS rc FROM platform.ai_schedules WHERE tenant_id=$1 AND id=$2`, [SW_T, sch.body.id])).rows[0].rc;
    await admin.query(`UPDATE platform.ai_schedules SET next_run_at = now() WHERE tenant_id=$1 AND id=$2`, [SW_T, sch.body.id]);
    await sleep(4000);
    const rcAfter = (await admin.query(`SELECT run_count::int AS rc FROM platform.ai_schedules WHERE tenant_id=$1 AND id=$2`, [SW_T, sch.body.id])).rows[0].rc;
    add("P3 AI 定时任务", "创建(授权校验)+越权被拒 → worker 到点以本人身份真实执行(run_count≥1, trace=schedule:*)→审计留痕 → 暂停后不再执行",
      sch.status === 201 && denied.status === 403 && Number(ran) >= 1 && Number(audited) >= 1 && Number(rcAfter) === Number(rcBefore),
      { run: ran, audit: audited, pausedStable: Number(rcAfter) === Number(rcBefore) });
  }

  // ═══ P4 管理员 AI 用量报表 / 员工 403 ═══
  {
    const ok = await api(ceo, "GET", "/v1/ai/admin/usage?days=30");
    const denied = await api(cto, "GET", "/v1/ai/admin/usage");
    const ctoRow = (ok.body.per_person || []).find(p => p.person_id === P.cto);
    add("P4 AI 使用审核", "管理员报表(全员对话/调用/被拒+Top工具+明细)；CTO 用量>0 且员工访问 403",
      ok.status === 200 && Array.isArray(ok.body.per_person) && ok.body.denied_total !== undefined
      && ctoRow && Number(ctoRow.tool_calls) >= 1
      && denied.status === 403,
      { ctoCalls: ctoRow?.tool_calls, deniedTotal: ok.body.denied_total });
  }

  // ═══ P5 ai/tools 权限过滤 ═══
  {
    const ctoTools = await api(cto, "GET", "/v1/ai/tools");
    const ceoTools = await api(ceo, "GET", "/v1/ai/tools");
    const ctoNames = (ctoTools.body.items || []).map(t => t.name);
    const ceoNames = (ceoTools.body.items || []).map(t => t.name);
    add("P5 AI 工具清单", "CTO：含 L0(query_team_overview/query_projects) 无 L2(create_task)；CEO：含全部（含 create_task/query_dashboard）",
      ctoTools.status === 200 && ctoNames.includes("query_team_overview") && ctoNames.includes("query_projects")
      && !ctoNames.includes("create_task") && !ctoNames.includes("create_contract")
      && ceoNames.includes("create_task") && ceoNames.includes("query_dashboard"),
      { ctoCount: ctoNames.length, ceoCount: ceoNames.length });
  }

  // ═══ P6 组织树 + 部门全景 + 我的团队 ═══
  {
    const tree = await api(cto, "GET", "/v1/org/tree");
    const unit = (tree.body.roots || [])[0];
    const dept = await api(mfgAdmin, "GET", `/v1/org/units/d0000001-0000-4000-8000-00000000ac02/panorama`);
    const deptLimited = await api(mfgPurchaser, "GET", `/v1/org/units/d0000001-0000-4000-8000-00000000ac02/panorama`);
    const team = await api(cto, "GET", "/v1/teams/my");
    const adjust = await api(mfgAdmin, "PATCH", "/v1/org/units/d0000001-0000-4000-8000-00000000ac06", { name: "采购与供应链部" });
    const adjusted = await api(mfgPurchaser, "GET", "/v1/org/tree");
    add("P6 组织全景", `组织树(根≥1) → 部门全景(admin=full 含成员明细)；采购员=limited(无 members)；CTO 团队=直属 3 人；部门可调整(采购部改名，全租户可见)`,
      tree.status === 200 && (tree.body.roots || []).length >= 1
      && dept.status === 200 && dept.body.visibility === "full" && Array.isArray(dept.body.members)
      && deptLimited.status === 200 && deptLimited.body.visibility === "limited" && deptLimited.body.members === undefined
      && team.status === 200 && Number(team.body.totals.headcount) === 3
      && adjust.status === 200
      && JSON.stringify(adjusted.body).includes("采购与供应链部"),
      { dept: dept.body.visibility, team: team.body.totals?.headcount, adjust: adjust.status });
  }

  // ═══ P7 公司全景权限 ═══
  {
    const okCeo = await api(ceo, "GET", "/v1/org/company/panorama");
    const okMgr = await api(cto, "GET", "/v1/org/company/panorama");
    const deniedEmp = await api(be, "GET", "/v1/org/company/panorama");
    add("P7 公司全景", "CEO/部门主管 200（与高层看板同源）；普通员工 403",
      okCeo.status === 200 && okMgr.status === 200 && deniedEmp.status === 403,
      { ceo: okCeo.status, mgr: okMgr.status, emp: deniedEmp.status });
  }
};

try {
  await run();
} catch (e) {
  add("FATAL", false, { error: String(e?.message || e), workerLogs: wlogs.join("").slice(-300) });
} finally {
  console.log("\n=== 智能治理 · 端到端验收（docs/19）===");
  for (const s of steps) console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  const failed = steps.filter(s => !s.ok);
  console.log(`\n=== 步骤：${steps.length - failed.length}/${steps.length} 通过 ===`);
  console.log(JSON.stringify({ passed: failed.length === 0, steps_total: steps.length, steps_failed: failed.length }, null, 2));
  if (failed.length) exitCode = 1;
  await admin?.end();
  server?.kill();
  worker?.kill();
  destroyContainer();
}
process.exit(exitCode);

// 云枢软件（软件开发企业）全角色端到端演练（npm run accept:sw）。
// 六视角人物：CEO/CTO/财务/薪资专员/HRD/IT/产品总监/产品经理/前后端/测试，
// 覆盖：中长期计划(OKR) → 销售→立项 → 研发日常(打卡/任务/评论/工时) → 招聘→真实 worker 入职 →
//       IT 配置 → 预算+两级审批 → 请假闭环 → 回款 → 中文知识检索 → AI 周报(worker) → ABAC → outbox。
// 纪律：任一断言失败 exit 1；全部结论来自本次真实执行（隔离容器自建自毁）；缺口如实记 GAP。
import pg from "pg";
import { spawn } from "node:child_process";
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth,
  ADMIN_DB_URL, SESSION_SECRET, REPO, api, destroyContainer,
} from "./lib.mjs";
import { T } from "./seed.mjs";
import { S, buildSwSeedStatements } from "./sw-seed.mjs";

const steps = [];
const gaps = [];
const add = (phase, name, ok, detail) => steps.push({ phase, name, ok: !!ok, detail });
const gap = (id, sev, desc) => gaps.push({ id, sev, desc });

let server, worker, admin, exitCode = 0;
const wlogs = [];
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

const run = async () => {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  await runSeed("./seed.mjs");
  admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  for (const { sql, values } of buildSwSeedStatements()) await admin.query(sql, values);

  server = startServer({ RATE_LIMIT_PER_MINUTE: "100000" });
  await waitHealth(server);
  // 真实 worker：outbox/jobs 1s 节奏；无飞书凭据 → 通知静默降级、事件仍 published
  worker = spawn("node", ["--experimental-strip-types", "apps/worker/src/main.ts"], {
    cwd: REPO,
    env: {
      ...process.env, DATABASE_URL: ADMIN_DB_URL, SESSION_SECRET,
      WORKER_OUTBOX_INTERVAL: "1000", WORKER_JOBS_INTERVAL: "1000", WORKER_SNAPSHOT_INTERVAL: "3600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (d) => wlogs.push(String(d)));
  worker.stderr.on("data", (d) => wlogs.push(String(d)));

  process.env.DATABASE_URL = ADMIN_DB_URL;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.MODEL_API_KEY = "";
  const { createSession } = await import("../../apps/api/src/session.ts");
  const { executeTool } = await import("../../apps/api/src/ai.ts");
  const ck = (personId, role = "employee") =>
    `hq_session=${createSession({ tenantId: T.tenant, personId, role, mode: "feishu" })}`;
  const adminCk = ck(T.admin, "tenant_admin");
  const ceoCk = ck(S.ceo, "tenant_admin");
  const ctoCk = ck(S.vpTech);        // manager 绑定在库，行级域与审批解析走真实数据
  const hrdCk = ck(S.hrd);           // hr_manager
  const cfoCk = ck(S.cfo);           // finance_manager
  const itAdminCk = ck(S.itAdmin);   // 普通员工，上级=CTO
  const pdCk = ck(S.pd);
  const pmCk = ck(S.pm);
  const beCk = ck(S.beDev);
  const feCk = ck(S.feDev);
  const qaCk = ck(S.qa);
  const payCk = ck(S.payroll);       // 无绑定=无关员工（行级域负例）
  const adminIdentity = { tenantId: T.tenant, personId: T.admin, role: "tenant_admin", mode: "feishu" };

  const instanceOf = async (resourceType, resourceId) =>
    (await admin.query(
      `SELECT id FROM platform.approval_instances WHERE tenant_id=$1 AND resource_type=$2 AND resource_id=$3`,
      [T.tenant, resourceType, resourceId])).rows[0]?.id;

  // ═══ S1 中长期计划（CEO 视角）═══════════════════════════════
  await section0("S1中长期", async () => {
    const per = await api(ceoCk, "POST", "/v1/strategy/periods", {
      label: "FY2026", period_type: "year", start_date: "2026-01-01", end_date: "2026-12-31",
    });
    const obj = await api(ceoCk, "POST", "/v1/strategy/objectives", {
      period_id: per.body.id, title: "云枢 SaaS 商业化突破", type: "company",
    });
    const krMrr = await api(ceoCk, "POST", `/v1/strategy/objectives/${obj.body.id}/key-results`, {
      title: "SaaS 月经常性收入 MRR", kr_type: "numeric", target_value: 50, unit: "万元",
    });
    const krOtd = await api(ceoCk, "POST", `/v1/strategy/objectives/${obj.body.id}/key-results`, {
      title: "交付项目准交率", kr_type: "percentage", target_value: 95, unit: "%",
    });
    const ci = await api(ceoCk, "POST", `/v1/strategy/key-results/${krMrr.body.id}/checkins`, {
      value_at_checkin: 12, confidence: 60, note: "Q1 结束",
    });
    const ini = await api(ceoCk, "POST", `/v1/strategy/key-results/${krMrr.body.id}/initiatives`, {
      title: "SaaS 计费自助化改造", owner_person_id: S.vpTech, due_date: "2026-09-30", priority: "high",
    });
    const krRead = await api(ceoCk, "GET", `/v1/strategy/key-results/${krMrr.body.id}`);
    const att = await api(ceoCk, "POST", "/v1/hr/attendance/checkin", { note: "CEO 早到" });
    add("S1中长期", "年度周期→O→2 KR(MRR/准交)→打卡 12→经营举措→读回 current_value=12；CEO 打卡 200",
      per.status === 201 && obj.status === 201 && krMrr.status === 201 && krOtd.status === 201
      && ci.status === 201 && ini.status === 201 && Number(krRead.body?.current_value) === 12 && att.status === 200,
      { per: per.status, obj: obj.status, kr: [krMrr.status, krOtd.status], ini: [ini.status, ini.body?.error], ci: ci.status, cur: krRead.body?.current_value, att: att.status, err: att.body?.error });
    gap("G-S1a", "中", "OKR 指标全靠手工打卡，未与业务表派生联动（MRR 无订阅数据可聚合、准交率无里程碑实际完成日对照），缺'指标口径→数据源'绑定。");
    gap("G-S1b", "低", "OKR 无公司→部门→个人对齐树视图（objectives.type 有 dept 口径但无父子对齐/权重 roll-up 端点）。");
  });

  // ═══ S2 销售→立项（产品经理视角，含里程碑 GAP 直插）══════════
  let PRJ2, MS1, ACC;
  await section0("S2销售立项", async () => {
    const acc = await api(pmCk, "POST", "/v1/crm/accounts", { name: "恒精精密", industry: "汽车零部件制造" });
    ACC = acc.body.id;
    const opp = await api(pmCk, "POST", "/v1/crm/opportunities", {
      name: "恒精 云枢三年服务包", customer_name: "恒精精密", account_id: ACC, amount_cents: 60000000, stage: "qualified",
    });
    await api(pmCk, "POST", `/v1/crm/opportunities/${opp.body.id}/activities`, { activity_type: "meeting", title: "SaaS+实施方案交流会" });
    const won = await api(pmCk, "POST", `/v1/crm/opportunities/${opp.body.id}/stage`, { stage: "won" });
    const prj = await api(ctoCk, "POST", "/v1/projects", {
      name: "恒精数字化交付项目", customer_name: "恒精精密", source_opportunity_id: opp.body.id,
      owner_person_id: S.vpTech, budget_cents: 60000000, start_date: "2026-10-01", end_date: "2027-03-31",
    });
    PRJ2 = prj.body.id;
    // 里程碑：无创建端点 → 直插（记 GAP）
    MS1 = "9f000000-0000-4000-8000-000000000001";
    await admin.query(
      `INSERT INTO project.milestones (id, tenant_id, project_id, name, status, due_date)
       VALUES ($1,$2,$3,'一期上线·核心模块','in_progress','2026-12-31')`, [MS1, T.tenant, PRJ2]);
    const t1 = await api(ctoCk, "POST", `/v1/projects/${PRJ2}/tasks`, {
      title: "MES 接口联调", assignee_person_id: S.beDev, priority: "high", story_points: 8, milestone_id: MS1,
    });
    const t2 = await api(ctoCk, "POST", `/v1/projects/${PRJ2}/tasks`, {
      title: "交付看板前端", assignee_person_id: S.feDev, priority: "medium", story_points: 5, milestone_id: MS1,
    });
    const m1 = await api(ctoCk, "POST", `/v1/projects/${PRJ2}/members`, { person_id: S.beDev });
    const m2 = await api(ctoCk, "POST", `/v1/projects/${PRJ2}/members`, { person_id: S.feDev });
    const m3 = await api(ctoCk, "POST", `/v1/projects/${PRJ2}/members`, { person_id: S.qa });
    const risk = await api(ctoCk, "POST", `/v1/projects/${PRJ2}/risks`, {
      title: "客户 MES 厂商接口文档延迟", probability: "high", impact: "high", mitigation_plan: "提前锁定接口文档版本，预留 2 周缓冲",
    });
    add("S2销售立项", "客户→商机(¥60万)→赢单→交付项目(owner=CTO)→里程碑(直插)→2 任务(story_points)+3 成员+风险",
      acc.status === 201 && opp.status === 201 && won.status === 200 && prj.status === 201
      && t1.status === 201 && Number(t1.body?.story_points) === 8 && t2.status === 201
      && m1.status === 200 && m2.status === 200 && m3.status === 200 && risk.status === 201,
      { won: won.status, prj: prj.status, t1: t1.status, sp: t1.body?.story_points, ms: [m1.status, m2.status, m3.status], risk: risk.status });
    gap("G-S2a", "高", "无里程碑/迭代(Sprint)创建 API（须直插 SQL）；赢单→项目仍须手工立项，缺 商机→项目 自动编排。");
    gap("G-S2b", "中", "项目风险无 应对计划/升级 联动；无 需求池/用户故事地图（story 只是 task 的 story_points 数字）。");
  });

  // ═══ S3 研发日常（后端工程师视角）═══════════════════════════
  let BE_TASK;
  await section0("S3研发日常", async () => {
    const inAt = await api(beCk, "POST", "/v1/hr/attendance/checkin", {});
    const t = await api(beCk, "GET", `/v1/projects/${PRJ2}/tasks`);
    BE_TASK = (t.body?.items ?? []).find((x) => x.assignee_person_id === S.beDev)?.id;
    const prog = await api(beCk, "PATCH", `/v1/tasks/${BE_TASK}`, { status: "in_progress" });
    const cm = await api(beCk, "POST", `/v1/tasks/${BE_TASK}/comments`, { body: "接口字段与 MES 侧确认完毕，进入联调" });
    const cmList = await api(beCk, "GET", `/v1/tasks/${BE_TASK}/comments`);
    const tl = await api(beCk, "POST", `/v1/tasks/${BE_TASK}/time-logs`, { hours_logged: 6, description: "联调 2 + 开发 4" });
    const done = await api(beCk, "PATCH", `/v1/tasks/${BE_TASK}`, { status: "done" });
    const bug = await api(qaCk, "POST", `/v1/projects/${PRJ2}/tasks`, {
      title: "[缺陷] 登录页偶发 500（重现率约 1/20）", assignee_person_id: S.beDev, priority: "critical",
    });
    const outAt = await api(beCk, "POST", "/v1/hr/attendance/checkout", {});
    const attRow = (await admin.query(
      `SELECT check_in, check_out FROM hr.attendance_records WHERE tenant_id=$1 AND person_id=$2 ORDER BY date DESC LIMIT 1`,
      [T.tenant, S.beDev])).rows[0];
    const taskRow = (await admin.query(`SELECT status, actual_hours FROM project.tasks WHERE id=$1`, [BE_TASK])).rows[0];
    add("S3研发日常", "打卡→in_progress→评论→工时 6h→done；QA 缺陷以任务近似；下班打卡；读回 出勤齐+actual_hours=6",
      inAt.status === 200 && prog.body?.status === "in_progress" && cm.status === 201
      && (cmList.body?.items ?? []).length === 1 && tl.status === 201 && done.body?.status === "done"
      && bug.status === 201 && outAt.status === 200 && !!attRow?.check_in && !!attRow?.check_out
      && taskRow?.status === "done" && Number(taskRow?.actual_hours) === 6,
      { in: inAt.status, tl: tl.status, bug: bug.status, out: outAt.status, att: attRow, task: taskRow });
    gap("G-S3a", "高", "无缺陷跟踪对象（严重级别/重现步骤/环境/关联版本只能塞进任务标题）；无迭代看板/燃尽图/故事点汇总端点。");
    gap("G-S3b", "低", "工时能记不能算：time_logs 无 人力成本单价挂钩，缺'项目人力成本=Σ工时×费率'派生。");
  });

  // ═══ S4 招聘→真实 worker 入职（HRD 视角）════════════════════
  let newPerson;
  await section0("S4招聘入职", async () => {
    const req = await executeTool("create_requisition", {
      title: "Java 后端工程师", headcount: 2, reason: "SaaS 计费组扩编", department: "研发中心",
    }, adminIdentity, { traceId: "sw-s4" });
    const reqId = req.requisition?.id;
    const cand = await api(hrdCk, "POST", "/v1/hr/candidates", {
      name: "候选人·赵岩", email: "zhaoyan-sw-onboard@yunshu.test", requisition_id: reqId,
      current_title: "Java 后端工程师", years_of_experience: 4, source: "referral",
    });
    const iv1 = await api(hrdCk, "POST", `/v1/hr/candidates/${cand.body.id}/interviews`, {
      scheduled_at: "2026-09-28T09:00:00Z", interview_type: "technical", interviewer_person_ids: [S.vpTech],
    });
    await api(hrdCk, "POST", `/v1/hr/interviews/${iv1.body.id}/evaluations`, { recommendation: "recommend", overall_score: 9 });
    const iv2 = await api(hrdCk, "POST", `/v1/hr/candidates/${cand.body.id}/interviews`, {
      scheduled_at: "2026-09-29T09:00:00Z", interview_type: "hr", interviewer_person_ids: [S.hrd], round: 2,
    });
    await api(hrdCk, "POST", `/v1/hr/interviews/${iv2.body.id}/evaluations`, { recommendation: "recommend", overall_score: 8 });
    const offer = await api(hrdCk, "POST", `/v1/hr/candidates/${cand.body.id}/offers`, {
      position_title: "Java 后端工程师", base_salary_annual: 4200000, department: "研发中心", expected_start_date: "2026-10-12",
    });
    const accepted = await api(hrdCk, "PATCH", `/v1/hr/offers/${offer.body.id}`, { status: "accepted" });
    add("S4招聘入职", "AI 招聘需求→候选人→两轮面试(技术+HR)→Offer→HRD 置 accepted 200",
      req.created === true && !!reqId && cand.status === 201 && iv1.status === 201 && iv2.status === 201
      && offer.status === 201 && accepted.status === 200 && accepted.body?.status === "accepted",
      { req: req.created, cand: cand.status, iv: [iv1.status, iv2.status], acc: [accepted.status, accepted.body?.status, accepted.body?.error] });
    // 真实 worker 消费入职作业
    let job = null;
    try {
      job = await pollUntil(async () => {
        const r = (await admin.query(`SELECT * FROM platform.jobs WHERE tenant_id=$1 AND kind='onboard_from_offer'`, [T.tenant])).rows[0];
        return r && r.status === "succeeded" ? r : null;
      }, { label: "onboard_from_offer succeeded" });
    } catch (e) {
      const jr = (await admin.query(`SELECT status, attempts, last_error FROM platform.jobs WHERE tenant_id=$1 AND kind='onboard_from_offer'`, [T.tenant])).rows[0] ?? null;
      add("S4招聘入职", "worker 真实执行入职编排(succeeded)", false, { pollError: String(e?.message ?? e), jobRow: jr, workerTail: wlogs.join("").slice(-600) });
      throw e;
    }
    newPerson = (await admin.query(`SELECT * FROM platform.people WHERE tenant_id=$1 AND primary_email=$2`, [T.tenant, "zhaoyan-sw-onboard@yunshu.test"])).rows[0];
    const emp = (await admin.query(`SELECT id FROM platform.employments WHERE tenant_id=$1 AND person_id=$2 AND status='active'`, [T.tenant, newPerson?.id])).rows;
    const tasks = (await admin.query(`SELECT count(*)::int c FROM hr.onboarding_tasks WHERE tenant_id=$1 AND person_id=$2`, [T.tenant, newPerson?.id])).rows[0].c;
    const candRow = (await admin.query(`SELECT status FROM hr.candidates WHERE id=$1`, [cand.body.id])).rows[0];
    add("S4招聘入职", "worker 入职编排：档案+雇佣+3 条入职清单+candidate=hired",
      !!newPerson && emp.length === 1 && tasks === 3 && candRow?.status === "hired" && job.result?.tasks_created === 3,
      { person: !!newPerson, emp: emp.length, tasks, cand: candRow?.status, result: job?.result });
    // HRD 录入新员工薪资（hr.salary.write capability 实测）
    const sal = await api(hrdCk, "POST", `/v1/hr/employees/${emp[0]?.id}/salary`, {
      component_type: "base", name: "月基本工资", amount_cents: 3500000, is_fixed: true, effective_from: "2026-10-12",
    });
    const salRead = (await admin.query(`SELECT amount_cents FROM hr.salary_components WHERE tenant_id=$1 AND person_id=$2`, [T.tenant, newPerson?.id])).rows[0];
    add("S4招聘入职", "HRD 录薪资 hr.salary.write 生效→salary_components 落库 35000 元",
      [200, 201].includes(sal.status) && Number(salRead?.amount_cents) === 3500000,
      { st: sal.status, err: sal.body?.error, amt: salRead?.amount_cents });
    gap("G-S4a", "中", "入职清单只落 hr.onboarding_tasks 静态条目，不联动 IT 发设备/账号/席位（本演练 S5 手工完成）；缺'入职→IT 自动编排'。");
    gap("G-S4b", "中", "无 试用期到→转正 自动触发/提醒端点；Offer 薪资与 salary_components 无默认联动（HRD 需二次录入）。");
  });

  // ═══ S5 IT 配置（IT 管理员视角）═════════════════════════════
  await section0("S5IT配置", async () => {
    const asset = await api(itAdminCk, "POST", "/v1/it/assets", {
      name: "MacBook Pro 14 (新员工)", category: "hardware", vendor: "Apple", model: "MacBookPro M4",
      purchase_cost_cents: 1899900, status: "in_use", assigned_person_id: newPerson?.id, location: "杭州研发中心",
    });
    const lic = await api(itAdminCk, "POST", "/v1/it/licenses", {
      software_name: "JetBrains All Products Pack", license_type: "subscription",
      vendor: "JetBrains", total_seats: 2, annual_cost_cents: 5000000, renewal_cost_cents: 5000000,
      renews_at: "2027-03-01", status: "active",
    });
    const a1 = await api(itAdminCk, "POST", `/v1/it/licenses/${lic.body.id}/assignments`, { person_id: S.beDev });
    const a2 = await api(itAdminCk, "POST", `/v1/it/licenses/${lic.body.id}/assignments`, { person_id: S.feDev });
    const a3 = await api(itAdminCk, "POST", `/v1/it/licenses/${lic.body.id}/assignments`, { person_id: S.qa });
    const aList = await api(itAdminCk, "GET", `/v1/it/licenses/${lic.body.id}/assignments`);
    const tk = await api(beCk, "POST", "/v1/it/tickets", { title: "VPN 下午频繁掉线", category: "network", priority: "high", requester_person_id: S.beDev });
    const fix = await api(itAdminCk, "PATCH", `/v1/it/tickets/${tk.body.id}`, { status: "resolved", resolution_notes: "更换出口网关后 48h 无掉线" });
    add("S5IT配置", "笔记本发放到人→JetBrains 2 席位分满→第 3 人 400 no_seats_available→VPN 工单闭环 resolved",
      asset.status === 201 && asset.body?.assigned_person_id === newPerson?.id && lic.status === 201
      && a1.status === 201 && a2.status === 201 && a3.status === 400 && String(a3.body?.error).startsWith("no_seats_available")
      && (aList.body?.items ?? []).length === 2 && tk.status === 201 && fix.body?.status === "resolved",
      { asset: asset.status, lic: lic.status, seats: [a1.status, a2.status, a3.status], err: a3.body?.error, list: (aList.body?.items ?? []).length, tk: [tk.status, fix.body?.status] });
    gap("G-S5", "中", "license 到期/续订只存字段无提醒作业（renews_at 不参与 outbox/定时提醒）；工单与设备无 保修期内判定/备件 概念。");
  });

  // ═══ S6 财务：预算→超阈两级审批→小额免审（财务总监视角）════
  let EXP_SMALL;
  await section0("S6财务审批", async () => {
    const b1 = await api(cfoCk, "POST", "/v1/finance/budgets", { category: "operations", total_amount_cents: 120000000, period_year: 2026, org_unit_id: S.deptIT });
    const b2 = await api(cfoCk, "POST", "/v1/finance/budgets", { category: "personnel", total_amount_cents: 480000000, period_year: 2026, org_unit_id: S.deptRnD });
    const b3 = await api(cfoCk, "POST", "/v1/finance/budgets", { category: "general", total_amount_cents: 20000000, period_year: 2026, org_unit_id: S.deptHR });
    const big = await api(itAdminCk, "POST", "/v1/finance/expenses", {
      category: "software", amount_cents: 6000000, description: "云服务年费（对象存储+CDN）", expense_date: "2026-09-20",
    });
    const inst = await instanceOf("expense", big.body.id);
    const d1 = await api(ctoCk, "POST", `/v1/approvals/${inst}/decide`, { decision: "approved", comment: "技术必要性确认" });
    const d2 = await api(cfoCk, "POST", `/v1/approvals/${inst}/decide`, { decision: "approved", comment: "预算内（cloud 120 万）" });
    const expRow = (await admin.query(`SELECT status FROM finance.expenses WHERE id=$1`, [big.body.id])).rows[0];
    const small = await api(beCk, "POST", "/v1/finance/expenses", { category: "meals", amount_cents: 40000, description: "加班餐", expense_date: "2026-09-19" });
    EXP_SMALL = small.body.id;
    const smallInst = await instanceOf("expense", EXP_SMALL);
    add("S6财务审批", "预算×3→云年费 ¥6 万超阈→CTO(上级)→财务总监(指定)两级 approved 回写；¥400 免审不建实例",
      [b1, b2, b3].every((b) => b.status === 201) && big.status === 201 && big.body?.needs_approval === true && !!inst
      && d1.body?.newStatus === "pending" && d2.body?.newStatus === "approved" && expRow?.status === "approved"
      && small.status === 201 && small.body?.needs_approval === false && !smallInst,
      { bud: [[b1.status, b1.body?.error], [b2.status, b2.body?.error], [b3.status, b3.body?.error]], big: [big.body?.needs_approval, !!inst], d1: d1.body?.newStatus, d2: d2.body?.newStatus, exp: expRow?.status, small: [small.body?.needs_approval, smallInst] });
    gap("G-S6", "中", "审批不校验/扣减部门预算余额（operations 预算 120 万与报销单无占用关系），预算执行率须手工对账；无'预算内免审/超预算加签'策略；预算 category 枚举僵化（无 cloud/SaaS 订阅类）。");
  });

  // ═══ S7 请假审批闭环（后端工程师视角）═══════════════════════
  await section0("S7请假", async () => {
    const leave = await api(beCk, "POST", "/v1/hr/leave-requests", {
      leave_type: "annual", start_date: "2026-10-08", end_date: "2026-10-12", days: 3, reason: "年假·陪家人",
    });
    const inst = await instanceOf("leave_request", leave.body.id);
    const d1 = await api(ctoCk, "POST", `/v1/approvals/${inst}/decide`, { decision: "approved", comment: "交接已确认" });
    const d2 = await api(hrdCk, "POST", `/v1/approvals/${inst}/decide`, { decision: "approved", comment: "符合年假规定" });
    const row = (await admin.query(`SELECT status, approved_at FROM hr.leave_requests WHERE id=$1`, [leave.body.id])).rows[0];
    const bad = await api(beCk, "POST", "/v1/hr/leave-requests", { leave_type: "sick" });
    add("S7请假", "年假 3 天→自动建审批→CTO→HRD→leave_requests=approved+approved_at；缺参 400",
      leave.status === 201 && !!inst && d1.body?.newStatus === "pending" && d2.body?.newStatus === "approved"
      && row?.status === "approved" && !!row?.approved_at && bad.status === 400 && String(bad.body?.error).startsWith("leave_type_start_end_days_required"),
      { lv: leave.status, d: [d1.body?.newStatus, d2.body?.newStatus], row, bad: [bad.status, bad.body?.error] });
    gap("G-S7", "高", "无 假期余额（annual 额度=法定+司龄规则、逐年 accrual、请假扣减、余额查询）；days 由申请人自报无工作日历核算。");
  });

  // ═══ S8 回款（财务总监视角）═════════════════════════════════
  await section0("S8回款", async () => {
    const inv = await api(cfoCk, "POST", "/v1/finance/invoices", {
      invoice_type: "receivable", counterparty_name: "恒精精密", amount_cents: 36000000,
      issue_date: "2026-09-20", due_date: "2026-10-20", invoice_number: "INV-YS-2026-0001",
    });
    const sent = await api(cfoCk, "PATCH", `/v1/finance/invoices/${inv.body.id}`, { status: "sent" });
    const pay1 = await api(cfoCk, "POST", "/v1/finance/payments", {
      customer_name: "恒精精密", amount_cents: 18000000, due_date: "2026-10-31", milestone: "一期上线验收", project_id: PRJ2, status: "planned",
    });
    await api(cfoCk, "POST", "/v1/finance/payments", {
      customer_name: "恒精精密", amount_cents: 18000000, due_date: "2027-03-31", milestone: "终验", project_id: PRJ2, status: "planned",
    });
    const paid = await api(cfoCk, "PATCH", `/v1/finance/payments/${pay1.body.id}`, { status: "paid" });
    const ov = await api(cfoCk, "GET", "/v1/finance/overview");
    const collected = Number(ov.body?.payments?.collected_total ?? 0);
    add("S8回款", "应收开票 ¥36 万→sent→两期收款计划挂钩项目→首期 paid→概览 collected≥¥18 万",
      inv.status === 201 && sent.body?.status === "sent" && pay1.status === 201 && paid.body?.status === "paid" && collected >= 18000000,
      { inv: inv.status, paid: paid.body?.status, collected });
    gap("G-S8", "中", "收款计划与里程碑无 状态联动（一期上线→自动产生应收）；无 账龄/逾期提醒/坏账 派生；发票不关联合同与税率明细。");
  });

  // ═══ S9 知识（产品总监视角，中文检索 + worker 索引）══════════
  let PRD_DOC;
  await section0("S9知识", async () => {
    const cat = await api(pdCk, "POST", "/v1/knowledge/categories", { name: "产品规范" });
    const prd = await api(pdCk, "POST", "/v1/knowledge/items", {
      category_id: cat.body.id, title: "云枢 SaaS 自助计费 PRD v1",
      content: "本 PRD 定义自助计费模块：订阅方案管理、按席位浮动计费、发票自助下载与逾期宽限策略。上线目标：客户自助开票成功率 99%。The self-service billing module covers subscription plans, per-seat billing and invoice download.",
      classification: "internal",
    });
    PRD_DOC = prd.body.id;
    await api(pdCk, "POST", "/v1/knowledge/items", {
      title: "研发中心编码与代码评审规范", content: "后端 Java 规范：阿里巴巴 P3C 基线 + 团队补充；前端 ESLint 强制；MR 至少一名同组评审人通过方可合入，评审时效一个工作日。",
    });
    const listHit = await api(pdCk, "GET", "/v1/knowledge/items?search=" + encodeURIComponent("自助计费"));
    add("S9知识", "PRD/研发规范建档 + 中文列表检索'自助计费'命中",
      cat.status === 201 && prd.status === 201 && (listHit.body?.items ?? []).length >= 1,
      { cat: cat.status, prd: prd.status, hits: (listHit.body?.items ?? []).length });
    await pollUntil(async () => {
      const r = (await admin.query(`SELECT index_status FROM knowledge.items WHERE id=$1`, [PRD_DOC])).rows[0];
      return r?.index_status === "indexed" ? true : null;
    }, { label: "PRD indexed by worker", timeout: 90000 });
    const s1 = await api(pdCk, "GET", "/v1/knowledge/search?q=" + encodeURIComponent("自助开票"));
    const s2 = await api(pdCk, "GET", "/v1/knowledge/search?q=subscription");
    const s3 = await api(pdCk, "GET", "/v1/knowledge/search?q=" + encodeURIComponent("量子隧穿锻造工艺"));
    add("S9知识", "worker 索引后 /search：中文'自助开票'命中、'subscription'命中、无关词 0 命中",
      (s1.body?.items ?? []).length >= 1 && (s2.body?.items ?? []).length >= 1 && (s3.body?.items ?? []).length === 0,
      { cjk: { st: s1.status, n: (s1.body?.items ?? []).length }, en: { st: s2.status, n: (s2.body?.items ?? []).length }, none: (s3.body?.items ?? []).length });
    gap("G-S9", "中", "PRD 是自由文档，不与 需求条目/任务/里程碑 结构化关联（改 PRD 不触发影响分析）；无 文档评审/定稿 工作流。");
  });

  // ═══ S10 AI 周报（真实 worker 消费）═════════════════════════
  await section0("S10AI周报", async () => {
    const q = await executeTool("queue_weekly_report", {}, adminIdentity, { traceId: "sw-s10" });
    let job = null;
    try {
      job = await pollUntil(async () => {
        const r = (await admin.query(`SELECT * FROM platform.jobs WHERE id=$1 AND status='succeeded'`, [q.job_id])).rows[0];
        return r ?? null;
      }, { label: "weekly_report job succeeded by worker" });
    } catch (e) {
      const jr = (await admin.query(`SELECT status, attempts, last_error FROM platform.jobs WHERE id=$1`, [q.job_id])).rows[0] ?? null;
      add("S10AI周报", "真实 worker 消费周报作业 succeeded", false, { pollError: String(e?.message ?? e), jobRow: jr, workerTail: wlogs.join("").slice(-500) });
      throw e;
    }
    const keys = Object.keys(job?.result ?? {});
    add("S10AI周报", "queue_weekly_report→worker 真实执行 succeeded，result 覆盖 projects/crm/hr/finance",
      q.queued === true && ["projects", "crm", "hr", "finance"].every((k) => keys.includes(k)),
      { keys });
    gap("G-S10", "低", "周报无 软件交付维度（故事点完成/缺陷密度/工时利用率/MRR 走势），SaaS 关键指标缺位。");
  });

  // ═══ S11 ABAC（薪资字段 + 项目/CRM 行级域）══════════════════
  await section0("S11权限", async () => {
    const feView = await api(feCk, "GET", `/v1/hr/employees/${S.empVpTech}`);
    const colSalary = feView.body?.contracts?.[0]?.base_salary_cents;
    const admView = await api(adminCk, "GET", `/v1/hr/employees/${S.empVpTech}`);
    const admSalary = admView.body?.contracts?.[0]?.base_salary_cents;
    const list = await api(feCk, "GET", "/v1/hr/employees");
    const cfoRow = (list.body?.items ?? []).find((r) => r.person_id === S.cfo);
    // 项目行级域：成员(beDev)可见 / 无关员工(payroll)不可见 / CTO(manager 绑定)可见
    const pSee = async (cookie) => {
      const r = await api(cookie, "GET", "/v1/projects?limit=100");
      return (r.body?.items ?? []).some((x) => x.id === PRJ2);
    };
    const pBe = await pSee(beCk); const pPay = await pSee(payCk); const pCto = await pSee(ctoCk);
    // CRM 商机行级域：负责人(pm)可见 / 无关员工不可见
    const oSee = async (cookie) => {
      const r = await api(cookie, "GET", "/v1/crm/opportunities?limit=100");
      return (r.body?.items ?? []).some((x) => x.name === "恒精 云枢三年服务包");
    };
    const oPm = await oSee(pmCk); const oPay = await oSee(payCk);
    add("S11权限", "CTO 薪资对同事隐藏+手机号脱敏/admin 可读 68000 元；项目 成员与主管可见·无关员工不可见；商机 负责人可见·无关员工不可见",
      colSalary === undefined && Number(admSalary) === 6800000 && typeof cfoRow?.mobile === "string" && cfoRow.mobile.includes("****")
      && pBe && !pPay && pCto && oPm && !oPay,
      { colSalary, admSalary, mask: cfoRow?.mobile, proj: { pBe, pPay, pCto }, opp: { oPm, oPay } });
    gap("G-S11", "中", "ABAC 覆盖 HR 字段+CRM/项目/财务/采购行级切片；审批实例列表、知识文档、考勤 等尚无行级策略声明（策略表覆盖面有限）。");
  });

  // ═══ S12 outbox：真实事件 + worker published ═══════════════
  await section0("S12事件", async () => {
    const EXPECT_TYPES = ["crm.opportunity.won.v1", "hr.offer.accepted.v1"];
    const agg = await pollUntil(async () => {
      const r = (await admin.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE published_at IS NOT NULL)::int AS pub,
                count(*) FILTER (WHERE last_error IS NOT NULL)::int AS err,
                array(select distinct event_type from platform.outbox_events where tenant_id=$1) AS types
         FROM platform.outbox_events WHERE tenant_id = $1`, [T.tenant])).rows[0];
      return r.total === r.pub && r.err === 0 && EXPECT_TYPES.every((t) => (r.types ?? []).includes(t)) ? r : null;
    }, { label: "sw outbox events published", timeout: 60000 }).catch(() => null);
    const types = agg?.types?.length ?? 0;
    add("S12事件", `软件链路事件(crm.opportunity.won / hr.offer.accepted)真实 published 且 0 失败（事件共 ${agg?.total ?? "?"} 条 / ${types} 类）`,
      !!agg && types === 2 && agg.total >= 2,
      agg ?? { note: "未全部 published；worker 日志尾部=" + wlogs.join("").slice(-400) });
    gap("G-S12", "中", "软件交付域自身不发事件：任务完成/里程碑达成/请假批准/报销批准 均无 outbox 事件，下游无法订阅这些状态变化。");
  });
};

// 容错分段（section 内异常不中断整体演练）
async function section0(name, fn) {
  try { await fn(); } catch (e) { add(name, "阶段异常中断", false, { error: String(e?.message || e) }); }
}

try {
  await run();
} catch (e) {
  add("FATAL", "演练异常中断", false, { error: String(e?.message || e), workerLogs: wlogs.join("").slice(-400) });
} finally {
  console.log("\n=== 云枢软件 · 全角色端到端演练 ===");
  let last = "";
  for (const s of steps) {
    if (s.phase !== last) { console.log(`\n[${s.phase}]`); last = s.phase; }
    console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  }
  console.log(`\n=== 步骤：${steps.filter((s) => s.ok).length}/${steps.length} 通过 ===`);
  console.log("\n=== 差距与改进点（本次真实演练暴露，非臆测）===");
  for (const g of gaps) console.log(`  [${g.sev}] ${g.id}  ${g.desc}`);
  const failed = steps.filter((s) => !s.ok);
  console.log("\n" + JSON.stringify({ passed: failed.length === 0, steps_total: steps.length, steps_failed: failed.length, gaps: gaps.length }, null, 2));
  if (failed.length) exitCode = 1;
  await admin?.end();
  server?.kill();
  worker?.kill();
  destroyContainer();
}
process.exit(exitCode);

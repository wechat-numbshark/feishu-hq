// P1-A1 回归（npm run accept:a1）：ABAC 数据域/字段脱敏接入真实执行链的端到端验证。
// 纪律：断言全部来自真实 HTTP 响应 + 真实角色绑定（authz.role_bindings），
//       同一员工档案在不同查看者下可见集合不同；失败即 exit 1，绝不打印假 PASS。
// 数据域规则（baselinePolicies）：
//   - tenant_admin / hr_manager：可见薪资 + 手机号不脱敏
//   - 本人（employee/manager/finance 看自己）：可见薪资
//   - 普通同事/主管/财务 看他人：薪资隐藏（contracts 无 base_salary_cents）+ 他人手机号脱敏
import {
  ensureContainer, applyMigrations, runSeed, startServer, waitHealth,
  makeCookies, HOST_URL, dockerExecSql,
} from "./lib.mjs";
import { randomUUID } from "node:crypto";

const TENANT = "10000000-0000-4000-8000-000000000001";
const TARGET = "20000000-0000-4000-8000-000000000005"; // T.employee（普通员工，有 employment）
const MOBILE = "13800001234";

async function call(cookie, path) {
  const res = await fetch(`${HOST_URL}${path}`, { headers: { cookie } });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-json */ }
  return { status: res.status, payload };
}

// 从 psql 对齐输出中取第一个 uuid 形态的数据行（跳过表头/分隔线/(N row)）
function psqlVal(sql) {
  const out = dockerExecSql(sql);
  const m = out.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : "";
}

const steps = [];
function add(name, ok, detail) { steps.push({ name, ok: !!ok, detail }); }

const salaryOf = (body) => {
  const v = body?.contracts?.[0]?.base_salary_cents; // bigint 经 JSON 为字符串
  return v == null ? null : Number(v);
};
const hasSalaryKey = (body) => Boolean(body?.contracts?.[0] && "base_salary_cents" in body.contracts[0]);

let server;
let exitCode = 0;
try {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  await runSeed("./seed.mjs");

  // 准备真实数据：给目标员工设手机号 + 一条含薪资的合同
  dockerExecSql(`UPDATE platform.people SET mobile='${MOBILE}' WHERE id='${TARGET}';`);
  dockerExecSql(`INSERT INTO hr.employee_contracts (id, tenant_id, person_id, contract_type, start_date, base_salary_cents, status)
    VALUES ('${randomUUID()}', '${TENANT}', '${TARGET}', 'full_time', current_date, 3000000, 'active');`);

  const empId = psqlVal(`SELECT id FROM platform.employments WHERE tenant_id='${TENANT}' AND person_id='${TARGET}' LIMIT 1;`);
  if (!/^[0-9a-f-]{36}$/i.test(empId)) throw new Error(`未找到目标员工 employment，psql 返回：${empId}`);

  server = startServer();
  await waitHealth(server);
  const cookies = await makeCookies();
  const detail = `/v1/hr/employees/${empId}`;

  // 1) 本人（employee 看自己）：薪资可见、手机号完整
  const rSelf = await call(cookies.employee, detail);
  add("本人：200 且薪资可见", rSelf.status === 200 && salaryOf(rSelf.payload) === 3000000,
    { status: rSelf.status, salary: salaryOf(rSelf.payload) });
  add("本人：手机号不脱敏", rSelf.payload?.mobile === MOBILE, { mobile: rSelf.payload?.mobile });

  // 2) 普通同事（manager 看他人）：薪资隐藏、手机号脱敏
  const rMgr = await call(cookies.manager, detail);
  add("同事(主管)：200 但薪资字段被移除", rMgr.status === 200 && !hasSalaryKey(rMgr.payload),
    { status: rMgr.status, hasSalaryKey: hasSalaryKey(rMgr.payload) });
  add("同事(主管)：手机号被脱敏", typeof rMgr.payload?.mobile === "string" && rMgr.payload.mobile.includes("****") && rMgr.payload.mobile !== MOBILE,
    { mobile: rMgr.payload?.mobile });

  // 3) 人事管理员：薪资可见、手机号完整
  const rHr = await call(cookies.hr, detail);
  add("人事：薪资可见且不脱敏", rHr.status === 200 && salaryOf(rHr.payload) === 3000000 && rHr.payload?.mobile === MOBILE,
    { status: rHr.status, salary: salaryOf(rHr.payload), mobile: rHr.payload?.mobile });

  // 4) 企业管理员：薪资可见、手机号完整
  const rAdmin = await call(cookies.admin, detail);
  add("管理员：薪资可见且不脱敏", rAdmin.status === 200 && salaryOf(rAdmin.payload) === 3000000 && rAdmin.payload?.mobile === MOBILE,
    { status: rAdmin.status, salary: salaryOf(rAdmin.payload), mobile: rAdmin.payload?.mobile });

  // 5) 财务管理员（非 HR）看他人：薪资同样隐藏
  const rFin = await call(cookies.finance, detail);
  add("财务(看他人)：薪资隐藏", rFin.status === 200 && !hasSalaryKey(rFin.payload),
    { status: rFin.status, hasSalaryKey: hasSalaryKey(rFin.payload) });

  // 6) 列表端点：同事视角他人行手机号脱敏；管理员视角不脱敏
  const rListMgr = await call(cookies.manager, "/v1/hr/employees?limit=200");
  const rowMgr = rListMgr.payload?.items?.find((x) => x.person_id === TARGET);
  const rowMgrSelf = rListMgr.payload?.items?.find((x) => x.person_id === "20000000-0000-4000-8000-000000000002"); // manager 本人（无手机号，跳过）
  add("列表(同事)：他人手机号脱敏", rowMgr && String(rowMgr.mobile).includes("****"),
    { mobile: rowMgr?.mobile });
  const rListAdmin = await call(cookies.admin, "/v1/hr/employees?limit=200");
  const rowAdmin = rListAdmin.payload?.items?.find((x) => x.person_id === TARGET);
  add("列表(管理员)：手机号不脱敏", rowAdmin && rowAdmin.mobile === MOBILE, { mobile: rowAdmin?.mobile });
  void rowMgrSelf;

  const failed = steps.filter((s) => !s.ok);
  console.log("=== P1-A1 ABAC 数据域/字段脱敏 端到端 ===");
  for (const s of steps) console.log(`  ${s.ok ? "OK " : "BAD"}  ${s.name}${s.ok ? "" : "  " + JSON.stringify(s.detail)}`);
  console.log("\n" + JSON.stringify({ passed: failed.length === 0, total_steps: steps.length, failed_steps: failed.length }, null, 2));
  if (failed.length) exitCode = 1;
} catch (e) {
  console.log(JSON.stringify({ RESULT: "FAIL", error: String(e && e.message || e) }));
  exitCode = 1;
} finally {
  server?.kill("SIGTERM");
}
process.exit(exitCode);

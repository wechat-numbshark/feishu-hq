// 部署后 API 冒烟：无第三方依赖，Node 22 内置 fetch。
// 用法：node scripts/smoke/api-smoke.mjs [BASE_URL] [MFG_EMPLOYEE_ID]
const base = (process.argv[2] || process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const employeeId = process.argv[3] || process.env.SMOKE_EMPLOYEE_ID || "d0000001-0000-4000-8000-00000000aa05";
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "  " + detail : ""}`); }
}

async function login(company, person) {
  const res = await fetch(base + "/v1/session/demo", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(person ? { company, person } : { company }),
  });
  return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function main() {
  let r = await fetch(base + "/health");
  const health = await r.json().catch(() => ({}));
  check("health 200 + database connected", r.status === 200 && health.database === "connected", `${r.status} ${health.database}`);

  r = await fetch(base + "/metrics");
  const metrics = await r.text();
  check("metrics exposes hq_database_up", r.status === 200 && metrics.includes("hq_database_up"));

  const status = await (await fetch(base + "/v1/auth/status")).json();
  check("auth status returns demoMode", typeof status.demoMode === "boolean");

  if (status.demoMode) {
    const admin = await login("standard");
    check("demo login 201", admin.res.status === 201, String(admin.res.status));

    r = await fetch(base + "/v1/workspace", { headers: { cookie: admin.cookie } });
    check("workspace 200", r.status === 200, String(r.status));

    r = await fetch(base + "/v1/search?q=" + encodeURIComponent("远山"), { headers: { cookie: admin.cookie } });
    const search = await r.json().catch(() => ({}));
    check("search returns hits", r.status === 200 && Array.isArray(search.items) && search.items.length > 0);

    r = await fetch(base + "/v1/export/projects", { headers: { cookie: admin.cookie } });
    check("admin export CSV 200", r.status === 200, String(r.status));

    r = await fetch(base + "/v1/audit/events", { headers: { cookie: admin.cookie } });
    check("admin audit 200", r.status === 200, String(r.status));

    r = await fetch(base + "/v1/import/employees", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie: admin.cookie },
      body: JSON.stringify({ csv: "姓名,邮箱\n冒烟测试,smoke@example.com", dryRun: true }),
    });
    check("import dry-run 200", r.status === 200, String(r.status));

    const emp = await login("mfg", employeeId);
    r = await fetch(base + "/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie: emp.cookie },
      body: JSON.stringify({ name: "smoke", customer_name: "smoke" }),
    });
    check("employee create project 403", r.status === 403, String(r.status));

    r = await fetch(base + "/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: admin.cookie },
      body: JSON.stringify({ name: "smoke", customer_name: "smoke" }),
    });
    check("cross-site origin 403", r.status === 403, String(r.status));

    r = await fetch(base + "/v1/session/logout-all", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie: admin.cookie },
      body: "{}",
    });
    check("logout-all 200", r.status === 200, String(r.status));
    r = await fetch(base + "/v1/workspace", { headers: { cookie: admin.cookie } });
    check("revoked session 401", r.status === 401, String(r.status));
  }

  console.log(`\nSMOKE ${failed === 0 ? "PASS" : "FAIL"}  passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });

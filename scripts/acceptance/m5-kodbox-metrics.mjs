// M5 验收：Kodbox 对接端到端 + 指标视图（口径/来源/权限过滤），全部真实读回证据。
// Part A：以本地协议等价的 Kodbox 测试替身(内存 FS + 每用户 ACL)驱动「真实」KodboxClient 代码路径：
//         登录 / 上传(返回真实 fid，非 mock_fid) / 下载(字节一致) / 检索仅返回授权文件 / 权限撤销立即生效 / 分享撤销立即生效。
// Part B：隔离库上以 hq_app(受 RLS) 读取 reporting.v_metric_catalog / v_metric_values，
//         验证每项指标有口径、有来源、有权限作用域，且同一视图在不同租户返回不同数值(权限过滤)。
// 约束：自建临时容器、不接外部/正式 Kodbox、不改 .env、不花费外部 API、绝对禁止编造结果。
import http from "node:http";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ensureContainer, applyMigrations, runSeed, ADMIN_DB_URL } from "./lib.mjs";

const T = (await import("./seed.mjs")).T;
const { createKodboxClient } = await import("../../packages/connectors/kodbox/src/index.ts");

// ── 本地 Kodbox 协议测试替身（内存实现，逐端点等价于 KodboxClient 的调用契约）──
function startMockKodbox() {
  const files = new Map();       // fullPath -> {fid,name,path,size,bytes,ownerUid}
  const perms = [];              // {path, uid, perm}
  const shares = new Map();      // shareId -> {path, active}
  let fidSeq = 1;
  const nameToUid = { admin: 1, userb: 2, userc: 3 };
  const norm = (p) => { const s = ("/" + String(p).replace(/\/+$/, "")).replace(/\/{2,}/g, "/"); return s === "" ? "/" : s; };
  const parentOf = (full) => { const i = full.lastIndexOf("/"); return i <= 0 ? "/" : full.slice(0, i); };
  const canRead = (uid, full) => {
    if (uid === 1) return true;
    const f = files.get(full);
    if (f && f.ownerUid === uid) return true;
    return perms.some((p) => p.uid === uid && ["read", "read_write", "admin"].includes(p.perm)
      && (full === p.path || full.startsWith(p.path === "/" ? "/" : p.path + "/")));
  };
  const uidFrom = (req) => {
    const auth = req.headers.authorization || "";
    const m = /Bearer tok:(\d+)/.exec(auth);
    return m ? Number(m[1]) : null;
  };
  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json" }); res.end(b); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const raw = Buffer.from(await collect(req));
    const ct = req.headers["content-type"] || "";
    const fields = ct.includes("multipart/form-data") ? parseMultipart(raw, /boundary=(.+)$/.exec(ct)?.[1]) : [];
    const get = (n) => fields.find((f) => f.name === n)?.data?.toString("utf8");
    const filePart = fields.find((f) => f.name === "file" && f.filename);

    // 登录（免鉴权）
    if (u.pathname === "/index.php" && u.search.includes("user/index/loginSubmit")) {
      const name = get("name") || "userb";
      const uid = nameToUid[name] ?? 9;
      if (!nameToUid[name]) nameToUid[name] = uid;
      return send(res, 200, { code: 0, message: "success", data: { token: `tok:${uid}`, user: { uid, username: name, role: uid === 1 ? "admin" : "user", role_name: "" } } });
    }
    const uid = uidFrom(req);
    if (u.pathname.startsWith("/s/")) { // 分享链接：公开访问(无需登录)，撤销后立即失效
      const s = shares.get(u.pathname.slice(3));
      if (!s || !s.active) { res.writeHead(410); return res.end("gone"); }
      res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(files.get(s.path)?.bytes ?? Buffer.alloc(0));
    }
    if (uid == null) return send(res, 401, { code: 1, message: "unauthenticated" });

    if (u.pathname === "/index.php" && u.search.includes("explorer/list")) {
      const p = norm(u.searchParams.get("path") || "/");
      let list = [];
      if (files.has(p)) { if (canRead(uid, p)) list = [info(p)]; }
      else list = [...files.keys()].filter((k) => parentOf(k) === p && canRead(uid, k)).map(info);
      return send(res, 200, { code: 0, message: "success", data: { list, total: list.length, path: p } });
    }
    if (u.pathname === "/index.php" && u.search.includes("explorer/download")) {
      const p = norm(u.searchParams.get("path"));
      const f = files.get(p);
      if (!f) { res.writeHead(404); return res.end("not_found"); }
      if (!canRead(uid, p)) { res.writeHead(403); return res.end("forbidden"); }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(f.bytes);
    }
    if (u.pathname === "/index.php" && u.search.includes("explorer/newFolder")) {
      return send(res, 200, { code: 0, message: "success" }); // 自动补父级，无需显式建目录
    }
    if (u.pathname === "/index.php" && u.search.includes("explorer/upload")) {
      const dir = norm(get("path") || "/");
      if (!filePart) return send(res, 200, { code: 1, message: "no_file" });
      const fname = filePart.filename;
      const full = (dir === "/" ? "" : dir) + "/" + fname;
      const fid = "fid_" + (fidSeq++);
      files.set(full, { fid, name: fname, path: full, size: filePart.data.length, bytes: filePart.data, ownerUid: uid });
      return send(res, 200, { code: 0, message: "success", data: { fid, name: fname, path: full, size: filePart.data.length } });
    }
    if (u.pathname === "/index.php" && u.search.includes("explorer/delete")) {
      for (const p of JSON.parse(get("paths") || "[]")) { const full = norm(p); for (const k of [...files.keys()]) if (k === full || k.startsWith(full + "/")) files.delete(k); }
      return send(res, 200, { code: 0, message: "success" });
    }
    if (u.pathname === "/index.php" && u.search.includes("acl/set")) {
      const path = norm(get("path")); const target = Number(get("user_id")); const perm = get("permission");
      for (let i = perms.length - 1; i >= 0; i--) if (perms[i].path === path && perms[i].uid === target) perms.splice(i, 1);
      if (perm && perm !== "none") perms.push({ path, uid: target, perm });
      return send(res, 200, { code: 0, message: "success" });
    }
    if (u.pathname === "/index.php" && u.search.includes("acl/list")) {
      const path = norm(u.searchParams.get("path"));
      return send(res, 200, { code: 0, message: "success", data: perms.filter((p) => p.path === path).map((p) => ({ path, user_id: String(p.uid), permission: p.perm })) });
    }
    if (u.pathname === "/index.php" && u.search.includes("share/create")) {
      const id = "sh_" + randomUUID().slice(0, 8); shares.set(id, { path: norm(get("path")), active: true });
      return send(res, 200, { code: 0, message: "success", data: { share_id: id, share_url: `http://127.0.0.1:${server.address().port}/s/${id}` } });
    }
    if (u.pathname === "/index.php" && u.search.includes("share/cancel")) {
      const s = shares.get(get("share_id")); if (s) s.active = false;
      return send(res, 200, { code: 0, message: "success" });
    }
    return send(res, 404, { code: 1, message: "unknown_endpoint" });
  });

  function info(p) { const f = files.get(p); return { fid: f.fid, name: f.name, path: f.path, size: f.size, mtime: 0, type: "file", is_dir: false }; }
  function collect(req) { return new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); }); }
  function parseMultipart(raw, boundary) {
    if (!boundary) return [];
    const delim = Buffer.from("--" + boundary.replace(/^"|"$/g, ""));
    const out = []; let idx = raw.indexOf(delim);
    while (idx !== -1) {
      idx += delim.length;
      if (raw.slice(idx, idx + 2).toString() === "--") break;
      if (raw.slice(idx, idx + 2).toString() === "\r\n") idx += 2;
      const he = raw.indexOf("\r\n\r\n", idx); if (he === -1) break;
      const header = raw.slice(idx, he).toString();
      let next = raw.indexOf(delim, he + 4); if (next === -1) next = raw.length;
      let bodyEnd = next; if (raw.slice(bodyEnd - 2, bodyEnd).toString() === "\r\n") bodyEnd -= 2;
      const data = raw.slice(he + 4, bodyEnd);
      out.push({ name: /name="([^"]*)"/.exec(header)?.[1], filename: /filename="([^"]*)"/.exec(header)?.[1], data });
      idx = next;
    }
    return out;
  }
  return server;
}

// ── Part A：Kodbox 对接 E2E（真实客户端代码 + 协议测试替身）──
async function kodboxE2E() {
  const server = startMockKodbox();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  const push = (name, pass, detail) => results.push({ name, ok: !!pass, detail });
  try {
    const admin = createKodboxClient({ baseUrl: base, username: "admin", password: "x" });
    const auth = await admin.login();
    push("Kodbox 登录成功并取得 token", auth.code === 0 && !!auth.data?.token, { code: auth.code, hasToken: !!auth.data?.token });

    await admin.mkdir("/", "team");
    const content = "M5 真实内容 " + Date.now();
    const up = await admin.upload("/team", new Blob([content], { type: "text/plain" }), "doc1.txt");
    const realFid = up.data?.fid;
    push("上传返回真实 fid(非 mock_fid) 且落库大小一致",
      !!realFid && realFid !== "mock_fid" && /^fid_/.test(realFid) && up.data.size === Buffer.byteLength(content),
      { fid: realFid, size: up.data?.size, expected_size: Buffer.byteLength(content) });

    const dl = await (await admin.download("/team/doc1.txt")).text();
    push("下载字节与上传完全一致", dl === content, { match: dl === content });

    // 再上传一份机密文件，之后仅授权 doc1 给 userB。
    await admin.upload("/team", new Blob(["secret"], { type: "text/plain" }), "secret.txt");
    await admin.setPathPermission("/team/doc1.txt", "2", "read");
    const userB = createKodboxClient({ baseUrl: base, username: "userb", password: "x" });
    await userB.login();
    const listB = await userB.list("/team");
    const namesB = listB.data.list.map((f) => f.name);
    push("检索仅返回授权文件(userB 见 doc1 不见 secret)",
      namesB.includes("doc1.txt") && !namesB.includes("secret.txt"), { visible: namesB });

    // 权限撤销立即生效。
    await admin.setPathPermission("/team/doc1.txt", "2", "none");
    const listB2 = await userB.list("/team");
    const namesB2 = listB2.data.list.map((f) => f.name);
    const dlForbidden = await userB.download("/team/doc1.txt").then(() => false).catch(() => true);
    push("权限撤销立即生效(下一次检索即不可见、下载被拒)",
      !namesB2.includes("doc1.txt") && dlForbidden === true, { visible_after_revoke: namesB2, download_blocked: dlForbidden });

    // 分享撤销立即生效。
    const share = await admin.createShare("/team/doc1.txt", { permission: "read" });
    const shareUrl = share.data?.share_url;
    const before = await fetch(shareUrl).then((r) => r.status);
    await admin.revokeShare(share.data.share_id);
    const after = await fetch(shareUrl).then((r) => r.status);
    push("分享链接创建可用、撤销后立即失效(200 -> 410)",
      before === 200 && after === 410, { before, after });
  } finally {
    server.close();
  }
  return results;
}

// 在受控事务内以 hq_app(受 RLS) 读取。
async function asTenant(client, tenantId, fn) {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  await client.query("SET LOCAL ROLE hq_app");
  try { const r = await fn(client); await client.query("COMMIT"); return r; }
  catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
}
async function metricValues(client, tenantId) {
  return asTenant(client, tenantId, async (db) => {
    const { rows } = await db.query(`SELECT metric_key, metric_value FROM reporting.v_metric_values ORDER BY metric_key`);
    return Object.fromEntries(rows.map((r) => [r.metric_key, Number(r.metric_value)]));
  });
}

// ── Part B：指标视图 口径/来源/权限过滤 ──────────────────────
async function metricViews(admin) {
  const results = [];
  const push = (name, pass, detail) => results.push({ name, ok: !!pass, detail });

  // 租户 A 数据
  for (const [code, status] of [["MA1", "active"], ["MA2", "at_risk"]])
    await admin.query(`INSERT INTO project.projects (id,tenant_id,code,name,customer_name,status) VALUES ($1,$2,$3,$3,'客户A',$4)`, [randomUUID(), T.tenant, code, status]);
  await admin.query(`INSERT INTO crm.opportunities (id,tenant_id,name,customer_name,amount_cents,stage) VALUES ($1,$2,'oA1','客户A',100000,'qualified')`, [randomUUID(), T.tenant]);
  await admin.query(`INSERT INTO crm.opportunities (id,tenant_id,name,customer_name,amount_cents,stage) VALUES ($1,$2,'oA2','客户A',200000,'qualified')`, [randomUUID(), T.tenant]);
  await admin.query(`INSERT INTO crm.opportunities (id,tenant_id,name,customer_name,amount_cents,stage) VALUES ($1,$2,'oWon','客户A',999999,'won')`, [randomUUID(), T.tenant]);
  await admin.query(`INSERT INTO hr.job_requisitions (id,tenant_id,title,headcount,reason,status) VALUES ($1,$2,'工程师',3,'扩编','open')`, [randomUUID(), T.tenant]);
  await admin.query(`INSERT INTO finance.expenses (id,tenant_id,submitter_person_id,category,amount_cents,expense_date,description,status) VALUES ($1,$2,$3,'travel',5000,current_date,'a','submitted'),($4,$2,$3,'meals',3000,current_date,'b','approved'),($5,$2,$3,'other',700,current_date,'c','draft')`,
    [randomUUID(), T.tenant, T.employee, randomUUID(), randomUUID()]);
  // 租户 B 数据（不同规模，用于权限过滤对比）
  await admin.query(`INSERT INTO project.projects (id,tenant_id,code,name,customer_name,status) VALUES ($1,$2,'MB1','项目B','客户B','planning')`, [randomUUID(), T.tenantB]);
  await admin.query(`INSERT INTO crm.opportunities (id,tenant_id,name,customer_name,amount_cents,stage) VALUES ($1,$2,'oB1','客户B',5000,'qualified')`, [randomUUID(), T.tenantB]);

  // 口径/来源/权限作用域齐全
  const cat = await asTenant(admin, T.tenant, async (db) =>
    (await db.query(`SELECT metric_key, caliber, data_source, permission_scope FROM reporting.v_metric_catalog ORDER BY metric_key`)).rows);
  const complete = cat.length >= 6 && cat.every((r) => r.caliber && r.data_source && r.permission_scope);
  push("指标目录每项都有口径(caliber)/来源(data_source)/权限作用域",
    complete, { count: cat.length, sample: cat[0] });

  const va = await metricValues(admin, T.tenant);
  const vb = await metricValues(admin, T.tenantB);
  push("指标口径正确：租户A 值符合定义(项目/漏斗/在招/待审报销)",
    va["project.total"] === 2 && va["project.active"] === 1 && va["project.at_risk"] === 1
      && va["crm.open_pipeline_cents"] === 300000 && va["hr.open_requisition_headcount"] === 3
      && va["finance.pending_expense_cents"] === 8000,
    { tenantA: va });
  push("权限过滤：同一 security_invoker 视图在租户B返回其本租户数值(非跨租户汇总)",
    vb["project.total"] === 1 && vb["project.active"] === 0 && vb["crm.open_pipeline_cents"] === 5000
      && vb["hr.open_requisition_headcount"] === 0 && vb["finance.pending_expense_cents"] === 0,
    { tenantB: vb });
  push("跨租户隔离：A 与 B 的指标值互不串扰",
    va["project.total"] !== vb["project.total"] && va["crm.open_pipeline_cents"] !== vb["crm.open_pipeline_cents"],
    { A_pipeline: va["crm.open_pipeline_cents"], B_pipeline: vb["crm.open_pipeline_cents"] });

  return results;
}

async function main() {
  await ensureContainer({ fresh: true });
  const mig = await applyMigrations();
  await runSeed("./seed.mjs");

  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  let exitCode = 0;
  try {
    const kodbox = await kodboxE2E();
    const metrics = await metricViews(admin);
    const all = [...kodbox, ...metrics];
    const failed = all.filter((r) => !r.ok);
    const report = { migrations: mig, cases: all, total: all.length, failed: failed.length, passed: all.length >= 6 && failed.length === 0 };
    console.log("=== M5 Kodbox 对接 + 指标视图 ===");
    for (const r of all) {
      console.log(`${r.ok ? "OK " : "BAD"}  ${r.name}`);
      if (!r.ok) console.log(`        detail: ${JSON.stringify(r.detail)}`);
    }
    console.log("\n" + JSON.stringify(report, null, 2));
    if (!report.passed) exitCode = 1;
  } finally {
    await admin.end().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((err) => { console.error("M5 harness error:", err); process.exit(2); });

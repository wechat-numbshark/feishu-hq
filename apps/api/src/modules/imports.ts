import { get, post, json } from "../router.ts";
import { withTenant, uuid, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { assertCapability } from "../authz.ts";

// ═══════════════════════════════════════════════════════════════
// CSV 导入（员工 / 客户）：先干跑校验，再提交；逐行返回错误。
// 文件由前端读取为文本后 POST，避免 multipart 依赖。
// ═══════════════════════════════════════════════════════════════

const MAX_ROWS = 2000;

function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

type ColumnMap = Record<string, string[]>;
const ALIASES: Record<string, ColumnMap> = {
  employees: {
    display_name: ["姓名", "name", "display_name"],
    primary_email: ["邮箱", "email", "primary_email"],
    mobile: ["手机", "手机号", "mobile"],
    employee_number: ["工号", "employee_number", "employee_no"],
    org_unit_name: ["部门", "org_unit", "department"],
    position_name: ["职位", "position", "title"],
    start_date: ["入职日期", "start_date", "hire_date"],
    employment_type: ["雇佣类型", "employment_type"],
  },
  accounts: {
    name: ["客户名称", "name", "account_name"],
    industry: ["行业", "industry"],
    company_size: ["规模", "company_size"],
    website: ["网站", "website", "url"],
    city: ["城市", "city"],
    notes: ["备注", "notes"],
  },
  parts: {
    part_number: ["料号", "part_number", "part_no", "sku"],
    name: ["名称", "name", "part_name"],
    kind: ["类型", "kind"],
    uom: ["单位", "uom"],
    safety_stock: ["安全库存", "safety_stock"],
    spec: ["规格", "spec", "specification"],
  },
};

function mapHeader(entity: string, header: string[]): Record<string, number> {
  const aliases = ALIASES[entity] ?? {};
  const index: Record<string, number> = {};
  header.forEach((h, i) => {
    const normalized = h.trim().toLowerCase();
    for (const [key, names] of Object.entries(aliases)) {
      if (names.some((n) => n.toLowerCase() === normalized)) {
        if (index[key] == null) index[key] = i;
      }
    }
  });
  return index;
}

function cell(row: string[], index: Record<string, number>, key: string): string {
  const i = index[key];
  return i == null ? "" : (row[i] ?? "").trim();
}

function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

const TEMPLATES: Record<string, string> = {
  employees: "姓名,邮箱,手机,工号,部门,职位,入职日期,雇佣类型\n张三,zhangsan@example.com,13800000000,EMP-001,总部,工程师,2026-01-01,employee\n",
  accounts: "客户名称,行业,规模,网站,城市,备注\n示例客户,tech,51-200,https://example.com,上海,重点跟进\n",
  parts: "料号,名称,类型,单位,安全库存,规格\nCNC-BRKT-099,CNC 结构件 099,product,PCS,50,6061-T6\n",
};

get("/v1/import/:entity/template", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = TEMPLATES[ctx.params.entity];
  if (!body) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent({ employees: "员工导入模板", accounts: "客户导入模板", parts: "物料导入模板" }[ctx.params.entity] || "导入模板")}.csv`,
    "cache-control": "no-store",
  });
  res.end(`\uFEFF${body}`);
});

post("/v1/import/:entity", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const entity = ["employees", "accounts", "parts"].includes(ctx.params.entity) ? ctx.params.entity : null;
  if (!entity) return json(res, 404, { error: "not_found", traceId: ctx.traceId });

  const body = req.body as { csv?: string; dryRun?: boolean };
  if (typeof body.csv !== "string" || !body.csv.trim()) {
    return json(res, 400, { error: "csv_required", traceId: ctx.traceId });
  }
  const table = parseCsv(body.csv);
  if (table.length < 2) return json(res, 400, { error: "csv_has_no_rows", traceId: ctx.traceId });
  if (table.length - 1 > MAX_ROWS) return json(res, 400, { error: "too_many_rows", limit: MAX_ROWS, traceId: ctx.traceId });

  const header = table[0];
  const index = mapHeader(entity, header);
  const required = entity === "employees" ? ["display_name"] : entity === "parts" ? ["part_number", "name"] : ["name"];
  const missing = required.filter((k) => index[k] == null);
  if (missing.length) {
    return json(res, 400, { error: "missing_required_columns", columns: missing, traceId: ctx.traceId });
  }

  const errors: Array<{ row: number; message: string }> = [];
  const valid: Array<Record<string, string>> = [];
  table.slice(1).forEach((row, i) => {
    const rowNo = i + 2;
    const record: Record<string, string> = {};
    for (const key of Object.keys(ALIASES[entity])) record[key] = cell(row, index, key);
    if (entity === "employees") {
      if (!record.display_name) errors.push({ row: rowNo, message: "姓名不能为空" });
      else if (record.primary_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(record.primary_email)) errors.push({ row: rowNo, message: "邮箱格式不正确" });
      else if (record.start_date && !isDate(record.start_date)) errors.push({ row: rowNo, message: "入职日期应为 YYYY-MM-DD" });
      else valid.push(record);
    } else if (entity === "parts") {
      if (!record.part_number) errors.push({ row: rowNo, message: "料号不能为空" });
      else if (!record.name) errors.push({ row: rowNo, message: "物料名称不能为空" });
      else if (record.safety_stock && (!Number.isFinite(Number(record.safety_stock)) || Number(record.safety_stock) < 0)) {
        errors.push({ row: rowNo, message: "安全库存应为非负数字" });
      } else if (record.kind && !["product", "assembly", "raw"].includes(record.kind)) {
        errors.push({ row: rowNo, message: "类型应为 product/assembly/raw" });
      } else valid.push(record);
    } else {
      if (!record.name) errors.push({ row: rowNo, message: "客户名称不能为空" });
      else if (record.company_size && !["1-10", "11-50", "51-200", "201-500", "501-2000", "2000+"].includes(record.company_size)) {
        errors.push({ row: rowNo, message: "规模应在 1-10/11-50/51-200/201-500/501-2000/2000+ 之内" });
      } else valid.push(record);
    }
  });

  if (body.dryRun !== false) {
    return json(res, 200, {
      entity, dryRun: true, total: table.length - 1, valid: valid.length, errors,
      preview: valid.slice(0, 10),
    });
  }

  if (errors.length) {
    return json(res, 400, { error: "validation_failed", total: table.length - 1, valid: valid.length, errors, traceId: ctx.traceId });
  }

  const imported = await withTenant(identity, async (db: DbClient) => {
    await assertCapability(db, identity, entity === "employees" ? "hr.manage" : entity === "parts" ? "ops.manage" : "crm.manage");
    if (entity === "employees") return importEmployees(db, identity, valid);
    if (entity === "parts") return importParts(db, identity, valid);
    return importAccounts(db, identity, valid);
  });

  json(res, 201, { entity, imported, total: table.length - 1, errors: [], traceId: ctx.traceId });
});

async function importEmployees(db: DbClient, identity: { personId: string }, rows: Array<Record<string, string>>): Promise<number> {
  const { rows: leRows } = await db.query(
    `SELECT id FROM platform.legal_entities WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL ORDER BY created_at LIMIT 1`
  );
  const { rows: ouRows } = await db.query(
    `SELECT id FROM platform.org_units WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL ORDER BY created_at LIMIT 1`
  );
  if (!leRows[0] || !ouRows[0]) throw new Error("organization_not_initialized");
  let count = 0;
  for (const r of rows) {
    if (r.primary_email) {
      const dup = await db.query(
        `SELECT 1 FROM platform.people WHERE tenant_id = platform.current_tenant_id()
           AND primary_email = $1 AND deleted_at IS NULL`,
        [r.primary_email]
      );
      if (dup.rowCount) continue;
    }
    const personId = uuid();
    await db.query(
      `INSERT INTO platform.people (id, tenant_id, display_name, primary_email, mobile, status, classification)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, 'active', 'internal')`,
      [personId, r.display_name, r.primary_email || null, r.mobile || null]
    );
    await db.query(
      `INSERT INTO platform.employments
         (id, tenant_id, person_id, legal_entity_id, org_unit_id, employee_number,
          employment_type, status, start_date)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, 'active', $7)`,
      [uuid(), personId, leRows[0].id, ouRows[0].id, r.employee_number || null,
       r.employment_type || "employee", r.start_date || new Date().toISOString().slice(0, 10)]
    );
    count++;
  }
  await db.query(
    `INSERT INTO audit.audit_events
       (id, tenant_id, actor_id, action, resource_type, outcome, change_summary, client_context, trace_id)
     VALUES ($1, platform.current_tenant_id(), $2, 'import.employees', 'person', 'success', $3::jsonb, '{}'::jsonb, 'csv-import')`,
    [uuid(), `person:${identity.personId}`, JSON.stringify({ imported: count })]
  );
  return count;
}

async function importParts(db: DbClient, identity: { personId: string }, rows: Array<Record<string, string>>): Promise<number> {
  let count = 0;
  for (const r of rows) {
    const kind = ["product", "assembly", "raw"].includes(r.kind) ? r.kind : "product";
    const { rowCount } = await db.query(
      `INSERT INTO mfg.parts
         (id, tenant_id, part_number, name, kind, uom, spec, safety_stock, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, 'active')
       ON CONFLICT (tenant_id, part_number) DO NOTHING`,
      [uuid(), r.part_number, r.name, kind, r.uom || "PCS", r.spec || null, Number(r.safety_stock || 0)]
    );
    count += rowCount ?? 0;
  }
  await db.query(
    `INSERT INTO audit.audit_events
       (id, tenant_id, actor_id, action, resource_type, outcome, change_summary, client_context, trace_id)
     VALUES ($1, platform.current_tenant_id(), $2, 'import.parts', 'part', 'success', $3::jsonb, '{}'::jsonb, 'csv-import')`,
    [uuid(), `person:${identity.personId}`, JSON.stringify({ imported: count })]
  );
  return count;
}

async function importAccounts(db: DbClient, identity: { personId: string }, rows: Array<Record<string, string>>): Promise<number> {
  let count = 0;
  for (const r of rows) {
    await db.query(
      `INSERT INTO crm.accounts (id, tenant_id, name, industry, company_size, website, city, notes, owner_person_id, account_type, is_demo)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, 'prospect', false)`,
      [uuid(), r.name, r.industry || null, r.company_size || null, r.website || null, r.city || null, r.notes || null, identity.personId]
    );
    count++;
  }
  await db.query(
    `INSERT INTO audit.audit_events
       (id, tenant_id, actor_id, action, resource_type, outcome, change_summary, client_context, trace_id)
     VALUES ($1, platform.current_tenant_id(), $2, 'import.accounts', 'account', 'success', $3::jsonb, '{}'::jsonb, 'csv-import')`,
    [uuid(), `person:${identity.personId}`, JSON.stringify({ imported: count })]
  );
  return count;
}

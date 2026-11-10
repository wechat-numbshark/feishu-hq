import { get, json } from "../router.ts";
import { withTenant, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";
import { assertCapability } from "../authz.ts";
import { resolveRowScope } from "../data-domain.ts";

// ═══════════════════════════════════════════════════════════════
// CSV 导出（Excel 兼容：UTF-8 BOM + CRLF）
// 真实客户迁移/对账的第一步；权限与列表一致（RLS + 能力 + 行级域）。
// ═══════════════════════════════════════════════════════════════

const EXPORTS: Record<string, {
  capability: string;
  filename: string;
  columns: Array<{ key: string; label: string }>;
  query: (db: DbClient, scope: string | null) => Promise<Array<Record<string, unknown>>>;
}> = {
  projects: {
    capability: "project.manage",
    filename: "项目清单",
    columns: [
      { key: "code", label: "项目编号" }, { key: "name", label: "项目名称" },
      { key: "customer_name", label: "客户" }, { key: "status", label: "状态" },
      { key: "progress", label: "进度%" }, { key: "budget_cents", label: "预算(分)" },
      { key: "start_date", label: "开始日期" }, { key: "end_date", label: "结束日期" },
    ],
    query: async (db, scope) => (await db.query(
      `SELECT code, name, customer_name, status, progress, budget_cents, start_date, end_date
       FROM project.projects
       WHERE tenant_id = platform.current_tenant_id()
         AND ($1::uuid IS NULL OR owner_person_id IS NULL OR owner_person_id = $1
              OR EXISTS (SELECT 1 FROM project.project_members pm
                         WHERE pm.tenant_id = project.projects.tenant_id AND pm.project_id = project.projects.id
                           AND pm.person_id = $1 AND pm.left_at IS NULL))
       ORDER BY created_at DESC LIMIT 5000`, [scope])).rows,
  },
  accounts: {
    capability: "crm.manage",
    filename: "客户清单",
    columns: [
      { key: "name", label: "客户名称" }, { key: "industry", label: "行业" },
      { key: "company_size", label: "规模" }, { key: "website", label: "网站" },
      { key: "owner_name", label: "负责人" }, { key: "created_at", label: "创建时间" },
    ],
    query: async (db, scope) => (await db.query(
      `SELECT a.name, a.industry, a.company_size, a.website, p.display_name AS owner_name, a.created_at
       FROM crm.accounts a
       LEFT JOIN platform.people p ON p.tenant_id = a.tenant_id AND p.id = a.owner_person_id
       WHERE a.tenant_id = platform.current_tenant_id() AND a.deleted_at IS NULL
         AND ($1::uuid IS NULL OR a.owner_person_id IS NULL OR a.owner_person_id = $1)
       ORDER BY a.created_at DESC LIMIT 5000`, [scope])).rows,
  },
  employees: {
    capability: "hr.employee.read",
    filename: "员工花名册",
    columns: [
      { key: "display_name", label: "姓名" }, { key: "employee_number", label: "工号" },
      { key: "org_unit_name", label: "部门" }, { key: "position_name", label: "职位" },
      { key: "employment_type", label: "雇佣类型" }, { key: "status", label: "状态" },
      { key: "start_date", label: "入职日期" },
    ],
    query: async (db) => (await db.query(
      `SELECT p.display_name, e.employee_number, ou.name AS org_unit_name, pos.name AS position_name,
              e.employment_type, e.status, e.start_date
       FROM platform.employments e
       JOIN platform.people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
       LEFT JOIN platform.org_units ou ON ou.tenant_id = e.tenant_id AND ou.id = e.org_unit_id
       LEFT JOIN platform.positions pos ON pos.tenant_id = e.tenant_id AND pos.id = e.position_id
       WHERE e.tenant_id = platform.current_tenant_id() AND e.deleted_at IS NULL
       ORDER BY ou.name, p.display_name LIMIT 5000`)).rows,
  },
  expenses: {
    capability: "finance.read",
    filename: "报销清单",
    columns: [
      { key: "category", label: "类别" }, { key: "amount_cents", label: "金额(分)" },
      { key: "expense_date", label: "发生日期" }, { key: "description", label: "说明" },
      { key: "status", label: "状态" }, { key: "submitter_name", label: "提交人" },
    ],
    query: async (db) => (await db.query(
      `SELECT e.category, e.amount_cents, e.expense_date, e.description, e.status, p.display_name AS submitter_name
       FROM finance.expenses e
       JOIN platform.people p ON p.tenant_id = e.tenant_id AND p.id = e.submitter_person_id
       WHERE e.tenant_id = platform.current_tenant_id()
       ORDER BY e.expense_date DESC LIMIT 5000`)).rows,
  },
};

function csvCell(value: unknown): string {
  if (value == null) return "";
  let s = String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

get("/v1/export/:entity", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const entity = ctx.params.entity.replace(/\.csv$/, "");
  const spec = EXPORTS[entity];
  if (!spec) return json(res, 404, { error: "not_found", traceId: ctx.traceId });

  const rows = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, spec.capability);
    const { sqlParam } = await resolveRowScope(db, identity);
    return spec.query(db, sqlParam);
  });

  const header = spec.columns.map(c => csvCell(c.label)).join(",");
  const body = rows.map(row => spec.columns.map(c => csvCell(row[c.key])).join(",")).join("\r\n");
  const csv = `\uFEFF${header}\r\n${body}\r\n`;
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(spec.filename)}-${new Date().toISOString().slice(0, 10)}.csv`,
    "cache-control": "no-store",
  });
  res.end(csv);
});

import { get, json } from "../router.ts";
import { withTenant, type DbClient } from "../db.ts";
import { readSession } from "../session.ts";

// ═══════════════════════════════════════════════════════════════
// 全局搜索：项目 / 客户 / 商机 / 人员 / 知识 / 合同 / 任务
// 单次查询、各域 LIMIT 5；所有查询受 RLS 与租户条件约束。
// ═══════════════════════════════════════════════════════════════

interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  link: string;
}

get("/v1/search", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = (ctx.url.searchParams.get("q") ?? "").trim();
  if (q.length < 1) return json(res, 200, { items: [] });
  const pattern = `%${q}%`;

  const items = await withTenant(identity, async (db: DbClient) => {
    const hits: SearchHit[] = [];
    const add = (type: string, id: string, title: string, subtitle: string, link: string) => {
      hits.push({ type, id, title, subtitle, link });
    };

    const projects = await db.query(
      `SELECT id, name, customer_name, status FROM project.projects
       WHERE tenant_id = platform.current_tenant_id()
         AND (name ILIKE $1 OR customer_name ILIKE $1 OR code ILIKE $1)
       ORDER BY updated_at DESC LIMIT 5`, [pattern]);
    for (const row of projects.rows) add("project", row.id, row.name, `项目 · ${row.customer_name} · ${row.status}`, "#projects");

    const accounts = await db.query(
      `SELECT id, name, industry FROM crm.accounts
       WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL AND name ILIKE $1
       ORDER BY updated_at DESC LIMIT 5`, [pattern]);
    for (const row of accounts.rows) add("account", row.id, row.name, `客户 · ${row.industry ?? "未分类"}`, "#crm");

    const opps = await db.query(
      `SELECT id, name, customer_name, stage, amount_cents FROM crm.opportunities
       WHERE tenant_id = platform.current_tenant_id()
         AND (name ILIKE $1 OR customer_name ILIKE $1)
       ORDER BY updated_at DESC LIMIT 5`, [pattern]);
    for (const row of opps.rows) add("opportunity", row.id, row.name, `商机 · ${row.customer_name} · ${row.stage}`, "#crm");

    const people = await db.query(
      `SELECT id, display_name, primary_email FROM platform.people
       WHERE tenant_id = platform.current_tenant_id() AND status = 'active' AND deleted_at IS NULL
         AND (display_name ILIKE $1 OR primary_email ILIKE $1)
       ORDER BY display_name LIMIT 5`, [pattern]);
    for (const row of people.rows) add("person", row.id, row.display_name, row.primary_email ?? "员工", "#org");

    const knowledge = await db.query(
      `SELECT id, title, content_type FROM knowledge.items
       WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL
         AND (title ILIKE $1 OR content ILIKE $1)
       ORDER BY updated_at DESC LIMIT 5`, [pattern]);
    for (const row of knowledge.rows) add("knowledge", row.id, row.title, `知识 · ${row.content_type}`, "#knowledge");

    const contracts = await db.query(
      `SELECT id, title, contract_no, status FROM sales.contracts
       WHERE tenant_id = platform.current_tenant_id() AND (title ILIKE $1 OR contract_no ILIKE $1)
       ORDER BY updated_at DESC LIMIT 5`, [pattern]);
    for (const row of contracts.rows) add("contract", row.id, row.title, `合同 · ${row.contract_no} · ${row.status}`, "#contracts");

    const tasks = await db.query(
      `SELECT id, title, status FROM project.tasks
       WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL AND title ILIKE $1
       ORDER BY updated_at DESC LIMIT 5`, [pattern]);
    for (const row of tasks.rows) add("task", row.id, row.title, `任务 · ${row.status}`, "#projects");

    return hits.slice(0, 30);
  });

  json(res, 200, { items });
});

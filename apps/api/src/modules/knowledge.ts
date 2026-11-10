import { get, post, patch, del } from "../router.ts";
import { withTenant, page, uuid } from "../db.ts";
import { json } from "../router.ts";
import { readSession } from "../session.ts";
import { assertOwnerAccess } from "../record-access.ts";

// P2b 中文全文检索回退分词：
// postgres:16-alpine 无 zhparser/pg_jieba 等中文分词扩展，to_tsvector('simple') 会把连续
// 中文当成单个 token，plainto_tsquery 几乎无法命中子串。故检测到查询含 CJK 字符时，
// 在 tsvector 之外回退到 ILIKE 子串匹配，保证中文检索能真实命中内容（如实记录该限制）。
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;
function containsCJK(s: string): boolean {
  return CJK_PATTERN.test(s);
}

// ── 知识分类
get("/v1/knowledge/categories", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT c.*,
              (SELECT count(*) FROM knowledge.items ki WHERE ki.category_id = c.id AND ki.deleted_at IS NULL) AS item_count
       FROM knowledge.categories c
       WHERE c.tenant_id = platform.current_tenant_id()
       ORDER BY c.sort_order, c.name`
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/knowledge/categories", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const id = uuid();
    const base = String(body.name).toLowerCase().replace(/[\s\W]+/g, '-').replace(/^-+|-+$/g, '');
    const slug = body.slug as string | undefined ?? (base || 'cat') + '-' + id.slice(0, 8);
    const { rows } = await db.query(
      `INSERT INTO knowledge.categories (id, tenant_id, parent_id, name, slug, description, sort_order)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, slug) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()
       RETURNING *`,
      [id, body.parent_id ?? null, body.name, slug,
       body.description ?? null, body.sort_order ?? 0]
    );
    return rows[0];
  });
  json(res, 201, row);
});

// ── 知识条目
get("/v1/knowledge/items", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);

  const rows = await withTenant(identity, async (db) => {
    const hasSearch = Boolean(q.search);
    const search = hasSearch ? String(q.search) : "";
    const useIlike = hasSearch && containsCJK(search);
    // 相关性：非 CJK 用 ts_rank；CJK 回退时对标题命中给更高分，保证中文结果仍可排序
    const relevanceExpr = hasSearch
      ? useIlike
        ? `(CASE WHEN ki.title ILIKE '%'||$4||'%' THEN 2 ELSE 1 END) AS relevance,`
        : `ts_rank(to_tsvector('simple', coalesce(ki.title,'') || ' ' || coalesce(ki.content,'')), plainto_tsquery('simple', $4)) AS relevance,`
      : `0 AS relevance,`;
    const searchPredicate = hasSearch
      ? useIlike
        ? `AND (ki.title ILIKE '%'||$4||'%' OR ki.content ILIKE '%'||$4||'%')`
        : `AND to_tsvector('simple', coalesce(ki.title,'') || ' ' || coalesce(ki.content,'')) @@ plainto_tsquery('simple', $4)`
      : ``;
    const { rows } = await db.query(
      `SELECT ki.id, ki.title, ki.content_type, ki.source_type, ki.classification,
              ki.index_status, ki.view_count, ki.ai_reference_count, ki.tags,
              ki.created_at, ki.updated_at, ki.published_at,
              c.name AS category_name,
              pe.display_name AS owner_name,
              ${relevanceExpr}
              left(ki.content, 200) AS excerpt
       FROM knowledge.items ki
       LEFT JOIN knowledge.categories c ON c.tenant_id = ki.tenant_id AND c.id = ki.category_id
       LEFT JOIN platform.people pe ON pe.tenant_id = ki.tenant_id AND pe.id = ki.owner_person_id
       WHERE ki.tenant_id = platform.current_tenant_id() AND ki.deleted_at IS NULL
         AND ($1::text IS NULL OR ki.category_id::text = $1)
         AND ($2::text IS NULL OR ki.source_type = $2)
         AND ($3::text IS NULL OR ki.classification = $3)
         ${searchPredicate}
       ORDER BY ${hasSearch ? "relevance DESC," : ""} ki.updated_at DESC
       LIMIT $${hasSearch ? 5 : 4} OFFSET $${hasSearch ? 6 : 5}`,
      hasSearch
        ? [q.category ?? null, q.source_type ?? null, q.classification ?? null, search, limit, offset]
        : [q.category ?? null, q.source_type ?? null, q.classification ?? null, limit, offset]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

get("/v1/knowledge/items/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    await db.query(
      `UPDATE knowledge.items SET view_count = view_count + 1 WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND deleted_at IS NULL`,
      [ctx.params.id]
    );
    const { rows } = await db.query(
      `SELECT ki.*, c.name AS category_name, pe.display_name AS owner_name
       FROM knowledge.items ki
       LEFT JOIN knowledge.categories c ON c.tenant_id = ki.tenant_id AND c.id = ki.category_id
       LEFT JOIN platform.people pe ON pe.tenant_id = ki.tenant_id AND pe.id = ki.owner_person_id
       WHERE ki.tenant_id = platform.current_tenant_id() AND ki.id = $1 AND ki.deleted_at IS NULL`,
      [ctx.params.id]
    );
    return rows[0] ?? null;
  });

  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

post("/v1/knowledge/items", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.title) return json(res, 400, { error: "title_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO knowledge.items
         (id, tenant_id, category_id, title, content, content_type, source_type, source_url, feishu_doc_token, classification, owner_person_id, tags, index_status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [uuid(), (body.category_id as string) || null, body.title, body.content ?? null,
       body.content_type ?? 'markdown', body.source_type ?? 'manual',
       body.source_url ?? null, body.feishu_doc_token ?? null,
       body.classification ?? 'internal', body.owner_person_id ?? identity.personId,
       body.tags ?? [], 'pending']
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/knowledge/items/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["title","content","category_id","classification","tags","source_url","index_status","published_at"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    await assertOwnerAccess(db, identity, "knowledge.items", ctx.params.id);
    const { rows } = await db.query(
      `UPDATE knowledge.items SET ${sets.join(",")}, index_status = 'pending'
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} AND deleted_at IS NULL RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ── 版本历史
get("/v1/knowledge/items/:id/versions", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT v.*, pe.display_name AS author_name FROM knowledge.item_versions v
       JOIN platform.people pe ON pe.tenant_id = v.tenant_id AND pe.id = v.author_person_id
       WHERE v.tenant_id = platform.current_tenant_id() AND v.item_id = $1
       ORDER BY v.version_number DESC LIMIT 50`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

// ── 评分
post("/v1/knowledge/items/:id/ratings", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const rating = Number(body.rating);
  if (!rating || rating < 1 || rating > 5) return json(res, 400, { error: "rating_1_to_5_required", traceId: ctx.traceId });
  await withTenant(identity, async (db) => {
    await db.query(
      `UPDATE knowledge.items SET
         rating_avg = CASE WHEN rating_count = 0 THEN $1
                     ELSE ((rating_avg * rating_count) + $1) / (rating_count + 1) END,
         rating_count = rating_count + 1
       WHERE tenant_id = platform.current_tenant_id() AND id = $2`,
      [rating, ctx.params.id]
    );
  });
  json(res, 200, { rating, rated: true });
});

del("/v1/knowledge/items/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const deleted = await withTenant(identity, async (db) => {
    await assertOwnerAccess(db, identity, "knowledge.items", ctx.params.id);
    const { rowCount } = await db.query(
      `UPDATE knowledge.items SET deleted_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND deleted_at IS NULL`,
      [ctx.params.id]
    );
    return rowCount > 0;
  });
  if (!deleted) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, { success: true });
});

// ── 搜索
get("/v1/knowledge/search", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = ctx.url.searchParams.get("q") ?? "";
  if (!q.trim()) return json(res, 400, { error: "query_required", traceId: ctx.traceId });

  const rows = await withTenant(identity, async (db) => {
    const useIlike = containsCJK(q);
    const rankExpr = useIlike
      ? `(CASE WHEN ki.title ILIKE '%'||$1||'%' THEN 2 ELSE 1 END) AS rank,`
      : `ts_rank(to_tsvector('simple', coalesce(ki.title,'') || ' ' || coalesce(ki.content,'')), plainto_tsquery('simple', $1)) AS rank,`;
    const predicate = useIlike
      ? `AND (ki.title ILIKE '%'||$1||'%' OR ki.content ILIKE '%'||$1||'%')`
      : `AND to_tsvector('simple', coalesce(ki.title,'') || ' ' || coalesce(ki.content,'')) @@ plainto_tsquery('simple', $1)`;
    const snippetExpr = useIlike
      ? `left(ki.content, 160) AS snippet`
      : `ts_headline('simple', coalesce(ki.content,''), plainto_tsquery('simple', $1), 'MaxWords=40, MinWords=10') AS snippet`;
    const { rows } = await db.query(
      `SELECT ki.id, ki.title, ki.content_type, ki.source_type, ki.tags, ki.classification,
              ${rankExpr}
              ${snippetExpr}
       FROM knowledge.items ki
       WHERE ki.tenant_id = platform.current_tenant_id() AND ki.deleted_at IS NULL
         AND ki.index_status = 'indexed'
         ${predicate}
       ORDER BY rank DESC LIMIT 20`,
      [q]
    );
    return rows;
  });

  json(res, 200, { query: q, items: rows, results: rows });
});

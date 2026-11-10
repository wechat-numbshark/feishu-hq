import { get, patch, post, put } from "../router.ts";
import { withTenant, uuid } from "../db.ts";
import { json } from "../router.ts";
import { readSession } from "../session.ts";
import {
  assertCapability, resolveRoles, expandCapabilities, ensureRole,
  ROLE_LABELS, ROLE_DESCRIPTIONS, MANAGEABLE_ROLES
} from "../authz.ts";
import {
  getSettingDefinition, getSettingsSchema, normalizeSettingValue
} from "../settings-registry.ts";

// ─── 岗位权限（RBAC）─────────────────────────────────────────

// 当前用户的角色与能力（供前端按权限渲染）
get("/v1/me/capabilities", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const roles = await withTenant(identity, async (db) => {
    const bound = await resolveRoles(db, identity.personId);
    if (bound.length === 0 && identity.mode === "demo" && identity.role === "tenant_admin") return ["tenant_admin"];
    return bound.length > 0 ? bound : ["employee"];
  });
  json(res, 200, { roles, capabilities: expandCapabilities(roles) });
});

// 可分配角色目录
get("/v1/rbac/catalog", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  json(res, 200, {
    roles: MANAGEABLE_ROLES.map(code => ({ code, label: ROLE_LABELS[code], description: ROLE_DESCRIPTIONS[code] }))
  });
});

// 成员及其岗位角色（需 people.manage_roles，即企业管理员）
get("/v1/rbac/members", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const items = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "people.manage_roles");
    const { rows } = await db.query(
      `SELECT p.id, p.display_name, p.primary_email, p.avatar_url,
              COALESCE(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
       FROM platform.people p
       LEFT JOIN authz.role_bindings rb ON rb.tenant_id = p.tenant_id AND rb.subject_type = 'person'
             AND rb.subject_id = p.id AND rb.deleted_at IS NULL
       LEFT JOIN authz.roles r ON r.id = rb.role_id AND r.tenant_id = rb.tenant_id AND r.status = 'active'
       WHERE p.tenant_id = platform.current_tenant_id() AND p.status = 'active' AND p.deleted_at IS NULL
       GROUP BY p.id, p.display_name, p.primary_email, p.avatar_url
       ORDER BY p.display_name LIMIT 500`
    );
    return rows;
  });
  json(res, 200, { items });
});

// 设置某成员的岗位角色（需 people.manage_roles）
put("/v1/rbac/members/:personId/roles", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = (req.body ?? {}) as { roles?: unknown };
  const requested = Array.isArray(body.roles) ? body.roles.map(String) : [];
  const invalid = requested.filter(r => !(MANAGEABLE_ROLES as readonly string[]).includes(r));
  if (invalid.length) return json(res, 400, { error: "invalid_roles", detail: invalid, traceId: ctx.traceId });

  const result = await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "people.manage_roles");
    const { rows: pRows } = await db.query(
      `SELECT id FROM platform.people
       WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND deleted_at IS NULL`,
      [ctx.params.personId]
    );
    if (!pRows[0]) throw new Error("person_not_found");

    // 撤销现有可管理岗位角色绑定，再按请求重新授予
    await db.query(
      `UPDATE authz.role_bindings SET deleted_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND subject_type = 'person'
         AND subject_id = $1 AND deleted_at IS NULL
         AND role_id IN (SELECT id FROM authz.roles
                         WHERE tenant_id = platform.current_tenant_id() AND code = ANY($2))`,
      [ctx.params.personId, [...MANAGEABLE_ROLES]]
    );
    for (const code of requested) {
      const roleId = await ensureRole(db, code);
      await db.query(
        `INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason)
         SELECT $1, platform.current_tenant_id(), $2, 'person', $3, 'rbac management'
         WHERE NOT EXISTS (
           SELECT 1 FROM authz.role_bindings
           WHERE tenant_id = platform.current_tenant_id() AND role_id = $2
             AND subject_id = $3 AND deleted_at IS NULL)`,
        [uuid(), roleId, ctx.params.personId]
      );
    }
    // 角色变更后强制该成员重新登录，避免旧 Cookie 仍按旧角色放行。
    await db.query(
      `UPDATE platform.sessions SET revoked_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND person_id = $1 AND revoked_at IS NULL`,
      [ctx.params.personId]
    ).catch(() => undefined);
    await db.query(
      `INSERT INTO audit.audit_events
         (id, tenant_id, actor_id, action, resource_id, resource_type, outcome, change_summary, client_context, trace_id)
       VALUES ($1, platform.current_tenant_id(), $2, 'rbac.roles.updated', $3, 'person', 'success', $4::jsonb, '{}'::jsonb, $5)`,
      [uuid(), identity.personId, ctx.params.personId, JSON.stringify({ roles: requested }), ctx.traceId]
    ).catch(() => undefined);
    return { personId: ctx.params.personId, roles: requested };
  });
  json(res, 200, result);
});

// ─── 租户模块配置 ─────────────────────────────────────────

get("/v1/settings/:namespace", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const schema = getSettingsSchema(ctx.params.namespace);
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT key, value FROM platform.tenant_settings
       WHERE tenant_id = platform.current_tenant_id() AND namespace = $1`,
      [ctx.params.namespace]
    );
    return rows;
  });

  const settings: Record<string, unknown> = {};
  for (const r of rows) settings[r.key] = r.value;
  json(res, 200, { namespace: ctx.params.namespace, schema, settings });
});

patch("/v1/settings/:namespace", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(body)) {
    const def = getSettingDefinition(ctx.params.namespace, key);
    if (!def) {
      return json(res, 400, {
        error: "invalid_settings",
        invalidKeys: [key],
        traceId: ctx.traceId,
      });
    }
    try {
      updates.push([key, normalizeSettingValue(def, value)]);
    } catch {
      return json(res, 400, {
        error: "invalid_setting_value",
        key,
        traceId: ctx.traceId,
      });
    }
  }

  await withTenant(identity, async (db) => {
    await assertCapability(db, identity, "settings.manage");
    for (const [key, value] of updates) {
      await db.query(
        `INSERT INTO platform.tenant_settings (tenant_id, namespace, key, value, updated_at)
         VALUES (platform.current_tenant_id(), $1, $2, $3, now())
         ON CONFLICT (tenant_id, namespace, key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now()`,
        [ctx.params.namespace, key, JSON.stringify(value)]
      );
    }
  });

  json(res, 200, { ok: true, namespace: ctx.params.namespace });
});

// ─── IT 供应商 ────────────────────────────────────────────

get("/v1/it/vendors", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT v.*,
              count(a.id) FILTER (WHERE a.deleted_at IS NULL) AS asset_count
       FROM it.vendors v
       LEFT JOIN it.assets a ON a.tenant_id = v.tenant_id AND a.vendor_id = v.id
       WHERE v.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR v.status = $1)
         AND ($2::text IS NULL OR v.name ILIKE '%' || $2 || '%')
       GROUP BY v.id ORDER BY v.name`,
      [q.status ?? null, q.search ?? null]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/it/vendors", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO it.vendors
         (id, tenant_id, name, category, contact_name, contact_email, contact_phone,
          website, contract_value_cents, contract_start_date, contract_end_date,
          payment_terms, sla_response_hours, notes, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [uuid(), body.name, body.category ?? 'general',
       body.contact_name ?? null, body.contact_email ?? null, body.contact_phone ?? null,
       body.website ?? null,
       body.contract_value_cents ?? null, body.contract_start_date ?? null, body.contract_end_date ?? null,
       body.payment_terms ?? null, body.sla_response_hours ?? null, body.notes ?? null,
       body.status ?? 'active']
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/it/vendors/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["name","category","contact_name","contact_email","contact_phone","website",
                   "contract_value_cents","contract_start_date","contract_end_date",
                   "payment_terms","sla_response_hours","notes","status"];
  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (sets.length < 2) return json(res, 400, { error: "no_fields", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE it.vendors SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── IT 维护记录 ──────────────────────────────────────────

get("/v1/it/assets/:id/maintenance", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT mr.*, v.name AS vendor_name
       FROM it.maintenance_records mr
       LEFT JOIN it.vendors v ON v.tenant_id = mr.tenant_id AND v.id = mr.vendor_id
       WHERE mr.tenant_id = platform.current_tenant_id() AND mr.asset_id = $1
       ORDER BY mr.scheduled_date DESC`,
      [ctx.params.id]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/it/assets/:id/maintenance", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.scheduled_date) return json(res, 400, { error: "scheduled_date_required", traceId: ctx.traceId });

  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO it.maintenance_records
         (id, tenant_id, asset_id, maintenance_type, scheduled_date, performed_by, vendor_id, cost_cents, notes, status)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [uuid(), ctx.params.id,
       body.maintenance_type ?? 'routine', body.scheduled_date,
       body.performed_by ?? null, body.vendor_id ?? null,
       body.cost_cents ?? null, body.notes ?? null, 'scheduled']
    );
    return rows[0];
  });
  json(res, 201, row);
});

patch("/v1/it/maintenance/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const allowed = ["status","completed_date","performed_by","vendor_id","cost_cents","notes"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  allowed.forEach(k => { if (k in body) { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); } });
  if (!sets.length) return json(res, 400, { error: "no_fields", traceId: ctx.traceId });
  vals.push(ctx.params.id);
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `UPDATE it.maintenance_records SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

// ─── 组织架构 ─────────────────────────────────────────────

get("/v1/org-units", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT ou.id, ou.name, ou.parent_id, ou.type,
              count(e.id) FILTER (WHERE e.deleted_at IS NULL AND e.status != 'terminated') AS headcount
       FROM platform.org_units ou
       LEFT JOIN platform.employments e ON e.tenant_id = ou.tenant_id AND e.org_unit_id = ou.id
       WHERE ou.tenant_id = platform.current_tenant_id() AND ou.deleted_at IS NULL
       GROUP BY ou.id, ou.name, ou.parent_id, ou.type
       ORDER BY ou.name`,
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/org-units", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  if (!body.name) return json(res, 400, { error: "name_required", traceId: ctx.traceId });
  const row = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO platform.org_units (id, tenant_id, name, parent_id, type)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4) RETURNING *`,
      [uuid(), body.name, body.parent_id ?? null, body.type ?? 'department']
    );
    return rows[0];
  });
  json(res, 201, row);
});

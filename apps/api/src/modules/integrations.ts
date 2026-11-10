/**
 * 飞书集成模块
 * - GET  /v1/integrations/feishu/status   飞书配置状态
 * - POST /v1/integrations/feishu/sync     同步飞书组织到 platform.people
 * - GET  /v1/people                       人员搜索（人员选择器用）
 * - GET  /v1/people/:id                   单个人员详情
 */
import { get, post, del } from "../router.ts";
import { withTenant, page, uuid, type DbClient } from "../db.ts";
import { assertAnyCapability } from "../authz.ts";
import { json } from "../router.ts";
import { readSession, type SessionIdentity } from "../session.ts";
import { assertCapability, hasCapability, resolveRoles } from "../authz.ts";
import { feishuStatus, fetchFeishuOrganization } from "../feishu.ts";
import { resolveEmployeeFieldPolicy, applyEmployeeFieldPolicy, SALARY_FIELD } from "../data-domain.ts";

async function withAuthorizedTenant<T>(
  identity: SessionIdentity,
  capability: string,
  fn: (db: DbClient) => Promise<T>,
): Promise<T> {
  return withTenant(identity, async (db) => {
    await assertCapability(db, identity, capability);
    return fn(db);
  });
}

// ── 飞书状态
get("/v1/integrations/feishu/status", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  json(res, 200, feishuStatus());
});

// ── 飞书组织同步（管理员专用）
post("/v1/integrations/feishu/sync", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  if (identity.role !== "tenant_admin") return json(res, 403, { error: "administrator_required", traceId: ctx.traceId });

  if (!feishuStatus().configured) return json(res, 422, { error: "feishu_not_configured", traceId: ctx.traceId });

  let synced = 0, departments = 0;
  try {
    const org = await fetchFeishuOrganization();
    departments = org.departments.length;

    await withTenant(identity, async (db) => {
      // 同步部门到 platform.org_units
      for (const dept of org.departments) {
        if (!dept.open_department_id) continue;
        await db.query(
          `INSERT INTO platform.org_units
             (id, tenant_id, name, code, parent_id, feishu_open_department_id)
           SELECT $1, platform.current_tenant_id(), $2, $3, NULL, $4
           ON CONFLICT DO NOTHING`,
          [uuid(), dept.name, dept.open_department_id, dept.open_department_id]
        ).catch(() => {/* ignore if column doesn't exist yet */});
      }

      // 同步用户到 platform.people
      for (const user of org.users) {
        if (!user.open_id) continue;
        const avatar = user.avatar?.avatar_72 ?? user.avatar?.avatar_240 ?? null;
        const { rows } = await db.query(
          `INSERT INTO platform.people
             (id, tenant_id, feishu_open_id, feishu_union_id, feishu_user_id,
              display_name, primary_email, mobile, avatar_url, job_title,
              department_id, employment_status)
           VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'active')
           ON CONFLICT (feishu_open_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             primary_email = EXCLUDED.primary_email,
             mobile = EXCLUDED.mobile,
             avatar_url = EXCLUDED.avatar_url,
             job_title = EXCLUDED.job_title,
             feishu_union_id = EXCLUDED.feishu_union_id
           RETURNING id`,
          [uuid(), user.open_id, user.union_id ?? null, user.user_id ?? null,
           user.name, user.enterprise_email ?? user.email ?? null,
           user.mobile ?? null, avatar, user.job_title ?? null]
        );
        if (rows[0]) synced++;
      }
    });

    json(res, 200, { success: true, departments, people: synced });
  } catch (err: any) {
    json(res, 422, { error: err.message ?? "sync_failed", traceId: ctx.traceId });
  }
});

// ── 人员列表（含搜索，用于人员选择器）
get("/v1/people", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const q = Object.fromEntries(ctx.url.searchParams);
  const { limit, offset } = page(q);
  const search = q.search ?? q.q ?? null;

  const rows = await withTenant(identity, async (db) => {
    const { rows } = await db.query(
      `SELECT p.id, p.display_name, p.primary_email, p.avatar_url, p.job_title,
              p.mobile, p.feishu_open_id, p.employment_status, p.employee_no,
              ou.name AS org_unit_name,
              mgr.display_name AS manager_name
       FROM platform.people p
       LEFT JOIN platform.org_units ou ON ou.tenant_id = p.tenant_id AND ou.id = p.department_id
       LEFT JOIN platform.people mgr ON mgr.tenant_id = p.tenant_id AND mgr.id = p.direct_manager_id
       WHERE p.tenant_id = platform.current_tenant_id()
         AND ($1::text IS NULL OR p.display_name ILIKE '%' || $1 || '%'
                               OR p.primary_email ILIKE '%' || $1 || '%'
                               OR p.job_title ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR p.employment_status = $2)
       ORDER BY p.display_name
       LIMIT $3 OFFSET $4`,
      [search, q.status ?? null, limit, offset]
    );
    return rows;
  });

  json(res, 200, { items: rows, limit, offset });
});

// ── 单个人员详情
get("/v1/people/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const profile = await withTenant(identity, async (db) => {
    const [p, c, l] = await Promise.all([
      db.query(
        `SELECT p.*, ou.name AS org_unit_name, mgr.display_name AS manager_name
         FROM platform.people p
         LEFT JOIN platform.org_units ou ON ou.tenant_id = p.tenant_id AND ou.id = p.department_id
         LEFT JOIN platform.people mgr ON mgr.tenant_id = p.tenant_id AND mgr.id = p.direct_manager_id
         WHERE p.tenant_id = platform.current_tenant_id() AND p.id = $1`,
        [ctx.params.id]
      ),
      db.query(
        `SELECT * FROM hr.employee_contracts
         WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
         ORDER BY start_date DESC LIMIT 5`,
        [ctx.params.id]
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT * FROM hr.leave_requests
         WHERE tenant_id = platform.current_tenant_id() AND person_id = $1
           AND start_date >= now() - interval '180 days'
         ORDER BY start_date DESC LIMIT 10`,
        [ctx.params.id]
      ).catch(() => ({ rows: [] }))
    ]);
    const person = p.rows[0] ?? null;
    if (!person) return null;

    // 字段级策略：非 HR/本人隐藏薪资、脱敏手机号；非 HR 且非本人不返回合同与请假明细。
    const roles = await resolveRoles(db, identity.personId);
    const demoAdmin = roles.length === 0 && identity.mode === "demo" && identity.role === "tenant_admin";
    const isSelf = person.id === identity.personId;
    const canReadHr = isSelf || demoAdmin || hasCapability(roles, "hr.employee.read") || hasCapability(roles, "hr.manage");
    const policy = await resolveEmployeeFieldPolicy(db, identity, person.id);
    const base = applyEmployeeFieldPolicy(
      { ...person, contracts: canReadHr ? c.rows : [], leaves: canReadHr ? l.rows : [] },
      policy
    );
    if (!canReadHr) {
      delete (base as Record<string, unknown>).leaves;
      (base as Record<string, unknown>).contracts = [];
    }
    return base;
  });

  if (!profile) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, profile);
});


get("/v1/integrations/kodbox/instances", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const rows = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, COUNT(m.id) AS user_mappings_count,
              COUNT(d.id) AS directory_mappings_count,
              COUNT(p.id) AS permission_rules_count
       FROM integrations.kodbox_instances i
       LEFT JOIN integrations.kodbox_user_mappings m ON m.instance_id = i.id AND m.status = 'active'
       LEFT JOIN integrations.kodbox_directory_mappings d ON d.instance_id = i.id
       LEFT JOIN integrations.kodbox_permission_rules p ON p.instance_id = i.id AND p.is_active
       WHERE i.tenant_id = platform.current_tenant_id()
       GROUP BY i.id
       ORDER BY i.created_at DESC`,
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/integrations/kodbox/instances", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  const required = ["name", "base_url", "admin_username", "admin_password"];
  for (const field of required) {
    if (!body[field]) return json(res, 400, { error: `${field}_required`, traceId: ctx.traceId });
  }

  const row = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows } = await db.query(
      `INSERT INTO integrations.kodbox_instances
         (id, tenant_id, name, base_url, admin_username, admin_password_encrypted,
          db_host, db_port, db_name, db_user, db_password_encrypted, storage_path)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, pgp_sym_encrypt($5, current_setting('app.encryption_key')),
               $6, $7, $8, $9, pgp_sym_encrypt($10, current_setting('app.encryption_key')), $11)
       RETURNING id, tenant_id, name, base_url, admin_username, db_host, db_port, db_name, db_user, storage_path, status, created_at`,
      [
        uuid(), body.name, body.base_url, body.admin_username, body.admin_password,
        body.db_host ?? "postgres", body.db_port ?? 5432, body.db_name ?? "kodbox",
        body.db_user ?? "kodbox", body.db_password ?? "", body.storage_path ?? "/var/www/data"
      ]
    );
    return rows[0];
  });
  json(res, 201, row);
});

get("/v1/integrations/kodbox/instances/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const row = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, pgp_sym_decrypt(admin_password_encrypted, current_setting('app.encryption_key')) AS admin_password,
              pgp_sym_decrypt(db_password_encrypted, current_setting('app.encryption_key')) AS db_password
       FROM integrations.kodbox_instances i
       WHERE i.tenant_id = platform.current_tenant_id() AND i.id = $1`,
      [ctx.params.id]
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

patch("/v1/integrations/kodbox/instances/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const body = req.body as Record<string, unknown>;
  const allowed = ["name", "base_url", "admin_username", "admin_password", "db_host", "db_port", "db_name", "db_user", "db_password", "storage_path", "status"];
  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      if (k === "admin_password" || k === "db_password") {
        sets.push(`${k === "admin_password" ? "admin_password_encrypted" : "db_password_encrypted"} = pgp_sym_encrypt($${vals.length + 1}, current_setting('app.encryption_key'))`);
      } else {
        sets.push(`${k} = $${vals.length + 1}`);
      }
      vals.push(body[k]);
    }
  }
  if (sets.length < 2) return json(res, 400, { error: "no_fields", traceId: ctx.traceId });
  vals.push(ctx.params.id);

  const row = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows } = await db.query(
      `UPDATE integrations.kodbox_instances SET ${sets.join(",")} WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} RETURNING *`,
      vals
    );
    return rows[0] ?? null;
  });
  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

del("/v1/integrations/kodbox/instances/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    await db.query(
      `DELETE FROM integrations.kodbox_instances WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]
    );
  });
  json(res, 200, { success: true });
});

// ── Kodbox 文件操作
post("/v1/integrations/kodbox/files/upload", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as { instanceId: string; path: string; fileBase64: string; filename: string };
  if (!body.instanceId || !body.path || !body.fileBase64 || !body.filename) {
    return json(res, 400, { error: "instanceId,path,fileBase64,filename_required", traceId: ctx.traceId });
  }

  const result = await withAuthorizedTenant(identity, "knowledge.write", async (db) => {
    const { rows: inst } = await db.query(
      `SELECT * FROM integrations.kodbox_instances WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [body.instanceId]
    );
    if (!inst[0]) throw new Error("instance_not_found");

    // 这里调用 Kodbox 客户端上传，实际需要动态导入
    // 暂返回模拟结果，真实集成需在 worker 中处理大文件上传
    return { success: true, fid: "mock_fid", name: body.filename, path: body.path, size: body.fileBase64.length };
  });

  json(res, 200, result);
});

get("/v1/integrations/kodbox/files/download", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const q = Object.fromEntries(ctx.url.searchParams);
  if (!q.instanceId || !q.path) {
    return json(res, 400, { error: "instanceId,path_required", traceId: ctx.traceId });
  }

  const result = await withAuthorizedTenant(identity, "knowledge.read", async (db) => {
    const { rows: inst } = await db.query(
      `SELECT * FROM integrations.kodbox_instances WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [q.instanceId]
    );
    if (!inst[0]) throw new Error("instance_not_found");

    // 实际下载需在 worker 中处理流式响应
    return { success: true, downloadUrl: `${inst[0].base_url}/index.php?explorer/download&path=${encodeURIComponent(q.path)}` };
  });

  json(res, 200, result);
});

post("/v1/integrations/kodbox/files/share", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const body = req.body as { instanceId: string; path: string; password?: string; expireDays?: number; permission?: "read" | "write" | "read_write" };
  if (!body.instanceId || !body.path) {
    return json(res, 400, { error: "instanceId,path_required", traceId: ctx.traceId });
  }

  const result = await withAuthorizedTenant(identity, "integrations.manage", async (db) => {
    const { rows: inst } = await db.query(
      `SELECT * FROM integrations.kodbox_instances WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [body.instanceId]
    );
    if (!inst[0]) throw new Error("instance_not_found");

    // 记录分享到数据库
    const shareId = `share_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shareUrl = `${inst[0].base_url}/s/${shareId}`;
    await db.query(
      `INSERT INTO integrations.kodbox_shares
         (id, tenant_id, instance_id, file_metadata_id, share_id, share_url, password_hash, permission, expire_at, created_by_feishu_open_id)
       SELECT $1, platform.current_tenant_id(), $2, fm.id, $3, $4,
              CASE WHEN $5 IS NOT NULL THEN crypt($5, gen_salt('bf')) ELSE NULL END,
              $6, CASE WHEN $7 IS NOT NULL THEN now() + ($7 || ' days')::interval ELSE NULL END,
              $8`,
      [uuid(), body.instanceId, shareId, shareUrl, body.password ?? null, body.permission ?? "read", body.expireDays ?? null, identity.feishuOpenId ?? identity.personId]
    ).catch(() => undefined); // file_metadata 可能不存在，忽略错误

    return { share_id: shareId, share_url: shareUrl };
  });

  json(res, 200, result);
});

post("/v1/integrations/kodbox/files/revoke-share", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const body = req.body as { instanceId: string; shareId: string };
  if (!body.instanceId || !body.shareId) {
    return json(res, 400, { error: "instanceId,shareId_required", traceId: ctx.traceId });
  }

  await withAuthorizedTenant(identity, "integrations.manage", async (db) => {
    await db.query(
      `UPDATE integrations.kodbox_shares SET is_active = false, revoked_at = now(), revoked_by_feishu_open_id = $1
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $2 AND share_id = $3`,
      [identity.feishuOpenId ?? identity.personId, body.instanceId, body.shareId]
    );
  });

  json(res, 200, { success: true });
});

get("/v1/integrations/kodbox/files/list", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const q = Object.fromEntries(ctx.url.searchParams);
  if (!q.instanceId || !q.path) {
    return json(res, 400, { error: "instanceId,path_required", traceId: ctx.traceId });
  }

  const result = await withAuthorizedTenant(identity, "knowledge.read", async (db) => {
    const { rows: inst } = await db.query(
      `SELECT * FROM integrations.kodbox_instances WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [q.instanceId]
    );
    if (!inst[0]) throw new Error("instance_not_found");

    // 从数据库读取文件元数据
    const { rows } = await db.query(
      `SELECT * FROM integrations.kodbox_file_metadata
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $1 AND kodbox_path LIKE $2 AND deleted_at IS NULL
       ORDER BY is_directory DESC, name ASC LIMIT 200`,
      [q.instanceId, `${q.path}%`]
    );
    return { items: rows };
  });

  json(res, 200, result);
});

// ── Kodbox 权限映射
get("/v1/integrations/kodbox/permission-rules", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const q = Object.fromEntries(ctx.url.searchParams);
  if (!q.instanceId) return json(res, 400, { error: "instanceId_required", traceId: ctx.traceId });

  const rows = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM integrations.kodbox_permission_rules
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $1
       ORDER BY created_at DESC`,
      [q.instanceId]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

post("/v1/integrations/kodbox/permission-rules", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const body = req.body as { instanceId: string; feishu_department_id: string; kodbox_path: string; permission: string; inherit_to_children?: boolean };
  if (!body.instanceId || !body.feishu_department_id || !body.kodbox_path || !body.permission) {
    return json(res, 400, { error: "instanceId,feishu_department_id,kodbox_path,permission_required", traceId: ctx.traceId });
  }

  const row = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows } = await db.query(
      `INSERT INTO integrations.kodbox_permission_rules
         (id, tenant_id, instance_id, feishu_department_id, kodbox_path, permission, inherit_to_children, created_by_person_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, instance_id, feishu_department_id, kodbox_path) DO UPDATE
         SET permission = EXCLUDED.permission, inherit_to_children = EXCLUDED.inherit_to_children, updated_at = now()
       RETURNING *`,
      [uuid(), body.instanceId, body.feishu_department_id, body.kodbox_path, body.permission, body.inherit_to_children ?? true, identity.personId]
    );
    return rows[0];
  });
  json(res, 201, row);
});

del("/v1/integrations/kodbox/permission-rules/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    await db.query(
      `DELETE FROM integrations.kodbox_permission_rules WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [ctx.params.id]
    );
  });
  json(res, 200, { success: true });
});

// ── Kodbox 同步触发
post("/v1/integrations/kodbox/sync", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const body = req.body as { instanceId: string; syncType?: "full" | "delta" | "permission_only" | "user_only" | "directory_only" };
  if (!body.instanceId) return json(res, 400, { error: "instanceId_required", traceId: ctx.traceId });

  const syncType = body.syncType ?? "full";

  const result = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows: inst } = await db.query(
      `SELECT * FROM integrations.kodbox_instances WHERE tenant_id = platform.current_tenant_id() AND id = $1`,
      [body.instanceId]
    );
    if (!inst[0]) throw new Error("instance_not_found");

    // 创建同步任务记录
    const runId = uuid();
    await db.query(
      `INSERT INTO integrations.kodbox_sync_runs
         (id, tenant_id, instance_id, sync_type, status, triggered_by, triggered_by_feishu_open_id)
       VALUES ($1, platform.current_tenant_id(), $2, $3, 'running', 'manual', $4)`,
      [runId, body.instanceId, syncType, identity.feishuOpenId ?? identity.personId]
    );

    // 实际同步逻辑在 worker 中异步执行
    // 这里只返回任务 ID，前端轮询状态
    return { runId, status: "running", message: "同步任务已创建，worker 将在后台执行" };
  });

  json(res, 200, result);
});

get("/v1/integrations/kodbox/sync-runs", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const q = Object.fromEntries(ctx.url.searchParams);
  if (!q.instanceId) return json(res, 400, { error: "instanceId_required", traceId: ctx.traceId });

  const rows = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM integrations.kodbox_sync_runs
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $1
       ORDER BY started_at DESC LIMIT 50`,
      [q.instanceId]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

// ── Kodbox 权限审计
get("/v1/integrations/kodbox/permission-audit", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });

  const q = Object.fromEntries(ctx.url.searchParams);
  if (!q.instanceId) return json(res, 400, { error: "instanceId_required", traceId: ctx.traceId });

  const rows = await withAuthorizedTenant(identity, "settings.manage", async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM integrations.kodbox_permission_audit
       WHERE tenant_id = platform.current_tenant_id() AND instance_id = $1
       ORDER BY created_at DESC LIMIT 200`,
      [q.instanceId]
    );
    return rows;
  });
  json(res, 200, { items: rows });
});

// ── 更新人员信息
import { patch } from "../router.ts";
patch("/v1/people/:id", async (req, res, ctx) => {
  const identity = readSession(req.headers.cookie);
  if (!identity) return json(res, 401, { error: "authentication_required", traceId: ctx.traceId });
  const body = req.body as Record<string, unknown>;
  // 本人只能改联系类字段；人事字段必须 hr.manage；状态/上级变更禁止自助。
  const SELF_FIELDS = ["display_name", "mobile", "city", "gender", "avatar_url"];
  const allowed = [...SELF_FIELDS, "employee_no", "hire_date", "employment_status", "direct_manager_id"];
  const keys = allowed.filter((k) => k in body);
  if (!keys.length) return json(res, 400, { error: "no_fields_to_update", traceId: ctx.traceId });

  const isSelf = identity.personId === ctx.params.id;
  if (isSelf && keys.some((k) => !SELF_FIELDS.includes(k))) {
    return json(res, 403, { error: "permission_denied", traceId: ctx.traceId });
  }

  const row = await withTenant(identity, async (db) => {
    const target = await db.query(
      `SELECT id FROM platform.people WHERE tenant_id = platform.current_tenant_id() AND id = $1 AND deleted_at IS NULL`,
      [ctx.params.id]
    );
    if (target.rowCount === 0) return null;
    if (!isSelf) await assertAnyCapability(db, identity, ["hr.manage"]);

    const sets: string[] = [];
    const vals: unknown[] = [];
    keys.forEach((k) => { sets.push(`${k} = $${vals.length + 1}`); vals.push(body[k]); });
    vals.push(ctx.params.id);
    const { rows } = await db.query(
      `UPDATE platform.people SET ${sets.join(",")}, updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND id = $${vals.length} AND deleted_at IS NULL
       RETURNING id, display_name, primary_email, avatar_url`,
      vals
    );
    if (!rows[0]) return null;

    await db.query(
      `INSERT INTO audit.audit_events
         (id, tenant_id, actor_id, action, resource_id, resource_type, outcome, change_summary, client_context, trace_id)
       VALUES ($1, platform.current_tenant_id(), $2, 'people.update', $3, 'person', 'success', $4::jsonb, $5::jsonb, $6)`,
      [
        uuid(), `person:${identity.personId}`, ctx.params.id,
        JSON.stringify({ fields: keys }),
        JSON.stringify({ self: isSelf, ip: req.socket.remoteAddress ?? "" }),
        ctx.traceId,
      ]
    );
    return rows[0];
  });

  if (!row) return json(res, 404, { error: "not_found", traceId: ctx.traceId });
  json(res, 200, row);
});

import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import type { SessionIdentity } from "./session.ts";

const { Pool } = pg;
pg.types.setTypeParser(1082, (value: string) => value);
const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 8, idleTimeoutMillis: 30_000 }) : null;

const localWorkspace = {
  tenant: { id: "10000000-0000-4000-8000-000000000001", code: "demo-weilan", name: "未蓝科技", plan: "professional", memberCount: 28 },
  user: { id: "20000000-0000-4000-8000-000000000001", displayName: "总部管理员", email: "demo@feishu-hq.local", role: "tenant_admin" },
  snapshot: {
    date: new Date().toISOString().slice(0, 10),
    metrics: { monthly_receipts:{value:"¥ 1,284,600",change:"+18.6%",progress:71}, sales_pipeline:{value:"¥ 3,760,000",new_this_week:8}, project_health:{value:75,healthy:9,total:12}, headcount:{value:28,joined_this_month:2} },
    decisions: [{id:"decision-project-risk",level:"high",title:"华东交付项目延期风险",summary:"预计延期 6 天 · 项目负责人请求增派 2 人",action:"查看"},{id:"decision-discount",level:"medium",title:"销售折扣审批",summary:"远山零售 · 合同金额 ¥480,000 · 申请 12% 折扣",action:"审批"}],
    connections: [{key:"feishu",name:"飞书组织与协作",status:"awaiting_credentials",records:0},{key:"postgres",name:"总部数据平台",status:"connected",records:1284},{key:"nas",name:"可道云 NAS",status:"planned",records:421},{key:"ai",name:"企业 AI 网关",status:"configured",records:42}],
    modules: {projects:12,crm_opportunities:31,employees:28,finance_pending:3,it_assets:86,knowledge_items:1284}
  }
};

export async function getWorkspace(identity: SessionIdentity) {
  if (!pool) return localWorkspace;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [identity.tenantId]);
    await client.query("SET LOCAL ROLE hq_app");
    const result = await client.query(`
      SELECT
        t.id AS tenant_id,
        t.code AS tenant_code,
        t.name AS tenant_name,
        t.settings,
        p.id AS person_id,
        p.display_name,
        p.primary_email,
        s.snapshot_date,
        s.metrics,
        s.decisions,
        s.connections,
        s.modules
      FROM platform.tenants t
      JOIN platform.people p
        ON p.tenant_id = t.id AND p.id = $2 AND p.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT snapshot_date, metrics, decisions, connections, modules
        FROM platform.workspace_snapshots
        WHERE tenant_id = t.id
        ORDER BY snapshot_date DESC
        LIMIT 1
      ) s ON true
      WHERE t.id = $1 AND t.status = 'active'
    `, [identity.tenantId, identity.personId]);
    await client.query("COMMIT");
    if (result.rowCount !== 1) throw new Error("workspace_not_found");
    const row = result.rows[0];
    return {
      tenant: { id: row.tenant_id, code: row.tenant_code, name: row.tenant_name, plan: row.settings?.plan ?? "community", memberCount: row.settings?.member_count ?? 1 },
      user: { id: row.person_id, displayName: row.display_name, email: row.primary_email, role: identity.role },
      snapshot: { date: row.snapshot_date, metrics: row.metrics ?? {}, decisions: row.decisions ?? [], connections: row.connections ?? [], modules: row.modules ?? {} }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseHealth(): Promise<"connected" | "not_configured" | "unavailable"> {
  if (!pool) return "not_configured";
  try { await pool.query("SELECT 1"); return "connected"; } catch { return "unavailable"; }
}

export async function upsertFeishuLogin(user: any, allowFirstAdmin: boolean) {
  if (!pool) throw new Error("database_not_configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingIdentity = await client.query(`
      SELECT tenant_id, person_id FROM platform.external_identities
      WHERE provider = 'feishu' AND provider_tenant_id = $1 AND external_subject = $2 AND deleted_at IS NULL
      LIMIT 1
    `, [user.tenant_key, user.open_id]);

    let tenantId = existingIdentity.rows[0]?.tenant_id;
    let personId = existingIdentity.rows[0]?.person_id;
    let newTenant = false;

    if (!tenantId) {
      const tenantMatch = await client.query(`SELECT tenant_id FROM platform.external_identities WHERE provider = 'feishu' AND provider_tenant_id = $1 AND deleted_at IS NULL LIMIT 1`, [user.tenant_key]);
      tenantId = tenantMatch.rows[0]?.tenant_id;
      if (!tenantId) {
        if (!allowFirstAdmin) throw new Error("tenant_bootstrap_disabled");
        tenantId = randomUUID(); newTenant = true;
        const tenantCode = `feishu-${createHash("sha256").update(user.tenant_key).digest("hex").slice(0, 12)}`;
        await client.query(`INSERT INTO platform.tenants (id, code, name, deployment_mode, data_region, settings) VALUES ($1,$2,$3,'saas','cn','{"plan":"community","member_count":1,"feishu_connected":true}'::jsonb)`, [tenantId, tenantCode, user.tenant_name || "飞书企业"]);
      }
      personId = randomUUID();
      await client.query(`INSERT INTO platform.people (id, tenant_id, display_name, legal_name, primary_email, avatar_url) VALUES ($1,$2,$3,$3,$4,$5)`, [personId, tenantId, user.name, user.enterprise_email || user.email || null, user.avatar_url || null]);
      await client.query(`INSERT INTO platform.external_identities (id, tenant_id, person_id, provider, provider_tenant_id, external_subject, attributes, last_verified_at) VALUES ($1,$2,$3,'feishu',$4,$5,$6::jsonb,now())`, [randomUUID(), tenantId, personId, user.tenant_key, user.open_id, JSON.stringify({ union_id: user.union_id, user_id: user.user_id, avatar_url: user.avatar_url })]);
    } else {
      await client.query(`UPDATE platform.people SET display_name=$1, avatar_url=COALESCE($2,avatar_url), updated_at=now() WHERE tenant_id=$3 AND id=$4`, [user.name, user.avatar_url || null, tenantId, personId]);
      await client.query(`UPDATE platform.external_identities SET last_verified_at=now(), attributes=$1::jsonb WHERE tenant_id=$2 AND person_id=$3 AND provider='feishu'`, [JSON.stringify({ union_id: user.union_id, user_id: user.user_id, avatar_url: user.avatar_url }), tenantId, personId]);
    }

    const roleCode = newTenant ? "tenant_admin" : "employee";
    const role = await client.query(`INSERT INTO authz.roles (id, tenant_id, code, name, description, role_kind, status) VALUES ($1,$2,$3,$4,$5,$6,'active') ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [randomUUID(), tenantId, roleCode, newTenant ? "企业管理员" : "员工", "飞书登录自动建立", newTenant ? "platform" : "business"]);
    await client.query(`INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason) SELECT $1,$2,$3,'person',$4,'feishu oauth login' WHERE NOT EXISTS (SELECT 1 FROM authz.role_bindings WHERE tenant_id=$2 AND role_id=$3 AND subject_id=$4 AND deleted_at IS NULL)`, [randomUUID(), tenantId, role.rows[0].id, personId]);

    // 会话角色按实际角色绑定判定：拥有 tenant_admin 绑定即为管理员，
    // 否则为普通员工（其岗位角色由 authz.role_bindings 在请求时解析）。
    const adminCheck = await client.query(
      `SELECT 1 FROM authz.role_bindings rb
       JOIN authz.roles r ON r.id = rb.role_id AND r.tenant_id = rb.tenant_id
       WHERE rb.tenant_id = $1 AND rb.subject_type = 'person' AND rb.subject_id = $2
         AND rb.deleted_at IS NULL AND r.code = 'tenant_admin' AND r.status = 'active'
       LIMIT 1`,
      [tenantId, personId]
    );
    const effectiveRole: "tenant_admin" | "employee" = adminCheck.rowCount ? "tenant_admin" : "employee";

    if (newTenant) {
      const legalEntityId = randomUUID(); const rootOrgId = randomUUID();
      await client.query(`INSERT INTO platform.legal_entities (id,tenant_id,code,name) VALUES ($1,$2,'main',$3)`, [legalEntityId, tenantId, user.tenant_name || "飞书企业"]);
      await client.query(`INSERT INTO platform.org_units (id,tenant_id,legal_entity_id,code,name,type,source_of_truth) VALUES ($1,$2,$3,'feishu:0',$4,'company','feishu')`, [rootOrgId, tenantId, legalEntityId, user.tenant_name || "飞书企业"]);
      await client.query(`INSERT INTO platform.workspace_snapshots (id,tenant_id,snapshot_date,metrics,decisions,connections,modules) VALUES ($1,$2,CURRENT_DATE,'{}','[]',$3::jsonb,'{}')`, [randomUUID(), tenantId, JSON.stringify([{key:"feishu",name:"飞书组织与协作",status:"connected",records:1},{key:"postgres",name:"总部数据平台",status:"connected",records:1}])]);
    }
    await client.query("COMMIT");
    return { tenantId, personId, role: effectiveRole, feishuOpenId: user.open_id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined); throw error;
  } finally { client.release(); }
}

export async function getFeishuTenantKey(identity: SessionIdentity) {
  if (!pool) throw new Error("database_not_configured");
  const result = await pool.query(`SELECT provider_tenant_id FROM platform.external_identities WHERE tenant_id=$1 AND person_id=$2 AND provider='feishu' AND deleted_at IS NULL LIMIT 1`, [identity.tenantId, identity.personId]);
  return result.rows[0]?.provider_tenant_id as string | undefined;
}

export async function syncFeishuOrganization(identity: SessionIdentity, externalTenantKey: string, organization: { departments: any[]; users: any[] }, traceId: string) {
  if (!pool) throw new Error("database_not_configured");
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [identity.tenantId]);
    await client.query("SET LOCAL ROLE hq_app");
    await client.query(`INSERT INTO integration.sync_runs (id,tenant_id,provider,sync_type,status,trace_id) VALUES ($1,$2,'feishu','organization_full','running',$3)`, [runId, identity.tenantId, traceId]);
    const entity = await client.query(`SELECT id FROM platform.legal_entities WHERE tenant_id=$1 AND code='main' LIMIT 1`, [identity.tenantId]);
    const legalEntityId = entity.rows[0]?.id ?? randomUUID();
    if (!entity.rowCount) await client.query(`INSERT INTO platform.legal_entities (id,tenant_id,code,name) SELECT $1,$2,'main',name FROM platform.tenants WHERE id=$2`, [legalEntityId, identity.tenantId]);
    const orgIds = new Map<string,string>();
    const root = await client.query(`INSERT INTO platform.org_units (id,tenant_id,legal_entity_id,code,name,type,source_of_truth) SELECT $1,$2,$3,'feishu:0',name,'company','feishu' FROM platform.tenants WHERE id=$2 ON CONFLICT (tenant_id,code) DO UPDATE SET status='active',updated_at=now() RETURNING id`, [randomUUID(), identity.tenantId, legalEntityId]);
    orgIds.set("0", root.rows[0].id);
    const pending = [...organization.departments];
    while (pending.length) {
      let progressed = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const department = pending[index]; const externalId = department.open_department_id; const parentExternalId = department.parent_department_id || "0";
        if (!externalId || !orgIds.has(parentExternalId)) continue;
        const result = await client.query(`INSERT INTO platform.org_units (id,tenant_id,legal_entity_id,parent_id,code,name,type,status,source_of_truth) VALUES ($1,$2,$3,$4,$5,$6,'department','active','feishu') ON CONFLICT (tenant_id,code) DO UPDATE SET parent_id=EXCLUDED.parent_id,name=EXCLUDED.name,status='active',updated_at=now() RETURNING id`, [randomUUID(), identity.tenantId, legalEntityId, orgIds.get(parentExternalId), `feishu:${externalId}`, department.name || externalId]);
        orgIds.set(externalId, result.rows[0].id); pending.splice(index, 1); progressed = true;
      }
      if (!progressed) {
        for (const department of pending.splice(0)) {
          const result = await client.query(`INSERT INTO platform.org_units (id,tenant_id,legal_entity_id,parent_id,code,name,type,status,source_of_truth) VALUES ($1,$2,$3,$4,$5,$6,'department','active','feishu') ON CONFLICT (tenant_id,code) DO UPDATE SET parent_id=EXCLUDED.parent_id,name=EXCLUDED.name,status='active',updated_at=now() RETURNING id`, [randomUUID(), identity.tenantId, legalEntityId, orgIds.get("0"), `feishu:${department.open_department_id}`, department.name || department.open_department_id]);
          orgIds.set(department.open_department_id, result.rows[0].id);
        }
      }
    }
    for (const user of organization.users) {
      let person = await client.query(`SELECT person_id FROM platform.external_identities WHERE tenant_id=$1 AND provider='feishu' AND provider_tenant_id=$2 AND external_subject=$3 AND deleted_at IS NULL`, [identity.tenantId, externalTenantKey, user.open_id]);
      const personId = person.rows[0]?.person_id ?? randomUUID();
      if (!person.rowCount) {
        await client.query(`INSERT INTO platform.people (id,tenant_id,display_name,legal_name,primary_email,avatar_url,status) VALUES ($1,$2,$3,$3,$4,$5,$6)`, [personId, identity.tenantId, user.name || user.open_id, user.enterprise_email || user.email || null, user.avatar?.avatar_240 || null, user.status?.is_resigned ? "inactive" : "active"]);
        await client.query(`INSERT INTO platform.external_identities (id,tenant_id,person_id,provider,provider_tenant_id,external_subject,attributes,last_verified_at) VALUES ($1,$2,$3,'feishu',$4,$5,$6::jsonb,now())`, [randomUUID(), identity.tenantId, personId, externalTenantKey, user.open_id, JSON.stringify({ union_id:user.union_id,user_id:user.user_id,department_ids:user.department_ids })]);
      } else {
        await client.query(`UPDATE platform.people SET display_name=$1,primary_email=COALESCE($2,primary_email),avatar_url=COALESCE($3,avatar_url),status=$4,updated_at=now() WHERE tenant_id=$5 AND id=$6`, [user.name || user.open_id, user.enterprise_email || user.email || null, user.avatar?.avatar_240 || null, user.status?.is_resigned ? "inactive" : "active", identity.tenantId, personId]);
      }
      const primaryDepartment = user.department_ids?.[0] || "0"; const orgUnitId = orgIds.get(primaryDepartment) || orgIds.get("0");
      const employeeNumber = user.employee_no || user.user_id || user.open_id;
      await client.query(`INSERT INTO platform.employments (id,tenant_id,person_id,legal_entity_id,org_unit_id,employee_number,employment_type,status,start_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,employee_number) DO UPDATE SET person_id=EXCLUDED.person_id,org_unit_id=EXCLUDED.org_unit_id,status=EXCLUDED.status,updated_at=now()`, [randomUUID(), identity.tenantId, personId, legalEntityId, orgUnitId, employeeNumber, user.employee_type === 2 ? "intern" : "employee", user.status?.is_resigned ? "terminated" : "active", user.join_time ? new Date(user.join_time * 1000).toISOString().slice(0,10) : null]);
    }
    const snapshot = await client.query(`SELECT id,connections,modules FROM platform.workspace_snapshots WHERE tenant_id=$1 ORDER BY snapshot_date DESC LIMIT 1`, [identity.tenantId]);
    if (snapshot.rowCount) {
      const connections = (snapshot.rows[0].connections ?? []).filter((item:any) => item.key !== "feishu"); connections.unshift({key:"feishu",name:"飞书组织与协作",status:"connected",records:organization.users.length,last_synced_at:new Date().toISOString()});
      const modules = {...(snapshot.rows[0].modules ?? {}),employees:organization.users.length};
      await client.query(`UPDATE platform.workspace_snapshots SET connections=$1::jsonb,modules=$2::jsonb,updated_at=now() WHERE tenant_id=$3 AND id=$4`, [JSON.stringify(connections),JSON.stringify(modules),identity.tenantId,snapshot.rows[0].id]);
    }
    await client.query(`UPDATE integration.sync_runs SET status='completed',departments_seen=$1,people_seen=$2,completed_at=now() WHERE tenant_id=$3 AND id=$4`, [organization.departments.length,organization.users.length,identity.tenantId,runId]);
    await client.query(`INSERT INTO audit.audit_events (id,tenant_id,actor_id,action,outcome,change_summary,client_context,trace_id) VALUES ($1,$2,$3,'integration.feishu.organization_sync','success',$4::jsonb,'{}',$5)`, [randomUUID(),identity.tenantId,identity.personId,JSON.stringify({departments:organization.departments.length,people:organization.users.length}),traceId]);
    await client.query("COMMIT");
    return { runId, departments: organization.departments.length, people: organization.users.length };
  } catch (error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; }
  finally { client.release(); }
}

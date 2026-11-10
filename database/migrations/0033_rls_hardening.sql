-- 0033: 统一 RLS 强制与租户策略补齐
--
-- 背景：0003/0007/0008 的表已 FORCE RLS + WITH CHECK；但 0009/0011/0014 等
-- 后续迁移只 ENABLE 未 FORCE，策略也只有 USING 没有 WITH CHECK。应用以
-- hq_admin（表 owner）登录、事务内 SET LOCAL ROLE hq_app 时通常仍受 RLS 约束，
-- 但任何漏掉 SET ROLE 的路径（如 Webhook）会绕过。本迁移做三件事：
--   1) 对所有含 tenant_id 的业务表统一 ENABLE + FORCE RLS；
--   2) 对缺少 WITH CHECK 的表补一条 tenant_isolation_v2 策略；
--   3) 收紧 audit 表为只追加，并确保 hq_app 不具备 BYPASSRLS。
-- 只追加迁移，不修改历史文件。

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp%'
      AND n.nspname NOT LIKE 'pg_toast_temp%'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = n.nspname
          AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.schema_name, r.table_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = r.schema_name
        AND p.tablename = r.table_name
        AND p.with_check IS NOT NULL
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation_v2 ON %I.%I USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())',
        r.schema_name, r.table_name
      );
    END IF;
  END LOOP;
END
$$;

-- platform.tenants 没有 tenant_id 列，单独补一条 WITH CHECK 策略
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'platform' AND tablename = 'tenants' AND policyname = 'tenant_self_v2'
  ) THEN
    CREATE POLICY tenant_self_v2 ON platform.tenants
      USING (id = platform.current_tenant_id())
      WITH CHECK (id = platform.current_tenant_id());
  END IF;
END
$$;

-- 审计日志只追加：应用角色不能改/删
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hq_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON audit.audit_events FROM hq_app';
    EXECUTE 'ALTER ROLE hq_app NOBYPASSRLS NOSUPERUSER';
  END IF;
END
$$;

COMMIT;

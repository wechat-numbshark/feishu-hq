BEGIN;

-- 确保 pgcrypto 扩展可用（用于加密密码）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ═══════════════════════════════════════════════════════════
-- 0017 · Kodbox/可道云 连接器：文件元数据、权限映射、同步记录
-- ═══════════════════════════════════════════════════════════

-- 确保 integrations schema 存在
CREATE SCHEMA IF NOT EXISTS integrations;
GRANT USAGE ON SCHEMA integrations TO hq_app;

-- 1. Kodbox 实例配置
CREATE TABLE integrations.kodbox_instances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  name varchar(100) NOT NULL,
  base_url varchar(500) NOT NULL,
  admin_username varchar(100) NOT NULL,
  admin_password_encrypted text NOT NULL,
  db_host varchar(200),
  db_port integer DEFAULT 5432,
  db_name varchar(100),
  db_user varchar(100),
  db_password_encrypted text,
  storage_path varchar(500) DEFAULT '/var/www/data',
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','error','migrating')),
  last_sync_at timestamptz,
  last_sync_status varchar(20),
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);

-- 2. 飞书用户 ↔ Kodbox 用户映射
CREATE TABLE integrations.kodbox_user_mappings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES integrations.kodbox_instances(id) ON DELETE CASCADE,
  feishu_open_id varchar(200) NOT NULL,
  feishu_union_id varchar(200),
  feishu_user_id varchar(200),
  kodbox_user_id integer NOT NULL,
  kodbox_username varchar(200) NOT NULL,
  kodbox_home_path varchar(500) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','disabled','deleted')),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, instance_id, feishu_open_id),
  UNIQUE (tenant_id, instance_id, kodbox_user_id)
);

CREATE INDEX kodbox_user_mappings_feishu_idx
  ON integrations.kodbox_user_mappings (tenant_id, feishu_open_id);

-- 3. 飞书部门 ↔ Kodbox 目录映射
CREATE TABLE integrations.kodbox_directory_mappings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES integrations.kodbox_instances(id) ON DELETE CASCADE,
  feishu_department_id varchar(200) NOT NULL,
  feishu_department_name varchar(200) NOT NULL,
  parent_feishu_department_id varchar(200),
  kodbox_path varchar(500) NOT NULL,
  kodbox_fid varchar(200),
  permissions_applied boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, instance_id, feishu_department_id)
);

CREATE INDEX kodbox_directory_mappings_path_idx
  ON integrations.kodbox_directory_mappings (tenant_id, kodbox_path);

-- 4. 权限映射规则（部门 -> 目录权限）
CREATE TABLE integrations.kodbox_permission_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES integrations.kodbox_instances(id) ON DELETE CASCADE,
  feishu_department_id varchar(200) NOT NULL,
  kodbox_path varchar(500) NOT NULL,
  permission varchar(20) NOT NULL DEFAULT 'read_write'
    CHECK (permission IN ('read','write','read_write','admin')),
  inherit_to_children boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_by_person_id uuid REFERENCES platform.people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, instance_id, feishu_department_id, kodbox_path)
);

-- 5. 文件元数据（平台侧记录，不直接存文件内容）
CREATE TABLE integrations.kodbox_file_metadata (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES integrations.kodbox_instances(id) ON DELETE CASCADE,
  kodbox_fid varchar(200) NOT NULL,
  kodbox_path varchar(1000) NOT NULL,
  name varchar(500) NOT NULL,
  size bigint NOT NULL DEFAULT 0,
  mime_type varchar(200),
  file_hash varchar(64), -- SHA256
  is_directory boolean NOT NULL DEFAULT false,
  parent_fid varchar(200),
  owner_feishu_open_id varchar(200),
  owner_kodbox_user_id integer,
  classification varchar(20) NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public','internal','confidential','restricted')),
  index_status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending','indexing','indexed','failed','excluded')),
  last_indexed_at timestamptz,
  kodbox_created_at timestamptz,
  kodbox_updated_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, instance_id, kodbox_fid)
);

CREATE INDEX kodbox_file_metadata_path_idx
  ON integrations.kodbox_file_metadata (tenant_id, kodbox_path) WHERE deleted_at IS NULL;
CREATE INDEX kodbox_file_metadata_hash_idx
  ON integrations.kodbox_file_metadata (tenant_id, file_hash) WHERE file_hash IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX kodbox_file_metadata_owner_idx
  ON integrations.kodbox_file_metadata (tenant_id, owner_feishu_open_id) WHERE deleted_at IS NULL;

-- 6. 文件分享记录
CREATE TABLE integrations.kodbox_shares (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES integrations.kodbox_instances(id) ON DELETE CASCADE,
  file_metadata_id uuid NOT NULL REFERENCES integrations.kodbox_file_metadata(id) ON DELETE CASCADE,
  share_id varchar(200) NOT NULL,
  share_url varchar(1000) NOT NULL,
  password_hash varchar(200), -- bcrypt hash
  permission varchar(20) NOT NULL DEFAULT 'read'
    CHECK (permission IN ('read','write','read_write')),
  expire_at timestamptz,
  access_count integer NOT NULL DEFAULT 0,
  created_by_feishu_open_id varchar(200) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  revoked_by_feishu_open_id varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, instance_id, share_id)
);

CREATE INDEX kodbox_shares_file_idx
  ON integrations.kodbox_shares (tenant_id, file_metadata_id, is_active);
CREATE INDEX kodbox_shares_expire_idx
  ON integrations.kodbox_shares (tenant_id, expire_at) WHERE is_active AND expire_at IS NOT NULL;

-- 7. 权限变更审计日志
CREATE TABLE integrations.kodbox_permission_audit (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES integrations.kodbox_instances(id) ON DELETE CASCADE,
  action varchar(20) NOT NULL
    CHECK (action IN ('grant','revoke','modify','sync')),
  target_type varchar(20) NOT NULL
    CHECK (target_type IN ('user','department','file','share')),
  target_id varchar(200) NOT NULL, -- feishu_open_id, department_id, file_fid, share_id
  kodbox_path varchar(1000),
  old_permission varchar(20),
  new_permission varchar(20),
  operator_feishu_open_id varchar(200) NOT NULL,
  reason text,
  sync_batch_id uuid, -- 批量同步时的批次 ID
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kodbox_permission_audit_target_idx
  ON integrations.kodbox_permission_audit (tenant_id, target_type, target_id, created_at DESC);
CREATE INDEX kodbox_permission_audit_operator_idx
  ON integrations.kodbox_permission_audit (tenant_id, operator_feishu_open_id, created_at DESC);
CREATE INDEX kodbox_permission_audit_batch_idx
  ON integrations.kodbox_permission_audit (tenant_id, sync_batch_id) WHERE sync_batch_id IS NOT NULL;

-- 8. 同步任务记录
CREATE TABLE integrations.kodbox_sync_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES integrations.kodbox_instances(id) ON DELETE CASCADE,
  sync_type varchar(20) NOT NULL
    CHECK (sync_type IN ('full','delta','permission_only','user_only','directory_only')),
  status varchar(20) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed','partial')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  triggered_by varchar(20) NOT NULL DEFAULT 'auto'
    CHECK (triggered_by IN ('auto','manual','webhook','schedule')),
  triggered_by_feishu_open_id varchar(200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kodbox_sync_runs_instance_idx
  ON integrations.kodbox_sync_runs (tenant_id, instance_id, started_at DESC);

-- RLS 策略
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'integrations.kodbox_instances',
    'integrations.kodbox_user_mappings',
    'integrations.kodbox_directory_mappings',
    'integrations.kodbox_permission_rules',
    'integrations.kodbox_file_metadata',
    'integrations.kodbox_shares',
    'integrations.kodbox_permission_audit',
    'integrations.kodbox_sync_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())',
      tbl
    );
  END LOOP;
END;
$$;

-- 触发器
DO $$
DECLARE
  tbl text;
  trg text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'integrations.kodbox_instances',
    'integrations.kodbox_user_mappings',
    'integrations.kodbox_directory_mappings',
    'integrations.kodbox_permission_rules',
    'integrations.kodbox_file_metadata',
    'integrations.kodbox_shares'
  ] LOOP
    trg := replace(tbl, '.', '_') || '_touch';
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_row()',
      trg, tbl
    );
  END LOOP;
END;
$$;

-- 权限授予
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'integrations.kodbox_instances',
    'integrations.kodbox_user_mappings',
    'integrations.kodbox_directory_mappings',
    'integrations.kodbox_permission_rules',
    'integrations.kodbox_file_metadata',
    'integrations.kodbox_shares',
    'integrations.kodbox_permission_audit',
    'integrations.kodbox_sync_runs'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO hq_app', tbl);
  END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA integrations TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA integrations TO hq_app;

COMMIT;
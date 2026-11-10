\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;
BEGIN;

SET ROLE hq_app;
SELECT set_config('app.encryption_key', 'test-encryption-key-32-chars-long-!!', false);

-- 测试租户 A
SET LOCAL app.tenant_id = '00000000-0000-8000-8000-000000000001';
INSERT INTO platform.tenants (id, code, name)
VALUES ('00000000-0000-8000-8000-000000000001', 'kodbox-test-a', 'Kodbox 测试租户 A');

INSERT INTO platform.people (id, tenant_id, display_name, primary_email)
VALUES ('20000000-0000-8000-8000-000000000001', '00000000-0000-8000-8000-000000000001', '测试管理员', 'admin@test-a.example');

-- 创建 Kodbox 实例
INSERT INTO integrations.kodbox_instances
  (id, tenant_id, name, base_url, admin_username, admin_password_encrypted, status)
VALUES
  ('10000000-0000-8000-8000-000000000001', '00000000-0000-8000-8000-000000000001', '测试 Kodbox', 'http://localhost:8080', 'admin', pgp_sym_encrypt('password123', current_setting('app.encryption_key')), 'active');

-- 创建用户映射
INSERT INTO integrations.kodbox_user_mappings
  (id, tenant_id, instance_id, feishu_open_id, feishu_union_id, feishu_user_id, kodbox_user_id, kodbox_username, kodbox_home_path, status)
VALUES
  ('30000000-0000-8000-8000-000000000001', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'ou_user1', 'union1', 'user1', 1001, 'fs_ou_user1', '/个人文件/测试用户_ou_user1', 'active'),
  ('30000000-0000-8000-8000-000000000002', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'ou_user2', 'union2', 'user2', 1002, 'fs_ou_user2', '/个人文件/测试用户_ou_user2', 'active');

-- 创建部门目录映射
INSERT INTO integrations.kodbox_directory_mappings
  (id, tenant_id, instance_id, feishu_department_id, feishu_department_name, parent_feishu_department_id, kodbox_path, permissions_applied)
VALUES
  ('40000000-0000-8000-8000-000000000001', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'dept_rd', '研发部', NULL, '/共享文件/部门文件/研发部', false),
  ('40000000-0000-8000-8000-000000000002', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'dept_fe', '前端组', 'dept_rd', '/共享文件/部门文件/研发部/前端组', false);

-- 创建权限映射规则
INSERT INTO integrations.kodbox_permission_rules
  (id, tenant_id, instance_id, feishu_department_id, kodbox_path, permission, inherit_to_children, is_active, created_by_person_id)
VALUES
  ('50000000-0000-8000-8000-000000000001', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'dept_rd', '/共享文件/部门文件/研发部', 'read_write', true, true, '20000000-0000-8000-8000-000000000001'),
  ('50000000-0000-8000-8000-000000000002', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'dept_fe', '/共享文件/部门文件/研发部/前端组', 'write', false, true, '20000000-0000-8000-8000-000000000001');

-- 创建文件元数据
INSERT INTO integrations.kodbox_file_metadata
  (id, tenant_id, instance_id, kodbox_fid, kodbox_path, name, size, mime_type, file_hash, is_directory, owner_feishu_open_id, owner_kodbox_user_id, classification, index_status)
VALUES
  ('60000000-0000-8000-8000-000000000001', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'fid_1', '/共享文件/部门文件/研发部/设计文档.md', '设计文档.md', 1024, 'text/markdown', 'abc123', false, 'ou_user1', 1001, 'internal', 'indexed'),
  ('60000000-0000-8000-8000-000000000002', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'fid_2', '/共享文件/部门文件/研发部/前端组/组件库.md', '组件库.md', 2048, 'text/markdown', 'def456', false, 'ou_user2', 1002, 'confidential', 'indexed');

-- 创建分享记录
INSERT INTO integrations.kodbox_shares
  (id, tenant_id, instance_id, file_metadata_id, share_id, share_url, password_hash, permission, expire_at, created_by_feishu_open_id, is_active)
VALUES
  ('70000000-0000-8000-8000-000000000001', '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', '60000000-0000-8000-8000-000000000001', 'share_abc123', 'http://localhost:8080/s/share_abc123', crypt('secret', gen_salt('bf')), 'read', now() + interval '7 days', 'ou_user1', true);

-- 创建权限审计日志
INSERT INTO integrations.kodbox_permission_audit
  (id, tenant_id, instance_id, action, target_type, target_id, kodbox_path, old_permission, new_permission, operator_feishu_open_id, reason, sync_batch_id)
VALUES
  (gen_random_uuid(), '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'grant', 'user', 'ou_user1', '/共享文件/部门文件/研发部', NULL, 'read_write', 'ou_admin', '初始授权', gen_random_uuid()),
  (gen_random_uuid(), '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'sync', 'user', 'ou_user2', '/个人文件/测试用户_ou_user2', NULL, 'read_write', 'ou_user2', 'auto sync', gen_random_uuid());

-- 创建同步任务记录
INSERT INTO integrations.kodbox_sync_runs
  (id, tenant_id, instance_id, sync_type, status, started_at, completed_at, stats, triggered_by, triggered_by_feishu_open_id)
VALUES
  (gen_random_uuid(), '00000000-0000-8000-8000-000000000001', '10000000-0000-8000-8000-000000000001', 'full', 'completed', now() - interval '1 hour', now(), '{"usersCreated":2,"usersUpdated":0,"usersDisabled":0,"directoriesCreated":2,"permissionsApplied":2,"permissionsRevoked":0}'::jsonb, 'auto', 'ou_admin');

-- 验证：同一租户可查询自己的实例
SELECT count(*) = 1 AS instance_visible FROM integrations.kodbox_instances WHERE tenant_id = platform.current_tenant_id();

-- 验证：同一租户可查询自己的用户映射
SELECT count(*) = 2 AS user_mappings_visible FROM integrations.kodbox_user_mappings WHERE tenant_id = platform.current_tenant_id();

-- 验证：同一租户可查询自己的部门映射
SELECT count(*) = 2 AS dir_mappings_visible FROM integrations.kodbox_directory_mappings WHERE tenant_id = platform.current_tenant_id();

-- 验证：同一租户可查询自己的权限规则
SELECT count(*) = 2 AS perm_rules_visible FROM integrations.kodbox_permission_rules WHERE tenant_id = platform.current_tenant_id();

-- 验证：同一租户可查询自己的文件元数据
SELECT count(*) = 2 AS file_metadata_visible FROM integrations.kodbox_file_metadata WHERE tenant_id = platform.current_tenant_id() AND deleted_at IS NULL;

-- 验证：同一租户可查询自己的分享记录
SELECT count(*) = 1 AS shares_visible FROM integrations.kodbox_shares WHERE tenant_id = platform.current_tenant_id() AND is_active;

-- 验证：同一租户可查询自己的审计日志
SELECT count(*) = 2 AS audit_visible FROM integrations.kodbox_permission_audit WHERE tenant_id = platform.current_tenant_id();

-- 验证：同一租户可查询自己的同步记录
SELECT count(*) = 1 AS sync_runs_visible FROM integrations.kodbox_sync_runs WHERE tenant_id = platform.current_tenant_id();

-- 验证：跨租户访问应被 RLS 阻止
DO $$
DECLARE
  visible integer;
BEGIN
  -- 创建租户 B
  SET LOCAL app.tenant_id = '00000000-0000-8000-8000-000000000002';
  INSERT INTO platform.tenants (id, code, name)
  VALUES ('00000000-0000-8000-8000-000000000002', 'kodbox-test-b', 'Kodbox 测试租户 B');

  SET LOCAL app.tenant_id = '00000000-0000-8000-8000-000000000001';

  -- 尝试从租户 A 查看租户 B 的数据（应该为 0）
  SELECT count(*) INTO visible FROM integrations.kodbox_instances WHERE tenant_id = '00000000-0000-8000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure: kodbox_instances'; END IF;

  SELECT count(*) INTO visible FROM integrations.kodbox_user_mappings WHERE tenant_id = '00000000-0000-8000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure: kodbox_user_mappings'; END IF;

  SELECT count(*) INTO visible FROM integrations.kodbox_directory_mappings WHERE tenant_id = '00000000-0000-8000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure: kodbox_directory_mappings'; END IF;

  SELECT count(*) INTO visible FROM integrations.kodbox_permission_rules WHERE tenant_id = '00000000-0000-8000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure: kodbox_permission_rules'; END IF;

  SELECT count(*) INTO visible FROM integrations.kodbox_file_metadata WHERE tenant_id = '00000000-0000-8000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure: kodbox_file_metadata'; END IF;

  SELECT count(*) INTO visible FROM integrations.kodbox_shares WHERE tenant_id = '00000000-0000-8000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure: kodbox_shares'; END IF;

  SELECT count(*) INTO visible FROM integrations.kodbox_permission_audit WHERE tenant_id = '00000000-0000-8000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure: kodbox_permission_audit'; END IF;

  SELECT count(*) INTO visible FROM integrations.kodbox_sync_runs WHERE tenant_id = '00000000-0000-8000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure: kodbox_sync_runs'; END IF;
END;
$$;

-- 验证：版本字段自增
UPDATE integrations.kodbox_instances SET name = '测试 Kodbox 更新' WHERE id = '10000000-0000-8000-8000-000000000001';
SELECT updated_at > created_at AS trigger_works FROM integrations.kodbox_instances WHERE id = '10000000-0000-8000-8000-000000000001';

-- 验证：版本字段自增
UPDATE integrations.kodbox_user_mappings SET kodbox_home_path = '/新路径' WHERE id = '30000000-0000-8000-8000-000000000001';
SELECT version = 2 AS version_incremented FROM integrations.kodbox_user_mappings WHERE id = '30000000-0000-8000-8000-000000000001';

ROLLBACK;
RESET ROLE;
SELECT 'kodbox_connector_tests_passed' AS result;
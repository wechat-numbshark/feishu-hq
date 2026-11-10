-- 0035: 演示岗位的真实角色绑定
-- 目的：让"切换岗位"不只是换工作台标签，而是真正改变服务端能力与数据域。
-- 幂等：按 (tenant_id, role code) 与 (tenant, role, person) 去重。

BEGIN;

DO $$
DECLARE
  r record;
  v_role_id uuid;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('10000000-0000-4000-8000-000000000001'::uuid, '20000000-0000-4000-8000-000000000001'::uuid, 'tenant_admin'),
      ('d0000001-0000-4000-8000-000000000001'::uuid, 'd0000001-0000-4000-8000-00000000aa01'::uuid, 'tenant_admin'),
      ('d0000001-0000-4000-8000-000000000001'::uuid, 'd0000001-0000-4000-8000-00000000aa02'::uuid, 'manager'),
      ('d0000001-0000-4000-8000-000000000001'::uuid, 'd0000001-0000-4000-8000-00000000aa04'::uuid, 'manager'),
      ('d0000001-0000-4000-8000-000000000001'::uuid, 'd0000001-0000-4000-8000-00000000aa06'::uuid, 'manager'),
      ('d0000001-0000-4000-8000-000000000001'::uuid, 'd0000001-0000-4000-8000-00000000aa08'::uuid, 'finance_manager'),
      ('d0000002-0000-4000-8000-000000000001'::uuid, 'd0000002-0000-4000-8000-00000000bb01'::uuid, 'tenant_admin'),
      ('d0000002-0000-4000-8000-000000000001'::uuid, 'd0000002-0000-4000-8000-00000000bb02'::uuid, 'manager'),
      ('d0000002-0000-4000-8000-000000000001'::uuid, 'd0000002-0000-4000-8000-00000000bb03'::uuid, 'hr_manager'),
      ('d0000002-0000-4000-8000-000000000001'::uuid, 'd0000002-0000-4000-8000-00000000bb04'::uuid, 'finance_manager'),
      ('d0000002-0000-4000-8000-000000000001'::uuid, 'd0000002-0000-4000-8000-00000000bb05'::uuid, 'manager'),
      ('d0000002-0000-4000-8000-000000000001'::uuid, 'd0000002-0000-4000-8000-00000000bb06'::uuid, 'manager')
    ) AS m(tenant_id, person_id, role_code)
  LOOP
    SELECT id INTO v_role_id
    FROM authz.roles
    WHERE tenant_id = r.tenant_id AND code = r.role_code AND deleted_at IS NULL
    LIMIT 1;

    IF v_role_id IS NULL THEN
      INSERT INTO authz.roles (id, tenant_id, code, name, description, role_kind, status)
      VALUES (
        gen_random_uuid(), r.tenant_id, r.role_code,
        CASE r.role_code
          WHEN 'tenant_admin' THEN '企业管理员'
          WHEN 'hr_manager' THEN '人事管理员'
          WHEN 'finance_manager' THEN '财务管理员'
          WHEN 'manager' THEN '部门主管'
          ELSE '普通员工'
        END,
        '演示岗位预置角色',
        CASE WHEN r.role_code = 'tenant_admin' THEN 'platform' ELSE 'business' END,
        'active'
      )
      RETURNING id INTO v_role_id;
    END IF;

    INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason)
    SELECT gen_random_uuid(), r.tenant_id, v_role_id, 'person', r.person_id, 'demo persona seed'
    WHERE NOT EXISTS (
      SELECT 1 FROM authz.role_bindings rb
      WHERE rb.tenant_id = r.tenant_id AND rb.role_id = v_role_id
        AND rb.subject_type = 'person' AND rb.subject_id = r.person_id
        AND rb.deleted_at IS NULL
    );
  END LOOP;
END
$$;

COMMIT;

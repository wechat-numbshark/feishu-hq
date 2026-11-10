\set ON_ERROR_STOP on

BEGIN;

SET ROLE hq_app;

SET LOCAL app.tenant_id = '00000000-0000-7000-8000-000000000001';
INSERT INTO platform.tenants (id, code, name)
VALUES ('00000000-0000-7000-8000-000000000001', 'tenant-a', '租户 A');

INSERT INTO platform.legal_entities (id, tenant_id, code, name)
VALUES (
  '10000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000001',
  'A-CN',
  '租户 A 有限公司'
);

INSERT INTO platform.people (id, tenant_id, display_name, primary_email)
VALUES (
  '20000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000001',
  '甲员工',
  'employee-a@example.test'
);

INSERT INTO platform.org_units (
  id, tenant_id, legal_entity_id, code, name, type, manager_person_id, source_of_truth
) VALUES (
  '30000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000001',
  '10000000-0000-7000-8000-000000000001',
  'A-ROOT',
  '租户 A 总部',
  'company',
  '20000000-0000-7000-8000-000000000001',
  'feishu'
);

SET LOCAL app.tenant_id = '00000000-0000-7000-8000-000000000002';
INSERT INTO platform.tenants (id, code, name)
VALUES ('00000000-0000-7000-8000-000000000002', 'tenant-b', '租户 B');

INSERT INTO platform.legal_entities (id, tenant_id, code, name)
VALUES (
  '10000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000002',
  'B-CN',
  '租户 B 有限公司'
);

INSERT INTO platform.people (id, tenant_id, display_name, primary_email)
VALUES (
  '20000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000002',
  '乙员工',
  'employee-b@example.test'
);

SET LOCAL app.tenant_id = '00000000-0000-7000-8000-000000000001';

DO $$
DECLARE
  visible_people integer;
  visible_tenants integer;
BEGIN
  SELECT count(*) INTO visible_people FROM platform.people;
  SELECT count(*) INTO visible_tenants FROM platform.tenants;
  IF visible_people <> 1 THEN
    RAISE EXCEPTION 'RLS failure: expected 1 visible person, got %', visible_people;
  END IF;
  IF visible_tenants <> 1 THEN
    RAISE EXCEPTION 'RLS failure: expected 1 visible tenant, got %', visible_tenants;
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO platform.cost_centers (
      id, tenant_id, legal_entity_id, code, name
    ) VALUES (
      '40000000-0000-7000-8000-000000000001',
      '00000000-0000-7000-8000-000000000001',
      '10000000-0000-7000-8000-000000000002',
      'CROSS-TENANT',
      '不应创建'
    );
    RAISE EXCEPTION 'Cross-tenant foreign key unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO platform.people (id, tenant_id, display_name)
    VALUES (
      '20000000-0000-7000-8000-000000000099',
      '00000000-0000-7000-8000-000000000002',
      '越权写入'
    );
    RAISE EXCEPTION 'Cross-tenant RLS write unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

UPDATE platform.people
SET display_name = '甲员工（更新）'
WHERE id = '20000000-0000-7000-8000-000000000001';

DO $$
DECLARE
  person_version bigint;
BEGIN
  SELECT version INTO person_version
  FROM platform.people
  WHERE id = '20000000-0000-7000-8000-000000000001';
  IF person_version <> 2 THEN
    RAISE EXCEPTION 'Version trigger failure: expected 2, got %', person_version;
  END IF;
END;
$$;

INSERT INTO platform.resources (
  id, tenant_id, domain, resource_type, source_id, owner_person_id, owner_org_unit_id
) VALUES (
  '50000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000001',
  'platform',
  'person',
  '20000000-0000-7000-8000-000000000001',
  '20000000-0000-7000-8000-000000000001',
  '30000000-0000-7000-8000-000000000001'
);

INSERT INTO integration.external_mappings (
  id, tenant_id, resource_id, provider, external_tenant_id, external_type, external_id, sync_direction
) VALUES (
  '60000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000001',
  '50000000-0000-7000-8000-000000000001',
  'feishu',
  'feishu-tenant-a',
  'user',
  'ou_example',
  'from_external'
);

ROLLBACK;

RESET ROLE;

SELECT 'platform_core_tests_passed' AS result;

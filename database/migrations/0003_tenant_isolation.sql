BEGIN;

CREATE OR REPLACE FUNCTION platform.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION platform.touch_updated_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'platform.tenants',
    'platform.legal_entities',
    'platform.cost_centers',
    'platform.people',
    'platform.org_units',
    'platform.positions',
    'platform.employments',
    'platform.external_identities',
    'platform.resources',
    'platform.outbox_events',
    'integration.external_mappings',
    'authz.roles',
    'authz.policies',
    'authz.role_bindings',
    'authz.access_grants',
    'audit.authorization_decisions',
    'audit.audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;

CREATE POLICY tenant_self ON platform.tenants
  USING (id = platform.current_tenant_id())
  WITH CHECK (id = platform.current_tenant_id());

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'platform.legal_entities',
    'platform.cost_centers',
    'platform.people',
    'platform.org_units',
    'platform.positions',
    'platform.employments',
    'platform.external_identities',
    'platform.resources',
    'platform.outbox_events',
    'integration.external_mappings',
    'authz.roles',
    'authz.policies',
    'authz.role_bindings',
    'authz.access_grants',
    'audit.authorization_decisions',
    'audit.audit_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())',
      table_name
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name text;
  trigger_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'platform.tenants',
    'platform.legal_entities',
    'platform.cost_centers',
    'platform.people',
    'platform.org_units',
    'platform.positions',
    'platform.employments',
    'platform.external_identities',
    'platform.resources',
    'integration.external_mappings',
    'authz.roles',
    'authz.policies',
    'authz.role_bindings'
  ]
  LOOP
    trigger_name := replace(table_name, '.', '_') || '_touch';
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_row()',
      trigger_name,
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;


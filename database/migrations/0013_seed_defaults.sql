BEGIN;

-- Migration 0013: Seed default legal entity and org unit per tenant
-- ─────────────────────────────────────────────────────────────
-- Enables employee creation without requiring pre-configured org structure.
-- Each tenant gets one root legal entity ("总公司") and one root department ("全公司").

INSERT INTO platform.legal_entities (id, tenant_id, code, name, country_code, base_currency)
SELECT
  gen_random_uuid(),
  t.id,
  'HQ',
  t.name || ' 总公司',
  'CN',
  'CNY'
FROM platform.tenants t
WHERE t.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM platform.legal_entities le WHERE le.tenant_id = t.id
  );

INSERT INTO platform.org_units (id, tenant_id, legal_entity_id, code, name, type)
SELECT
  gen_random_uuid(),
  t.id,
  le.id,
  'CORP',
  t.name,
  'company'
FROM platform.tenants t
JOIN platform.legal_entities le ON le.tenant_id = t.id
WHERE t.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM platform.org_units ou WHERE ou.tenant_id = t.id AND ou.deleted_at IS NULL
  );

-- Grant access to hq_app for any tables that were missed
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.legal_entities TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.org_units TO hq_app;

COMMIT;

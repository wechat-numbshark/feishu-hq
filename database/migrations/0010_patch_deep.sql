BEGIN;

-- Migration 0010: Patch deep enhancement gaps

-- crm.accounts: add deleted_at, mobile, short_name already there
ALTER TABLE crm.accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- crm.contacts: add account_id (contacts can belong to account OR opportunity)
ALTER TABLE crm.contacts ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES crm.accounts(id) ON DELETE SET NULL;

-- it.license_assignments table
CREATE TABLE IF NOT EXISTS it.license_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES platform.tenants(id),
  license_id   uuid NOT NULL,
  person_id    uuid NOT NULL,
  assigned_by_person_id uuid,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, license_id, person_id)
);

ALTER TABLE it.license_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY license_assignments_tenant ON it.license_assignments
  USING (tenant_id = platform.current_tenant_id());
GRANT ALL ON it.license_assignments TO hq_app;

-- finance.budget_allocations: add unique constraint for ON CONFLICT
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'budget_allocations_unique_period_category'
  ) THEN
    ALTER TABLE finance.budget_allocations
      ADD CONSTRAINT budget_allocations_unique_period_category
      UNIQUE (tenant_id, org_unit_id, period_year, category);
  END IF;
END $$;

-- knowledge.items: ensure rating columns exist
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS rating_avg numeric(3,2) NOT NULL DEFAULT 0;
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS rating_count int NOT NULL DEFAULT 0;

-- knowledge.item_versions: ensure table exists
CREATE TABLE IF NOT EXISTS knowledge.item_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES platform.tenants(id),
  item_id         uuid NOT NULL,
  version_number  int NOT NULL DEFAULT 1,
  title           text NOT NULL,
  content         text,
  author_person_id uuid,
  change_summary  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE knowledge.item_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS item_versions_tenant ON knowledge.item_versions;
CREATE POLICY item_versions_tenant ON knowledge.item_versions
  USING (tenant_id = platform.current_tenant_id());
GRANT ALL ON knowledge.item_versions TO hq_app;

-- strategy.initiatives: ensure owner_person_id column and priority exist
ALTER TABLE strategy.initiatives ADD COLUMN IF NOT EXISTS owner_person_id uuid;
ALTER TABLE strategy.initiatives ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium';
ALTER TABLE strategy.initiatives ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE strategy.initiatives ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE strategy.initiatives ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMIT;

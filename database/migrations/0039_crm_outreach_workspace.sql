BEGIN;

-- 让 CRM 覆盖「发现潜客 → 首次联系 → 跟进 → 转商机」的真实销售前置流程。
ALTER TABLE crm.accounts
  ADD COLUMN IF NOT EXISTS country varchar(100),
  ADD COLUMN IF NOT EXISTS language varchar(20),
  ADD COLUMN IF NOT EXISTS public_email citext,
  ADD COLUMN IF NOT EXISTS email_source_url varchar(800),
  ADD COLUMN IF NOT EXISTS website_issue text,
  ADD COLUMN IF NOT EXISTS lead_source varchar(80),
  ADD COLUMN IF NOT EXISTS lead_status varchar(30) NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS priority varchar(20) NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS do_not_contact_reason text;

ALTER TABLE crm.accounts
  DROP CONSTRAINT IF EXISTS accounts_lead_status_check,
  ADD CONSTRAINT accounts_lead_status_check
    CHECK (lead_status IN ('new','contacted','replied','qualified','nurturing','disqualified','customer')),
  DROP CONSTRAINT IF EXISTS accounts_priority_check,
  ADD CONSTRAINT accounts_priority_check
    CHECK (priority IN ('low','medium','high','urgent'));

-- 跟进在形成商机前也必须能直接归属客户。
ALTER TABLE crm.activities
  ADD COLUMN IF NOT EXISTS account_id uuid;

ALTER TABLE crm.activities
  DROP CONSTRAINT IF EXISTS activities_account_fk,
  ADD CONSTRAINT activities_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES crm.accounts(tenant_id, id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS accounts_follow_up_idx
  ON crm.accounts (tenant_id, do_not_contact, next_follow_up_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS accounts_lead_status_idx
  ON crm.accounts (tenant_id, lead_status, priority, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS activities_account_idx
  ON crm.activities (tenant_id, account_id, occurred_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_public_email_unique_idx
  ON crm.accounts (tenant_id, lower(public_email::text))
  WHERE public_email IS NOT NULL AND deleted_at IS NULL;

COMMIT;

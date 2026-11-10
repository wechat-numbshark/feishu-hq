BEGIN;

-- Migration 0012: Fix hq_app grants for tables created in 0011
-- ─────────────────────────────────────────────────────────────
-- 0011 created new tables but missed granting hq_app access.
-- The API role (SET LOCAL ROLE hq_app) cannot read/write them otherwise.

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.tenant_settings TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON hr.leave_policies TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON hr.job_positions TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON it.vendors TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON it.maintenance_records TO hq_app;

COMMIT;

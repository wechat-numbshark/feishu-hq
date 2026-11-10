BEGIN;

-- 外联邮件需要可核验地记录实际收件人、主题、供应商 Message ID 与投递状态。
ALTER TABLE crm.activities
  ADD COLUMN IF NOT EXISTS email_recipient citext,
  ADD COLUMN IF NOT EXISTS email_subject varchar(500),
  ADD COLUMN IF NOT EXISTS external_message_id varchar(800),
  ADD COLUMN IF NOT EXISTS delivery_status varchar(30);

ALTER TABLE crm.activities
  DROP CONSTRAINT IF EXISTS activities_delivery_status_check,
  ADD CONSTRAINT activities_delivery_status_check
    CHECK (delivery_status IS NULL OR delivery_status IN
      ('draft','sent','delivered','bounced','replied','unsubscribed','failed'));

CREATE UNIQUE INDEX IF NOT EXISTS activities_external_message_id_unique_idx
  ON crm.activities (tenant_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

COMMIT;

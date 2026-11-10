-- 0034: 站内通知中心（审批/任务/风险等统一收件箱）
-- 与飞书消息互补：飞书是触达渠道，站内通知是可追溯、可已读的业务收件箱。

BEGIN;

CREATE TABLE IF NOT EXISTS platform.notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL,
  kind varchar(40) NOT NULL,
  title varchar(200) NOT NULL,
  body text,
  link varchar(300),
  dedupe_key varchar(200),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, person_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS notifications_person_idx
  ON platform.notifications (tenant_id, person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON platform.notifications (tenant_id, person_id, read_at)
  WHERE read_at IS NULL;

ALTER TABLE platform.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform.notifications;
CREATE POLICY tenant_isolation ON platform.notifications
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON platform.notifications TO hq_app;

COMMIT;

-- 0038: 服务端会话表（可撤销 / 登出全部设备 / 角色变更强制重登）
-- 之前会话是纯 HMAC，无法撤销；本表让每次请求可以校验 jti 是否仍有效。

BEGIN;

CREATE TABLE IF NOT EXISTS platform.sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  person_id uuid NOT NULL,
  user_agent varchar(300),
  ip varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_person_idx
  ON platform.sessions (tenant_id, person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_active_idx
  ON platform.sessions (tenant_id, id)
  WHERE revoked_at IS NULL;

ALTER TABLE platform.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform.sessions;
CREATE POLICY tenant_isolation ON platform.sessions
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON platform.sessions TO hq_app;

COMMIT;

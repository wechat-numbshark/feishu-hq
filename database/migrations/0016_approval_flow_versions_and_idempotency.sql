BEGIN;

-- Migration 0016: 审批引擎版本快照、行锁、幂等
CREATE TABLE IF NOT EXISTS platform.approval_flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  flow_code text NOT NULL,
  instance_id uuid NOT NULL REFERENCES platform.approval_instances(id) ON DELETE CASCADE,
  snapshot_jsonb jsonb NOT NULL DEFAULT '{}',
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, instance_id)
);
ALTER TABLE platform.approval_flow_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_flow_versions_tenant ON platform.approval_flow_versions;
CREATE POLICY approval_flow_versions_tenant ON platform.approval_flow_versions
  USING (tenant_id = platform.current_tenant_id());
CREATE INDEX IF NOT EXISTS approval_flow_versions_instance_idx
  ON platform.approval_flow_versions (instance_id);

-- 幂等键：防止同一请求重复提交
CREATE TABLE IF NOT EXISTS platform.approval_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  requester_person_id uuid NOT NULL,
  flow_code text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
ALTER TABLE platform.approval_idempotency_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_idempotency_tenant ON platform.approval_idempotency_keys;
CREATE POLICY approval_idempotency_tenant ON platform.approval_idempotency_keys
  USING (tenant_id = platform.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.approval_flow_versions TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.approval_idempotency_keys TO hq_app;

COMMIT;

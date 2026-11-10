BEGIN;

CREATE TABLE platform.workspace_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  connections jsonb NOT NULL DEFAULT '[]'::jsonb,
  modules jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, snapshot_date),
  CHECK (jsonb_typeof(metrics) = 'object'),
  CHECK (jsonb_typeof(decisions) = 'array'),
  CHECK (jsonb_typeof(connections) = 'array'),
  CHECK (jsonb_typeof(modules) = 'object')
);

CREATE INDEX workspace_snapshots_latest_idx
  ON platform.workspace_snapshots (tenant_id, snapshot_date DESC);

ALTER TABLE platform.workspace_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.workspace_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON platform.workspace_snapshots
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

CREATE TRIGGER platform_workspace_snapshots_touch
  BEFORE UPDATE ON platform.workspace_snapshots
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_row();

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.workspace_snapshots TO hq_app;

COMMIT;

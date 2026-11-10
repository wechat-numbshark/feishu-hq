BEGIN;

CREATE TABLE integration.sync_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider varchar(50) NOT NULL,
  sync_type varchar(50) NOT NULL,
  status varchar(30) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  departments_seen integer NOT NULL DEFAULT 0,
  people_seen integer NOT NULL DEFAULT 0,
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  trace_id varchar(200) NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE INDEX sync_runs_latest_idx ON integration.sync_runs (tenant_id, provider, started_at DESC);
ALTER TABLE integration.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration.sync_runs
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON integration.sync_runs TO hq_app;

COMMIT;

-- 0029 · 个人全景与 AI 治理（docs/19）：AI 定时任务 + KR 联动 + metric_source 扩展
BEGIN;

-- ── 1. AI 定时任务（主动式 AI：worker 到点以本人身份执行受控工具，全程审计）
CREATE TABLE platform.ai_schedules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL,
  name varchar(200) NOT NULL,
  tool_name varchar(100) NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  interval_minutes integer NOT NULL CHECK (interval_minutes BETWEEN 5 AND 43200),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_job_id uuid,
  run_count integer NOT NULL DEFAULT 0,
  max_runs integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES platform.people(tenant_id, id) ON DELETE CASCADE
);

-- ── 2. KR 联动（项目/里程碑/需求）
CREATE TABLE strategy.kr_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  kr_id uuid NOT NULL,
  link_type varchar(20) NOT NULL CHECK (link_type IN ('project','milestone','requirement')),
  link_id uuid NOT NULL,
  weight integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kr_id, link_type, link_id),
  FOREIGN KEY (tenant_id, kr_id) REFERENCES strategy.key_results(tenant_id, id) ON DELETE CASCADE
);

-- ── 3. metric_source 扩展 'project'（重建 CHECK）
ALTER TABLE strategy.key_results DROP CONSTRAINT IF EXISTS key_results_metric_source_check;
ALTER TABLE strategy.key_results ADD CONSTRAINT key_results_metric_source_check
  CHECK (metric_source IN ('none','mrr','otd','yield','project'));

-- ── RLS + 授权
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform.ai_schedules','strategy.kr_links']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO hq_app', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_schedules_due ON platform.ai_schedules (tenant_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_kr_links_kr ON strategy.kr_links (tenant_id, kr_id);

COMMIT;

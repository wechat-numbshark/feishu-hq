-- 0043: AI 治理底座（租户级模型配置 / 每日用量 / 月度预算 / 引用）
BEGIN;

CREATE TABLE IF NOT EXISTS platform.ai_provider_settings (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai','anthropic')),
  base_url text NOT NULL,
  model text NOT NULL,
  api_key_ciphertext text,
  api_key_hint text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform.ai_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.ai_provider_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_provider_settings_tenant ON platform.ai_provider_settings;
CREATE POLICY ai_provider_settings_tenant ON platform.ai_provider_settings
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

CREATE TABLE IF NOT EXISTS platform.ai_usage_daily (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  person_id uuid NOT NULL,
  usage_date date NOT NULL,
  requests int NOT NULL DEFAULT 0,
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, person_id, usage_date)
);
ALTER TABLE platform.ai_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.ai_usage_daily FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_usage_daily_tenant ON platform.ai_usage_daily;
CREATE POLICY ai_usage_daily_tenant ON platform.ai_usage_daily
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

CREATE TABLE IF NOT EXISTS platform.ai_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  person_id uuid,
  monthly_tokens bigint NOT NULL DEFAULT 0,
  monthly_cost_micros bigint NOT NULL DEFAULT 0,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_budgets_scope_uidx
  ON platform.ai_budgets (tenant_id, COALESCE(person_id, '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE platform.ai_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.ai_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_budgets_tenant ON platform.ai_budgets;
CREATE POLICY ai_budgets_tenant ON platform.ai_budgets
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

ALTER TABLE platform.ai_messages
  ADD COLUMN IF NOT EXISTS citations jsonb NOT NULL DEFAULT '[]'::jsonb;

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.ai_provider_settings TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.ai_usage_daily TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.ai_budgets TO hq_app;

COMMIT;

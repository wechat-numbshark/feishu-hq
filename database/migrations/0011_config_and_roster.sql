BEGIN;

-- Migration 0011: 模块配置表、员工管理补强、IT供应商
-- ─────────────────────────────────────────────────────────────

-- ── 租户级模块配置（Key-Value） ──────────────────────────────
CREATE TABLE IF NOT EXISTS platform.tenant_settings (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  namespace  text NOT NULL,   -- 'hr' | 'it' | 'finance' | 'crm' | 'projects'
  key        text NOT NULL,
  value      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespace, key)
);
ALTER TABLE platform.tenant_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_settings_rls ON platform.tenant_settings;
CREATE POLICY tenant_settings_rls ON platform.tenant_settings
  USING (tenant_id = platform.current_tenant_id());

-- ── HR 请假政策 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.leave_policies (
  tenant_id                uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  leave_type               text NOT NULL,
  annual_entitlement_days  numeric(5,1) NOT NULL DEFAULT 0,
  carry_over_max_days      numeric(5,1) NOT NULL DEFAULT 0,
  min_notice_days          integer NOT NULL DEFAULT 0,
  allow_half_day           boolean NOT NULL DEFAULT true,
  requires_approval        boolean NOT NULL DEFAULT true,
  max_consecutive_days     integer,
  description              text,
  is_active                boolean NOT NULL DEFAULT true,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, leave_type)
);
ALTER TABLE hr.leave_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leave_policies_tenant ON hr.leave_policies;
CREATE POLICY leave_policies_tenant ON hr.leave_policies
  USING (tenant_id = platform.current_tenant_id());

-- 为所有已有租户写入默认假期政策
INSERT INTO hr.leave_policies (tenant_id, leave_type, annual_entitlement_days, carry_over_max_days, description)
SELECT id, 'annual',      15, 5,  '年假' FROM platform.tenants WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO hr.leave_policies (tenant_id, leave_type, annual_entitlement_days, carry_over_max_days, description)
SELECT id, 'sick',        12, 0, '病假' FROM platform.tenants WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO hr.leave_policies (tenant_id, leave_type, annual_entitlement_days, carry_over_max_days, description)
SELECT id, 'personal',    3, 0, '事假（不带薪）' FROM platform.tenants WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO hr.leave_policies (tenant_id, leave_type, annual_entitlement_days, carry_over_max_days, description)
SELECT id, 'marriage',    3, 0, '婚假' FROM platform.tenants WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO hr.leave_policies (tenant_id, leave_type, annual_entitlement_days, carry_over_max_days, description)
SELECT id, 'paternity',   3, 0, '陪产假' FROM platform.tenants WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO hr.leave_policies (tenant_id, leave_type, annual_entitlement_days, carry_over_max_days, description)
SELECT id, 'compensatory', 0, 30, '调休假（按实际加班生成）' FROM platform.tenants WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
INSERT INTO hr.leave_policies (tenant_id, leave_type, annual_entitlement_days, carry_over_max_days, description)
SELECT id, 'bereavement', 3, 0, '丧假' FROM platform.tenants WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- ── HR 职位表（公司内部职级/岗位体系） ────────────────────────
CREATE TABLE IF NOT EXISTS hr.job_positions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  title             text NOT NULL,
  code              text,
  level             text,               -- P1~P8, M1~M5, D, VP, C
  department        text,
  description       text,
  salary_min_cents  bigint,
  salary_max_cents  bigint,
  headcount_budget  integer DEFAULT 1,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hr.job_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_positions_tenant ON hr.job_positions;
CREATE POLICY job_positions_tenant ON hr.job_positions
  USING (tenant_id = platform.current_tenant_id());

-- ── IT 供应商目录 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS it.vendors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  category              text DEFAULT 'general',  -- hardware, software, saas, network, services
  contact_name          text,
  contact_email         text,
  contact_phone         text,
  website               text,
  contract_value_cents  bigint,
  contract_start_date   date,
  contract_end_date     date,
  payment_terms         text,
  sla_response_hours    integer,
  notes                 text,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','blacklisted')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
ALTER TABLE it.vendors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendors_tenant ON it.vendors;
CREATE POLICY vendors_tenant ON it.vendors
  USING (tenant_id = platform.current_tenant_id());

-- ── IT 资产维护记录 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS it.maintenance_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  asset_id          uuid NOT NULL REFERENCES it.assets(id) ON DELETE CASCADE,
  maintenance_type  text NOT NULL DEFAULT 'routine'
                      CHECK (maintenance_type IN ('routine','repair','inspection','upgrade','replacement')),
  scheduled_date    date NOT NULL,
  completed_date    date,
  performed_by      text,
  vendor_id         uuid REFERENCES it.vendors(id) ON DELETE SET NULL,
  cost_cents        bigint,
  notes             text,
  status            text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','completed','cancelled','overdue')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE it.maintenance_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maintenance_records_tenant ON it.maintenance_records;
CREATE POLICY maintenance_records_tenant ON it.maintenance_records
  USING (tenant_id = platform.current_tenant_id());

-- ── 扩展 it.assets：供应商引用、保修、下次维护 ───────────────
ALTER TABLE it.assets ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES it.vendors(id) ON DELETE SET NULL;
ALTER TABLE it.assets ADD COLUMN IF NOT EXISTS warranty_expires_at date;
ALTER TABLE it.assets ADD COLUMN IF NOT EXISTS next_maintenance_date date;

-- ── 扩展 platform.employments：更多人事字段 ──────────────────
ALTER TABLE platform.employments ADD COLUMN IF NOT EXISTS probation_end_date date;
ALTER TABLE platform.employments ADD COLUMN IF NOT EXISTS termination_date date;
ALTER TABLE platform.employments ADD COLUMN IF NOT EXISTS termination_reason text;
ALTER TABLE platform.employments ADD COLUMN IF NOT EXISTS work_location text;
ALTER TABLE platform.employments ADD COLUMN IF NOT EXISTS emergency_contact_name text;
ALTER TABLE platform.employments ADD COLUMN IF NOT EXISTS emergency_contact_phone text;
ALTER TABLE platform.employments ADD COLUMN IF NOT EXISTS notes text;

COMMIT;

BEGIN;

-- 0009_deep_enhancements.sql
-- 深度增强：飞书人员字段、审批追踪、项目/HR/财务细化

-- ────────────────────────────────────────────────────────────
-- 1. platform.people 增加飞书身份 & 人事字段
-- ────────────────────────────────────────────────────────────
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS feishu_open_id varchar(100) UNIQUE;
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS feishu_union_id varchar(100);
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS feishu_user_id varchar(100);
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS mobile varchar(30);
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS city varchar(100);
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS gender varchar(10);
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS employee_no varchar(50);
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS hire_date date;
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS employment_status varchar(20) DEFAULT 'active'
  CHECK (employment_status IN ('active','inactive','probation','leave'));
ALTER TABLE platform.people ADD COLUMN IF NOT EXISTS direct_manager_id uuid;

-- ────────────────────────────────────────────────────────────
-- 2. 飞书审批待处理表（卡片按钮回调用）
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform.pending_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  action_id varchar(200) NOT NULL,
  resource_type varchar(50) NOT NULL,
  resource_id uuid NOT NULL,
  requester_person_id uuid NOT NULL,
  approver_feishu_open_id varchar(100),
  feishu_message_id varchar(200),
  feishu_chat_id varchar(200),
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (tenant_id, action_id)
);
CREATE INDEX IF NOT EXISTS pending_approvals_action_idx ON platform.pending_approvals(action_id);
CREATE INDEX IF NOT EXISTS pending_approvals_resource_idx ON platform.pending_approvals(tenant_id, resource_type, resource_id);

-- ────────────────────────────────────────────────────────────
-- 3. 项目风险表
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project.project_risks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  title varchar(300) NOT NULL,
  description text,
  probability varchar(20) NOT NULL DEFAULT 'medium'
    CHECK (probability IN ('low','medium','high','critical')),
  impact varchar(20) NOT NULL DEFAULT 'medium'
    CHECK (impact IN ('low','medium','high','critical')),
  status varchar(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','mitigated','accepted','closed')),
  mitigation_plan text,
  owner_person_id uuid,
  due_date date,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────
-- 4. 工时记录表
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project.time_logs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  person_id uuid NOT NULL,
  hours_logged numeric(5,2) NOT NULL CHECK (hours_logged > 0),
  log_date date NOT NULL DEFAULT CURRENT_DATE,
  description text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES project.tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

-- ────────────────────────────────────────────────────────────
-- 5. 项目变更请求
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project.change_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  title varchar(300) NOT NULL,
  description text,
  change_type varchar(30) DEFAULT 'scope'
    CHECK (change_type IN ('scope','timeline','budget','resource','other')),
  impact_description text,
  budget_impact_cents bigint DEFAULT 0,
  timeline_impact_days integer DEFAULT 0,
  status varchar(20) DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected','withdrawn')),
  requester_person_id uuid NOT NULL,
  approver_person_id uuid,
  approved_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE
);

-- ────────────────────────────────────────────────────────────
-- 6. HR：员工合同
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.employee_contracts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL,
  contract_type varchar(30) DEFAULT 'full_time'
    CHECK (contract_type IN ('full_time','part_time','contractor','intern','probation')),
  start_date date NOT NULL,
  end_date date,
  probation_end_date date,
  base_salary_cents bigint,
  bonus_target_pct integer DEFAULT 0,
  currency varchar(10) DEFAULT 'CNY',
  work_location varchar(100),
  status varchar(20) DEFAULT 'active'
    CHECK (status IN ('draft','active','expired','terminated')),
  signed_at date,
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

-- ────────────────────────────────────────────────────────────
-- 7. HR：假期/请假申请
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.leave_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL,
  leave_type varchar(30) NOT NULL
    CHECK (leave_type IN ('annual','sick','personal','parental','marriage','bereavement','unpaid','other')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  days numeric(5,1) NOT NULL CHECK (days > 0),
  reason text,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled','withdrawn')),
  approver_person_id uuid,
  approved_at timestamptz,
  rejection_reason text,
  handover_notes text,
  feishu_approval_instance_id varchar(200),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

-- ────────────────────────────────────────────────────────────
-- 8. HR：入职清单 (Onboarding)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.onboarding_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  candidate_id uuid,
  person_id uuid,
  title varchar(300) NOT NULL,
  description text,
  category varchar(50) DEFAULT 'general'
    CHECK (category IN ('general','it','hr','legal','team','training')),
  assignee_person_id uuid,
  due_days_from_start integer DEFAULT 3,
  status varchar(20) DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','skipped')),
  completed_at timestamptz,
  is_template boolean DEFAULT false,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- ────────────────────────────────────────────────────────────
-- 9. 财务：部门预算
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finance.budget_allocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  org_unit_id uuid,
  name varchar(200) NOT NULL,
  period_label varchar(50) NOT NULL,
  period_year integer NOT NULL,
  period_quarter integer CHECK (period_quarter BETWEEN 1 AND 4),
  category varchar(50) NOT NULL DEFAULT 'general'
    CHECK (category IN ('general','personnel','travel','equipment','marketing','r_and_d','operations','other')),
  total_amount_cents bigint NOT NULL CHECK (total_amount_cents >= 0),
  spent_cents bigint NOT NULL DEFAULT 0,
  status varchar(20) DEFAULT 'active'
    CHECK (status IN ('draft','active','frozen','closed')),
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- ────────────────────────────────────────────────────────────
-- 10. IT：软件许可证
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS it.software_licenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  asset_id uuid,
  software_name varchar(200) NOT NULL,
  vendor varchar(200),
  version varchar(100),
  license_type varchar(50) DEFAULT 'subscription'
    CHECK (license_type IN ('subscription','perpetual','per_user','per_device','open_source','freeware')),
  total_seats integer,
  used_seats integer DEFAULT 0,
  license_key varchar(500),
  purchase_date date,
  expiry_date date,
  renewal_cost_cents bigint,
  auto_renew boolean DEFAULT false,
  status varchar(20) DEFAULT 'active'
    CHECK (status IN ('active','expiring','expired','cancelled','pending')),
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- ────────────────────────────────────────────────────────────
-- 11. CRM：客户档案 (Account)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm.accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  name varchar(300) NOT NULL,
  short_name varchar(100),
  industry varchar(100),
  company_size varchar(30)
    CHECK (company_size IN ('1-10','11-50','51-200','201-500','501-2000','2000+')),
  website varchar(500),
  phone varchar(50),
  address text,
  city varchar(100),
  province varchar(100),
  annual_revenue_cents bigint,
  credit_rating varchar(10),
  account_type varchar(30) DEFAULT 'prospect'
    CHECK (account_type IN ('prospect','customer','partner','vendor','other')),
  owner_person_id uuid,
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- 在 crm.opportunities 上增加 account_id 关联
ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS account_id uuid;
ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS contract_number varchar(100);
ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS signed_at date;
ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS lost_reason text;
ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS next_step text;
ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- ────────────────────────────────────────────────────────────
-- 12. 知识库：版本历史
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge.item_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  version_number integer NOT NULL,
  content text,
  change_summary text,
  author_person_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_id, version_number)
);

-- 知识库条目增加版本号
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS version_number integer NOT NULL DEFAULT 1;
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS rating_avg numeric(3,2) DEFAULT 0;
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS rating_count integer DEFAULT 0;

-- ────────────────────────────────────────────────────────────
-- 13. 策略：主动事项 (Initiatives)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategy.initiatives (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  key_result_id uuid NOT NULL,
  title varchar(300) NOT NULL,
  description text,
  owner_person_id uuid,
  status varchar(20) DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled','blocked')),
  start_date date,
  due_date date,
  progress integer DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- ────────────────────────────────────────────────────────────
-- 14. 权限授予新表
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  new_tables text[] := ARRAY[
    'platform.pending_approvals',
    'project.project_risks',
    'project.time_logs',
    'project.change_requests',
    'hr.employee_contracts',
    'hr.leave_requests',
    'hr.onboarding_tasks',
    'finance.budget_allocations',
    'it.software_licenses',
    'crm.accounts',
    'knowledge.item_versions',
    'strategy.initiatives'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO hq_app', t);
  END LOOP;
END $$;

-- 新 schema 的 USAGE
GRANT USAGE ON SCHEMA platform TO hq_app;
GRANT USAGE ON SCHEMA project TO hq_app;
GRANT USAGE ON SCHEMA crm TO hq_app;
GRANT USAGE ON SCHEMA hr TO hq_app;
GRANT USAGE ON SCHEMA finance TO hq_app;
GRANT USAGE ON SCHEMA it TO hq_app;
GRANT USAGE ON SCHEMA knowledge TO hq_app;
GRANT USAGE ON SCHEMA strategy TO hq_app;

-- Sequences
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA project TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA crm TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hr TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA finance TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA it TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA knowledge TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA strategy TO hq_app;

-- RLS policies for new tables (镜像 platform.current_tenant_id 隔离)
ALTER TABLE platform.pending_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY pending_approvals_tenant ON platform.pending_approvals
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE project.project_risks ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_risks_tenant ON project.project_risks
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE project.time_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY time_logs_tenant ON project.time_logs
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE project.change_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY change_requests_tenant ON project.change_requests
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE hr.employee_contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY employee_contracts_tenant ON hr.employee_contracts
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE hr.leave_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY leave_requests_tenant ON hr.leave_requests
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE hr.onboarding_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY onboarding_tasks_tenant ON hr.onboarding_tasks
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE finance.budget_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_allocations_tenant ON finance.budget_allocations
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE it.software_licenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY software_licenses_tenant ON it.software_licenses
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE crm.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant ON crm.accounts
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE knowledge.item_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_versions_tenant ON knowledge.item_versions
  USING (tenant_id = platform.current_tenant_id());

ALTER TABLE strategy.initiatives ENABLE ROW LEVEL SECURITY;
CREATE POLICY initiatives_tenant ON strategy.initiatives
  USING (tenant_id = platform.current_tenant_id());

COMMIT;

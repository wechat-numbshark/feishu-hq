BEGIN;

-- Migration 0014: 审批引擎 + HR 完整增强（飞书人事对标）
-- ─────────────────────────────────────────────────────────────

-- ── 审批流定义（每租户可配置）────────────────────────────────
CREATE TABLE IF NOT EXISTS platform.approval_flows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,                   -- 'leave_request','expense','new_hire','offboard','it_purchase','vendor_contract'
  name        text NOT NULL,
  module      text NOT NULL,                   -- 'hr','finance','it'
  description text,
  steps       jsonb NOT NULL DEFAULT '[{"order":1,"type":"manager","label":"直属上级"}]',
  -- step type: 'manager'=运行时解析为员工直属上级, 'person'=指定人, 'role'=租户管理员
  auto_approve_if_no_approver boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
ALTER TABLE platform.approval_flows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_flows_tenant ON platform.approval_flows;
CREATE POLICY approval_flows_tenant ON platform.approval_flows
  USING (tenant_id = platform.current_tenant_id());

-- ── 审批实例（每次审批请求）──────────────────────────────────
CREATE TABLE IF NOT EXISTS platform.approval_instances (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  flow_id              uuid NOT NULL REFERENCES platform.approval_flows(id),
  resource_type        text NOT NULL,     -- 'leave_request','expense','requisition','offboarding','it_purchase'
  resource_id          uuid NOT NULL,
  requester_person_id  uuid NOT NULL,
  title                text NOT NULL,
  summary              jsonb NOT NULL DEFAULT '{}',  -- key fields shown in approval card
  current_step         int NOT NULL DEFAULT 1,
  total_steps          int NOT NULL DEFAULT 1,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','withdrawn','cancelled')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz
);
ALTER TABLE platform.approval_instances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_instances_tenant ON platform.approval_instances;
CREATE POLICY approval_instances_tenant ON platform.approval_instances
  USING (tenant_id = platform.current_tenant_id());
CREATE INDEX IF NOT EXISTS approval_instances_resource_idx
  ON platform.approval_instances (tenant_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS approval_instances_requester_idx
  ON platform.approval_instances (tenant_id, requester_person_id, status);

-- ── 审批步骤动作（每步骤的审批决定）─────────────────────────
CREATE TABLE IF NOT EXISTS platform.approval_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  instance_id       uuid NOT NULL REFERENCES platform.approval_instances(id) ON DELETE CASCADE,
  step_order        int NOT NULL,
  approver_person_id uuid,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','delegated')),
  comment           text,
  decided_at        timestamptz,
  feishu_message_id text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform.approval_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_actions_tenant ON platform.approval_actions;
CREATE POLICY approval_actions_tenant ON platform.approval_actions
  USING (tenant_id = platform.current_tenant_id());
CREATE INDEX IF NOT EXISTS approval_actions_instance_idx
  ON platform.approval_actions (instance_id, step_order);
CREATE INDEX IF NOT EXISTS approval_actions_approver_idx
  ON platform.approval_actions (tenant_id, approver_person_id, status);

-- ── HR 考勤记录 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.attendance_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL,
  date        date NOT NULL,
  check_in    timestamptz,
  check_out   timestamptz,
  source      text NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','feishu','system')),
  note        text,
  status      text NOT NULL DEFAULT 'normal'
                CHECK (status IN ('normal','late','early_out','absent','on_leave','holiday','weekend')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, person_id, date)
);
ALTER TABLE hr.attendance_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attendance_tenant ON hr.attendance_records;
CREATE POLICY attendance_tenant ON hr.attendance_records
  USING (tenant_id = platform.current_tenant_id());

-- ── HR 薪酬组成（薪资结构）──────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.salary_components (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  person_id        uuid NOT NULL,
  employment_id    uuid NOT NULL REFERENCES platform.employments(id) ON DELETE CASCADE,
  component_type   text NOT NULL
                     CHECK (component_type IN ('base','bonus','commission','allowance',
                                               'deduction','social_insurance','housing_fund')),
  name             text NOT NULL,
  amount_cents     bigint NOT NULL DEFAULT 0,
  is_fixed         boolean NOT NULL DEFAULT true,
  effective_from   date NOT NULL,
  effective_to     date,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hr.salary_components ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS salary_components_tenant ON hr.salary_components;
CREATE POLICY salary_components_tenant ON hr.salary_components
  USING (tenant_id = platform.current_tenant_id());

-- ── 扩展 hr.job_requisitions：更多字段 ────────────────────────
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS employment_type text DEFAULT 'employee';
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS salary_min_cents bigint;
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS salary_max_cents bigint;
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS expected_start_date date;
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS owner_person_id uuid;
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS priority text DEFAULT 'normal'
  CHECK (priority IN ('urgent','high','normal','low'));
ALTER TABLE hr.job_requisitions ADD COLUMN IF NOT EXISTS candidate_count int DEFAULT 0;

-- ── 扩展 hr.candidates：完整候选人字段 ──────────────────────
ALTER TABLE hr.candidates ADD COLUMN IF NOT EXISTS source text DEFAULT 'referral'
  CHECK (source IN ('referral','job_board','headhunter','campus','linkedin','direct','other'));
ALTER TABLE hr.candidates ADD COLUMN IF NOT EXISTS education text;
ALTER TABLE hr.candidates ADD COLUMN IF NOT EXISTS skills text[];
ALTER TABLE hr.candidates ADD COLUMN IF NOT EXISTS rating int CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE hr.candidates ADD COLUMN IF NOT EXISTS tags text[];
ALTER TABLE hr.candidates ADD COLUMN IF NOT EXISTS resume_url text;
ALTER TABLE hr.candidates ADD COLUMN IF NOT EXISTS expected_salary_cents bigint;
ALTER TABLE hr.candidates ADD COLUMN IF NOT EXISTS owner_person_id uuid;

-- ── 为所有现有租户插入默认审批流配置 ─────────────────────────
INSERT INTO platform.approval_flows (tenant_id, code, name, module, description, steps)
SELECT t.id, 'leave_request', '请假审批', 'hr', '员工请假须经直属上级审批',
  '[{"order":1,"type":"manager","label":"直属上级"},{"order":2,"type":"role","label":"HR 负责人"}]'::jsonb
FROM platform.tenants t WHERE t.deleted_at IS NULL
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO platform.approval_flows (tenant_id, code, name, module, description, steps)
SELECT t.id, 'expense', '费用报销审批', 'finance', '报销申请须经直属上级和财务负责人审批',
  '[{"order":1,"type":"manager","label":"直属上级"},{"order":2,"type":"role","label":"财务负责人"}]'::jsonb
FROM platform.tenants t WHERE t.deleted_at IS NULL
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO platform.approval_flows (tenant_id, code, name, module, description, steps)
SELECT t.id, 'new_hire', '入职审批', 'hr', '新员工入职须由 HR 负责人审批',
  '[{"order":1,"type":"role","label":"HR 管理员"}]'::jsonb
FROM platform.tenants t WHERE t.deleted_at IS NULL
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO platform.approval_flows (tenant_id, code, name, module, description, steps)
SELECT t.id, 'offboarding', '离职审批', 'hr', '离职申请须由直属上级和 HR 审批',
  '[{"order":1,"type":"manager","label":"直属上级"},{"order":2,"type":"role","label":"HR 管理员"}]'::jsonb
FROM platform.tenants t WHERE t.deleted_at IS NULL
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO platform.approval_flows (tenant_id, code, name, module, description, steps)
SELECT t.id, 'it_purchase', 'IT 采购审批', 'it', 'IT 资产采购须由 IT 负责人和管理员审批',
  '[{"order":1,"type":"role","label":"IT 负责人"}]'::jsonb
FROM platform.tenants t WHERE t.deleted_at IS NULL
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO platform.approval_flows (tenant_id, code, name, module, description, steps)
SELECT t.id, 'vendor_contract', '供应商合同审批', 'it', '新供应商合同须经管理层审批',
  '[{"order":1,"type":"role","label":"管理员"}]'::jsonb
FROM platform.tenants t WHERE t.deleted_at IS NULL
ON CONFLICT (tenant_id, code) DO NOTHING;

-- ── GRANTS ────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.approval_flows TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.approval_instances TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.approval_actions TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON hr.attendance_records TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON hr.salary_components TO hq_app;

COMMIT;

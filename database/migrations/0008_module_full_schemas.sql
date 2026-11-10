BEGIN;

-- ═══════════════════════════════════════════════════════════
-- 0008 · 完整业务模块 Schema
-- 覆盖：project / crm / hr / finance / it / knowledge / strategy
-- ═══════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────
-- 一、项目管理扩展 (project schema)
-- ───────────────────────────────────────────────────────────

CREATE TABLE project.project_members (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  person_id uuid NOT NULL,
  role varchar(30) NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner','manager','member','observer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, person_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE project.milestones (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  name varchar(200) NOT NULL,
  description text,
  due_date date,
  status varchar(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','missed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE project.tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  milestone_id uuid,
  parent_task_id uuid,
  title varchar(500) NOT NULL,
  description text,
  assignee_person_id uuid,
  reporter_person_id uuid,
  priority varchar(20) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('critical','high','medium','low')),
  status varchar(30) NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo','in_progress','in_review','blocked','done','cancelled')),
  story_points integer CHECK (story_points > 0),
  estimated_hours numeric(8,2),
  actual_hours numeric(8,2),
  due_date date,
  started_at timestamptz,
  completed_at timestamptz,
  tags text[] NOT NULL DEFAULT '{}',
  feishu_task_guid varchar(200),
  feishu_sync_status varchar(20) DEFAULT 'unsynced'
    CHECK (feishu_sync_status IN ('unsynced','synced','conflict','disabled')),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, milestone_id)
    REFERENCES project.milestones(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, parent_task_id)
    REFERENCES project.tasks(tenant_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, assignee_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, reporter_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX tasks_project_idx ON project.tasks (tenant_id, project_id, status);
CREATE INDEX tasks_assignee_idx ON project.tasks (tenant_id, assignee_person_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX tasks_feishu_guid_idx ON project.tasks (tenant_id, feishu_task_guid)
  WHERE feishu_task_guid IS NOT NULL;

CREATE TABLE project.task_comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  author_person_id uuid NOT NULL,
  body text NOT NULL,
  feishu_message_id varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES project.tasks(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE project.task_activities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  actor_person_id uuid,
  action varchar(100) NOT NULL,
  field_name varchar(100),
  old_value jsonb,
  new_value jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES project.tasks(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE project.requirements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  code varchar(40) NOT NULL,
  title varchar(500) NOT NULL,
  description text,
  priority varchar(20) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('critical','high','medium','low')),
  status varchar(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','reviewing','approved','in_development','done','rejected')),
  owner_person_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, code),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

-- ───────────────────────────────────────────────────────────
-- 二、CRM 扩展 (crm schema)
-- ───────────────────────────────────────────────────────────

CREATE TABLE crm.contacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  opportunity_id uuid,
  name varchar(200) NOT NULL,
  title varchar(200),
  company varchar(200),
  email citext,
  mobile_encrypted text,
  is_key_decision_maker boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id)
    REFERENCES crm.opportunities(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE crm.activities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  opportunity_id uuid,
  contact_id uuid,
  actor_person_id uuid NOT NULL,
  activity_type varchar(40) NOT NULL
    CHECK (activity_type IN ('call','meeting','email','demo','proposal','contract','note','other')),
  title varchar(300) NOT NULL,
  summary text,
  outcome varchar(100),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  next_action varchar(300),
  next_action_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id)
    REFERENCES crm.opportunities(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, contact_id)
    REFERENCES crm.contacts(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, actor_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX activities_opportunity_idx ON crm.activities (tenant_id, opportunity_id, occurred_at DESC);

-- ───────────────────────────────────────────────────────────
-- 三、HR 完整招聘模块 (hr schema)
-- ───────────────────────────────────────────────────────────

-- 候选人库
CREATE TABLE hr.candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  requisition_id uuid,
  name varchar(200) NOT NULL,
  email citext,
  mobile_encrypted text,
  current_company varchar(200),
  current_title varchar(200),
  years_of_experience numeric(4,1),
  expected_salary_min bigint,
  expected_salary_max bigint,
  resume_url text,
  resume_content text,
  skills text[] NOT NULL DEFAULT '{}',
  source varchar(50) NOT NULL DEFAULT 'active_sourcing'
    CHECK (source IN ('job_board','referral','linkedin','campus','headhunter','active_sourcing','walk_in','other')),
  status varchar(50) NOT NULL DEFAULT 'new'
    CHECK (status IN (
      'new','resume_screening','phone_screening',
      'technical_interview','hr_interview','final_interview',
      'offer_pending','offer_sent','offer_accepted','offer_declined',
      'hired','rejected','withdrawn','on_hold'
    )),
  rejection_reason text,
  responsible_person_id uuid,
  notes text,
  feishu_open_id varchar(200),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requisition_id)
    REFERENCES hr.job_requisitions(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, responsible_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX candidates_requisition_idx ON hr.candidates (tenant_id, requisition_id, status);
CREATE INDEX candidates_status_idx ON hr.candidates (tenant_id, status)
  WHERE deleted_at IS NULL;

-- 面试安排
CREATE TABLE hr.interviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL,
  requisition_id uuid,
  round integer NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 10),
  interview_type varchar(30) NOT NULL DEFAULT 'onsite'
    CHECK (interview_type IN ('phone','online','onsite','technical','hr','final')),
  status varchar(30) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','in_progress','completed','cancelled','no_show')),
  scheduled_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 60,
  location varchar(300),
  meeting_link text,
  feishu_meeting_id varchar(200),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES hr.candidates(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, requisition_id)
    REFERENCES hr.job_requisitions(tenant_id, id) ON DELETE SET NULL
);

-- 面试官参与
CREATE TABLE hr.interview_interviewers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  interview_id uuid NOT NULL,
  interviewer_person_id uuid NOT NULL,
  is_lead boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, interview_id, interviewer_person_id),
  FOREIGN KEY (tenant_id, interview_id)
    REFERENCES hr.interviews(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, interviewer_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

-- 面试评价
CREATE TABLE hr.interview_evaluations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  interview_id uuid NOT NULL,
  interviewer_person_id uuid NOT NULL,
  recommendation varchar(30) NOT NULL
    CHECK (recommendation IN ('strongly_recommend','recommend','pending','not_recommend')),
  overall_score integer CHECK (overall_score BETWEEN 1 AND 10),
  dimension_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  strengths text,
  weaknesses text,
  notes text,
  is_locked boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, interview_id, interviewer_person_id),
  FOREIGN KEY (tenant_id, interview_id)
    REFERENCES hr.interviews(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, interviewer_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

-- Offer 管理
CREATE TABLE hr.offers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL,
  requisition_id uuid,
  position_title varchar(200) NOT NULL,
  department varchar(200),
  base_salary_annual bigint NOT NULL CHECK (base_salary_annual > 0),
  bonus_annual bigint,
  stock_options integer,
  probation_months integer DEFAULT 3,
  expected_start_date date,
  offer_expires_at timestamptz,
  status varchar(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','approved','sent','accepted','declined','expired','withdrawn')),
  approved_by_person_id uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  responded_at timestamptz,
  decline_reason text,
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES hr.candidates(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, requisition_id)
    REFERENCES hr.job_requisitions(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, approved_by_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

-- ───────────────────────────────────────────────────────────
-- 四、财务扩展 (finance schema)
-- ───────────────────────────────────────────────────────────

CREATE TABLE finance.budgets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  legal_entity_id uuid,
  org_unit_id uuid,
  period_label varchar(20) NOT NULL,
  category varchar(100) NOT NULL,
  budget_cents bigint NOT NULL CHECK (budget_cents >= 0),
  spent_cents bigint NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, org_unit_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE finance.invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  payment_plan_id uuid,
  invoice_number citext NOT NULL,
  invoice_type varchar(20) NOT NULL DEFAULT 'receivable'
    CHECK (invoice_type IN ('receivable','payable')),
  counterparty_name varchar(200) NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  tax_rate numeric(5,4) NOT NULL DEFAULT 0.06,
  issue_date date NOT NULL,
  due_date date NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','partial','paid','overdue','cancelled','disputed')),
  paid_cents bigint NOT NULL DEFAULT 0,
  paid_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_number),
  FOREIGN KEY (tenant_id, payment_plan_id)
    REFERENCES finance.payment_plans(tenant_id, id) ON DELETE SET NULL,
  CHECK (due_date >= issue_date),
  CHECK (paid_cents <= amount_cents)
);

CREATE TABLE finance.expenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  submitter_person_id uuid NOT NULL,
  approver_person_id uuid,
  category varchar(100) NOT NULL
    CHECK (category IN ('travel','meals','accommodation','supplies','software','hardware','marketing','training','other')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  expense_date date NOT NULL,
  description varchar(500) NOT NULL,
  receipt_urls text[] NOT NULL DEFAULT '{}',
  status varchar(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected','paid','cancelled')),
  approved_at timestamptz,
  rejected_reason text,
  paid_at timestamptz,
  budget_id uuid,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, submitter_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, approver_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, budget_id)
    REFERENCES finance.budgets(tenant_id, id) ON DELETE SET NULL
);

-- ───────────────────────────────────────────────────────────
-- 五、IT 资产管理 (it schema)
-- ───────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS it;

CREATE TABLE it.assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  asset_code citext NOT NULL,
  name varchar(300) NOT NULL,
  category varchar(50) NOT NULL
    CHECK (category IN ('hardware','software','saas','network','certificate','other')),
  vendor varchar(200),
  model varchar(200),
  serial_number varchar(200),
  purchase_date date,
  purchase_cost_cents bigint,
  warranty_expires_at date,
  license_expires_at date,
  license_seats integer,
  assigned_person_id uuid,
  assigned_org_unit_id uuid,
  status varchar(30) NOT NULL DEFAULT 'in_use'
    CHECK (status IN ('in_use','spare','maintenance','decommissioned','lost')),
  health_status varchar(20) NOT NULL DEFAULT 'healthy'
    CHECK (health_status IN ('healthy','attention','warning','critical')),
  location varchar(200),
  notes text,
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, asset_code),
  FOREIGN KEY (tenant_id, assigned_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, assigned_org_unit_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX assets_category_idx ON it.assets (tenant_id, category, status)
  WHERE deleted_at IS NULL;
CREATE INDEX assets_expiry_idx ON it.assets (tenant_id, license_expires_at)
  WHERE license_expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE it.tickets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  ticket_number citext NOT NULL,
  title varchar(300) NOT NULL,
  description text,
  category varchar(50) NOT NULL DEFAULT 'general'
    CHECK (category IN ('account','device','software','network','security','purchase','other','general')),
  priority varchar(20) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('critical','high','medium','low')),
  status varchar(30) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','pending_user','resolved','closed','cancelled')),
  requester_person_id uuid NOT NULL,
  assignee_person_id uuid,
  asset_id uuid,
  resolved_at timestamptz,
  resolution_notes text,
  feishu_message_id varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ticket_number),
  FOREIGN KEY (tenant_id, requester_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, assignee_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, asset_id)
    REFERENCES it.assets(tenant_id, id) ON DELETE SET NULL
);

-- ───────────────────────────────────────────────────────────
-- 六、知识库 (knowledge schema)
-- ───────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS knowledge;

CREATE TABLE knowledge.categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  parent_id uuid,
  name varchar(200) NOT NULL,
  slug citext NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, parent_id)
    REFERENCES knowledge.categories(tenant_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE knowledge.items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  category_id uuid,
  title varchar(500) NOT NULL,
  content text,
  content_type varchar(30) NOT NULL DEFAULT 'markdown'
    CHECK (content_type IN ('markdown','richtext','feishu_doc','file','link')),
  source_url text,
  feishu_doc_token varchar(200),
  source_type varchar(50) NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('manual','feishu_doc','feishu_wiki','nas_file','crm','project','auto_extracted')),
  classification varchar(20) NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public','internal','confidential','restricted')),
  owner_person_id uuid,
  owner_org_unit_id uuid,
  tags text[] NOT NULL DEFAULT '{}',
  index_status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending','indexing','indexed','failed','excluded')),
  view_count integer NOT NULL DEFAULT 0,
  ai_reference_count integer NOT NULL DEFAULT 0,
  last_indexed_at timestamptz,
  published_at timestamptz,
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)
    REFERENCES knowledge.categories(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, owner_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, owner_org_unit_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX knowledge_items_search_idx ON knowledge.items USING gin(
  to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))
);
CREATE INDEX knowledge_items_tags_idx ON knowledge.items USING gin(tags);
CREATE INDEX knowledge_items_feishu_idx ON knowledge.items (tenant_id, feishu_doc_token)
  WHERE feishu_doc_token IS NOT NULL;

-- ───────────────────────────────────────────────────────────
-- 七、战略 OKR (strategy schema)
-- ───────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS strategy;

CREATE TABLE strategy.periods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  label varchar(50) NOT NULL,
  period_type varchar(20) NOT NULL DEFAULT 'quarter'
    CHECK (period_type IN ('year','half','quarter','month')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft','active','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (end_date > start_date)
);

CREATE TABLE strategy.objectives (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  period_id uuid NOT NULL,
  parent_objective_id uuid,
  owner_person_id uuid,
  owner_org_unit_id uuid,
  title varchar(500) NOT NULL,
  description text,
  type varchar(20) NOT NULL DEFAULT 'company'
    CHECK (type IN ('company','team','personal')),
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft','active','completed','cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  confidence integer NOT NULL DEFAULT 70 CHECK (confidence BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id)
    REFERENCES strategy.periods(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, parent_objective_id)
    REFERENCES strategy.objectives(tenant_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, owner_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, owner_org_unit_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE strategy.key_results (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  objective_id uuid NOT NULL,
  title varchar(500) NOT NULL,
  description text,
  kr_type varchar(20) NOT NULL DEFAULT 'numeric'
    CHECK (kr_type IN ('numeric','boolean','percentage','milestone')),
  target_value numeric(15,4),
  current_value numeric(15,4) NOT NULL DEFAULT 0,
  baseline_value numeric(15,4) NOT NULL DEFAULT 0,
  unit varchar(50),
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  confidence integer NOT NULL DEFAULT 70 CHECK (confidence BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, objective_id)
    REFERENCES strategy.objectives(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE strategy.checkins (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  key_result_id uuid NOT NULL,
  author_person_id uuid NOT NULL,
  value_at_checkin numeric(15,4) NOT NULL,
  confidence integer NOT NULL DEFAULT 70 CHECK (confidence BETWEEN 0 AND 100),
  summary text,
  blockers text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, key_result_id)
    REFERENCES strategy.key_results(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

-- ───────────────────────────────────────────────────────────
-- 八、AI 对话历史 (platform schema 扩展)
-- ───────────────────────────────────────────────────────────

CREATE TABLE platform.ai_conversations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL,
  title varchar(300),
  context_module varchar(60),
  context_resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE platform.ai_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('user','assistant','tool')),
  content text NOT NULL,
  tool_calls jsonb,
  tool_call_id varchar(200),
  token_usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES platform.ai_conversations(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ai_messages_conversation_idx
  ON platform.ai_messages (tenant_id, conversation_id, created_at);

-- ───────────────────────────────────────────────────────────
-- 九、RLS 策略、触发器、权限
-- ───────────────────────────────────────────────────────────

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'project.project_members',
    'project.milestones',
    'project.tasks',
    'project.task_comments',
    'project.task_activities',
    'project.requirements',
    'crm.contacts',
    'crm.activities',
    'hr.candidates',
    'hr.interviews',
    'hr.interview_interviewers',
    'hr.interview_evaluations',
    'hr.offers',
    'finance.budgets',
    'finance.invoices',
    'finance.expenses',
    'it.assets',
    'it.tickets',
    'knowledge.categories',
    'knowledge.items',
    'strategy.periods',
    'strategy.objectives',
    'strategy.key_results',
    'strategy.checkins',
    'platform.ai_conversations',
    'platform.ai_messages'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())',
      tbl
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  tbl text;
  trg text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'project.project_members',
    'project.milestones',
    'project.tasks',
    'project.task_comments',
    'project.requirements',
    'crm.contacts',
    'crm.activities',
    'hr.candidates',
    'hr.interviews',
    'hr.interview_evaluations',
    'hr.offers',
    'finance.budgets',
    'finance.invoices',
    'finance.expenses',
    'it.assets',
    'it.tickets',
    'knowledge.categories',
    'knowledge.items',
    'strategy.periods',
    'strategy.objectives',
    'strategy.key_results'
  ] LOOP
    trg := replace(tbl, '.', '_') || '_touch';
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_row()',
      trg, tbl
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'project.project_members',
    'project.milestones',
    'project.tasks',
    'project.task_comments',
    'project.task_activities',
    'project.requirements',
    'crm.contacts',
    'crm.activities',
    'hr.candidates',
    'hr.interviews',
    'hr.interview_interviewers',
    'hr.interview_evaluations',
    'hr.offers',
    'finance.budgets',
    'finance.invoices',
    'finance.expenses',
    'it.assets',
    'it.tickets',
    'knowledge.categories',
    'knowledge.items',
    'strategy.periods',
    'strategy.objectives',
    'strategy.key_results',
    'strategy.checkins',
    'platform.ai_conversations',
    'platform.ai_messages'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO hq_app', tbl);
  END LOOP;
END;
$$;

-- Schema 访问权限（缺少 USAGE 会导致 "permission denied for schema" 错误）
GRANT USAGE ON SCHEMA project TO hq_app;
GRANT USAGE ON SCHEMA crm TO hq_app;
GRANT USAGE ON SCHEMA hr TO hq_app;
GRANT USAGE ON SCHEMA finance TO hq_app;
GRANT USAGE ON SCHEMA it TO hq_app;
GRANT USAGE ON SCHEMA knowledge TO hq_app;
GRANT USAGE ON SCHEMA strategy TO hq_app;
GRANT USAGE ON SCHEMA platform TO hq_app;

-- 序列权限
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA project TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA crm TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hr TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA finance TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA it TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA knowledge TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA strategy TO hq_app;

COMMIT;

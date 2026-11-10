-- 0024 · 软件研发域 + 销售合同/订阅计费 + 假期余额 + 绩效考核 + 应收账龄
-- 对应 docs/15 P0：补齐 docs/14 暴露的软件公司硬缺口（需求/缺陷/迭代/版本、合同、MRR/ARR、
-- 假期余额、绩效），全部按既有模式（tenant 隔离 RLS + hq_app 授权 + 只追加）。
BEGIN;

CREATE SCHEMA IF NOT EXISTS sw;

-- ── 1. 迭代（Sprint）：挂项目，容量点/目标/起止
CREATE TABLE sw.iterations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  goal text,
  status varchar(20) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','active','completed','cancelled')),
  capacity_points integer NOT NULL DEFAULT 0 CHECK (capacity_points >= 0),
  start_date date NOT NULL,
  end_date date NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, name),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE,
  CHECK (end_date >= start_date)
);

-- ── 2. 版本发布：关联迭代，release_notes
CREATE TABLE sw.versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  iteration_id uuid,
  version_number varchar(60) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','releasing','released','rolled_back')),
  release_notes text,
  planned_release_date date,
  released_at timestamptz,
  released_by_person_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, version_number),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, iteration_id) REFERENCES sw.iterations(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, released_by_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL
);

-- ── 3. 需求池：来源/优先级/story_points，关联项目与里程碑
CREATE TABLE sw.requirements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid,
  milestone_id uuid,
  code varchar(40) NOT NULL,
  title varchar(300) NOT NULL,
  description text,
  source varchar(20) NOT NULL DEFAULT 'internal'
    CHECK (source IN ('customer','internal','market','competition','support')),
  priority varchar(20) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('critical','high','medium','low')),
  status varchar(20) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','triaged','queued','doing','done','rejected')),
  story_points integer CHECK (story_points IS NULL OR story_points >= 0),
  owner_person_id uuid,
  requester_person_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, milestone_id) REFERENCES project.milestones(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, requester_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL
);

-- ── 4. 缺陷跟踪：严重级别/重现步骤/环境/发现与修复版本
CREATE TABLE sw.defects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid,
  requirement_id uuid,
  found_in_version_id uuid,
  fixed_in_version_id uuid,
  code varchar(40) NOT NULL,
  title varchar(300) NOT NULL,
  description text,
  severity varchar(20) NOT NULL DEFAULT 'major'
    CHECK (severity IN ('blocker','critical','major','minor','trivial')),
  priority varchar(20) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('critical','high','medium','low')),
  status varchar(20) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','confirmed','in_progress','fixed','verified','closed','rejected')),
  repro_steps text,
  environment varchar(200),
  assignee_person_id uuid,
  reporter_person_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, requirement_id) REFERENCES sw.requirements(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, found_in_version_id) REFERENCES sw.versions(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, fixed_in_version_id) REFERENCES sw.versions(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, assignee_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, reporter_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL
);

-- ── 5. 迭代-任务关联（software 模块不跨 schema 改 project.tasks，用联结表表达归属）
CREATE TABLE sw.iteration_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  iteration_id uuid NOT NULL,
  task_id uuid NOT NULL,
  story_points integer,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, iteration_id, task_id),
  FOREIGN KEY (tenant_id, iteration_id) REFERENCES sw.iterations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, task_id) REFERENCES project.tasks(tenant_id, id) ON DELETE CASCADE
);

-- ── 6. 销售合同：draft→reviewing(审批)→approved→signed→closed/terminated
CREATE TABLE sales.contracts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  contract_no varchar(40) NOT NULL,
  title varchar(300) NOT NULL,
  contract_type varchar(30) NOT NULL DEFAULT 'service'
    CHECK (contract_type IN ('saas','implementation','service','hardware','resale','other')),
  account_id uuid NOT NULL,
  opportunity_id uuid,
  project_id uuid,
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','reviewing','rejected','approved','signed','closed','terminated')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  payment_terms text,
  sign_date date,
  start_date date,
  end_date date,
  owner_person_id uuid,
  approved_at timestamptz,
  signed_at timestamptz,
  closed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_no),
  FOREIGN KEY (tenant_id, account_id) REFERENCES crm.accounts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm.opportunities(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

-- ── 7. 订阅计费：MRR 单一事实源（ARR=MRR×12，从活跃订阅实时聚合）
CREATE TABLE sales.subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  subscription_no varchar(40) NOT NULL,
  account_id uuid NOT NULL,
  contract_id uuid,
  plan_name varchar(200) NOT NULL,
  seats integer NOT NULL DEFAULT 1 CHECK (seats >= 0),
  billing_cycle varchar(20) NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly','annual')),
  mrr_cents bigint NOT NULL DEFAULT 0 CHECK (mrr_cents >= 0),
  status varchar(20) NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing','active','paused','churned')),
  start_date date NOT NULL DEFAULT current_date,
  end_date date,
  renewal_date date,
  auto_renew boolean NOT NULL DEFAULT true,
  churned_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, subscription_no),
  FOREIGN KEY (tenant_id, account_id) REFERENCES crm.accounts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, contract_id) REFERENCES sales.contracts(tenant_id, id) ON DELETE SET NULL
);

-- ── 8. 假期余额：人×年×假种 额度/已用/结转；请假批准同事务扣减（可记负并在看板告警）
CREATE TABLE hr.leave_balances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL,
  leave_type varchar(30) NOT NULL
    CHECK (leave_type IN ('annual','sick','personal','parental','marriage','bereavement','unpaid','other')),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  entitled_days numeric(6,1) NOT NULL DEFAULT 0 CHECK (entitled_days >= 0),
  accrued_days numeric(6,1) NOT NULL DEFAULT 0 CHECK (accrued_days >= 0),
  used_days numeric(6,1) NOT NULL DEFAULT 0,
  carried_over_days numeric(6,1) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, person_id, leave_type, year),
  FOREIGN KEY (tenant_id, person_id) REFERENCES platform.people(tenant_id, id) ON DELETE CASCADE
);

-- ── 9. 绩效考核：周期×被评人 唯一；自评→上级评→完成
CREATE TABLE hr.performance_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  cycle varchar(40) NOT NULL,
  reviewee_person_id uuid NOT NULL,
  reviewer_person_id uuid,
  project_id uuid,
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','self_review','pending_review','completed','cancelled')),
  self_rating integer CHECK (self_rating IS NULL OR self_rating BETWEEN 1 AND 5),
  self_comments text,
  self_submitted_at timestamptz,
  manager_rating integer CHECK (manager_rating IS NULL OR manager_rating BETWEEN 1 AND 5),
  manager_comments text,
  overall_rating numeric(4,2) CHECK (overall_rating IS NULL OR overall_rating BETWEEN 0 AND 5),
  goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, cycle, reviewee_person_id),
  FOREIGN KEY (tenant_id, reviewee_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reviewer_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE SET NULL
);

-- ── 10. 应收账龄视图（security_invoker：以调用者 RLS 过滤，口径与 0018 一致）
CREATE OR REPLACE VIEW reporting.v_ar_aging WITH (security_invoker = true) AS
SELECT tenant_id,
       count(*) FILTER (WHERE current_date - due_date BETWEEN 0 AND 30) AS b_0_30,
       count(*) FILTER (WHERE current_date - due_date BETWEEN 31 AND 60) AS b_31_60,
       count(*) FILTER (WHERE current_date - due_date BETWEEN 61 AND 90) AS b_61_90,
       count(*) FILTER (WHERE current_date - due_date > 90) AS b_over_90,
       coalesce(sum(amount_cents - paid_cents) FILTER (WHERE current_date - due_date BETWEEN 0 AND 30), 0)::bigint AS cents_0_30,
       coalesce(sum(amount_cents - paid_cents) FILTER (WHERE current_date - due_date BETWEEN 31 AND 60), 0)::bigint AS cents_31_60,
       coalesce(sum(amount_cents - paid_cents) FILTER (WHERE current_date - due_date BETWEEN 61 AND 90), 0)::bigint AS cents_61_90,
       coalesce(sum(amount_cents - paid_cents) FILTER (WHERE current_date - due_date > 90), 0)::bigint AS cents_over_90,
       coalesce(sum(amount_cents - paid_cents), 0)::bigint AS outstanding_cents
FROM finance.invoices
WHERE invoice_type = 'receivable'
  AND status IN ('sent','partial','overdue','disputed')
GROUP BY tenant_id;

GRANT USAGE ON SCHEMA sw TO hq_app;
GRANT SELECT ON reporting.v_ar_aging TO hq_app;

-- ── RLS + 授权（同 0023 模式）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sw.iterations','sw.versions','sw.requirements','sw.defects','sw.iteration_items',
    'sales.contracts','sales.subscriptions',
    'hr.leave_balances','hr.performance_reviews'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO hq_app', t);
  END LOOP;
END $$;

-- 常用查询索引（轻量）
CREATE INDEX IF NOT EXISTS idx_sw_defects_project_status ON sw.defects (tenant_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_sw_requirements_status ON sw.requirements (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_sw_iteration_items_task ON sw.iteration_items (tenant_id, task_id);
CREATE INDEX IF NOT EXISTS idx_sales_contracts_status ON sales.contracts (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_subs_status ON sales.subscriptions (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_leave_balances_person ON hr.leave_balances (tenant_id, person_id, year);

COMMIT;

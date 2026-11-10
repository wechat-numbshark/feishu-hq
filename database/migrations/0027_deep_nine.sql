-- 0027 · 全面深化（docs/18）：合同模板/条款库、发票核销、KR 指标绑定、360 反馈、知识评审
BEGIN;

-- ── 1. 合同模板与条款库
CREATE TABLE sales.contract_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  name varchar(200) NOT NULL,
  contract_type varchar(30) NOT NULL DEFAULT 'service'
    CHECK (contract_type IN ('saas','implementation','service','hardware','resale','other')),
  default_payment_terms text,
  body_md text,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by_person_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE sales.contract_clauses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  template_id uuid,
  title varchar(300) NOT NULL,
  body_md text NOT NULL,
  category varchar(60),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES sales.contract_templates(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE sales.contracts ADD COLUMN IF NOT EXISTS template_id uuid;
ALTER TABLE sales.contracts ADD COLUMN IF NOT EXISTS clauses_snapshot jsonb;

-- ── 2. 发票核销（发票 × 收款计划）
CREATE TABLE finance.invoice_writeoffs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  payment_plan_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  note text,
  created_by_person_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES finance.invoices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, payment_plan_id) REFERENCES finance.payment_plans(tenant_id, id) ON DELETE RESTRICT
);

-- ── 3. OKR 指标绑定（none|mrr|otd|yield）
ALTER TABLE strategy.key_results ADD COLUMN IF NOT EXISTS metric_source varchar(20)
  NOT NULL DEFAULT 'none' CHECK (metric_source IN ('none','mrr','otd','yield'));

-- ── 4. 绩效 360 反馈（一人对一份考核只评一次）
CREATE TABLE hr.review_feedbacks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL,
  reviewer_person_id uuid NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comments text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, review_id, reviewer_person_id),
  FOREIGN KEY (tenant_id, review_id) REFERENCES hr.performance_reviews(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reviewer_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE CASCADE
);

-- ── 5. 知识评审
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS review_status varchar(20)
  NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','pending','approved','changes_requested'));
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS reviewed_by_person_id uuid;
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE knowledge.items ADD COLUMN IF NOT EXISTS review_note text;

-- ── RLS + 授权
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sales.contract_templates','sales.contract_clauses',
    'finance.invoice_writeoffs','hr.review_feedbacks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO hq_app', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_contract_clauses_template ON sales.contract_clauses (tenant_id, template_id);
CREATE INDEX IF NOT EXISTS idx_invoice_writeoffs_invoice ON finance.invoice_writeoffs (tenant_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_review_feedbacks_review ON hr.review_feedbacks (tenant_id, review_id);

COMMIT;

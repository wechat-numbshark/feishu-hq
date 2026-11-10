BEGIN;

CREATE SCHEMA IF NOT EXISTS crm;
CREATE SCHEMA IF NOT EXISTS project;
CREATE SCHEMA IF NOT EXISTS hr;
CREATE SCHEMA IF NOT EXISTS finance;

CREATE TABLE crm.opportunities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  name varchar(200) NOT NULL,
  customer_name varchar(200) NOT NULL,
  owner_person_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  stage varchar(30) NOT NULL DEFAULT 'qualified' CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  win_probability integer NOT NULL DEFAULT 60 CHECK (win_probability BETWEEN 0 AND 100),
  expected_close_date date,
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE project.projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  source_opportunity_id uuid,
  code varchar(40) NOT NULL,
  name varchar(200) NOT NULL,
  customer_name varchar(200) NOT NULL,
  owner_person_id uuid,
  budget_cents bigint NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  status varchar(30) NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','at_risk','completed')),
  start_date date, end_date date, progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_opportunity_id) REFERENCES crm.opportunities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TABLE hr.job_requisitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid,
  title varchar(200) NOT NULL,
  headcount integer NOT NULL DEFAULT 1 CHECK (headcount BETWEEN 1 AND 100),
  reason text NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','approved','closed')),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE finance.payment_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  project_id uuid,
  customer_name varchar(200) NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  due_date date NOT NULL,
  milestone varchar(200) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','invoiced','paid','overdue')),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE platform.demo_workflows (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  opportunity_id uuid NOT NULL,
  project_id uuid NOT NULL,
  requisition_id uuid,
  payment_plan_id uuid NOT NULL,
  created_by uuid NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm.opportunities(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES hr.job_requisitions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, payment_plan_id) REFERENCES finance.payment_plans(tenant_id, id) ON DELETE CASCADE
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['crm.opportunities','project.projects','hr.job_requisitions','finance.payment_plans','platform.demo_workflows'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', t);
  END LOOP;
END $$;

DO $$ DECLARE t text; n text; BEGIN
  FOREACH t IN ARRAY ARRAY['crm.opportunities','project.projects','hr.job_requisitions','finance.payment_plans'] LOOP
    n := replace(t,'.','_') || '_touch';
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_row()', n, t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA crm, project, hr, finance TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA crm, project, hr, finance TO hq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.demo_workflows TO hq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA project GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hq_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA finance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hq_app;

CREATE INDEX opportunities_tenant_stage_idx ON crm.opportunities(tenant_id, stage, created_at DESC);
CREATE INDEX projects_tenant_status_idx ON project.projects(tenant_id, status, created_at DESC);
CREATE INDEX requisitions_tenant_status_idx ON hr.job_requisitions(tenant_id, status, created_at DESC);
CREATE INDEX payment_plans_tenant_due_idx ON finance.payment_plans(tenant_id, due_date);

COMMIT;

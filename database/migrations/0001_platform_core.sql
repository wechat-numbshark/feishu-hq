BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS authz;
CREATE SCHEMA IF NOT EXISTS integration;
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE platform.schema_migrations (
  version varchar(100) PRIMARY KEY,
  checksum varchar(128) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.tenants (
  id uuid PRIMARY KEY,
  code citext NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  deployment_mode varchar(20) NOT NULL DEFAULT 'private'
    CHECK (deployment_mode IN ('saas', 'private', 'hybrid')),
  data_region varchar(50),
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz
);

CREATE TABLE platform.legal_entities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  code citext NOT NULL,
  name varchar(200) NOT NULL,
  registration_number varchar(100),
  country_code char(2) NOT NULL DEFAULT 'CN',
  base_currency char(3) NOT NULL DEFAULT 'CNY',
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE platform.cost_centers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  legal_entity_id uuid,
  code citext NOT NULL,
  name varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  valid_from date,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES platform.legal_entities(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE platform.people (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  display_name varchar(200) NOT NULL,
  legal_name varchar(200),
  primary_email citext,
  primary_mobile_encrypted text,
  avatar_url text,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'merged')),
  classification varchar(20) NOT NULL DEFAULT 'confidential'
    CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  merged_into_person_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX people_tenant_email_uq
  ON platform.people (tenant_id, primary_email)
  WHERE primary_email IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE platform.org_units (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  legal_entity_id uuid,
  parent_id uuid,
  manager_person_id uuid,
  cost_center_id uuid,
  code citext NOT NULL,
  name varchar(200) NOT NULL,
  type varchar(30) NOT NULL
    CHECK (type IN ('company', 'division', 'department', 'team', 'virtual')),
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  source_of_truth varchar(30) NOT NULL DEFAULT 'platform'
    CHECK (source_of_truth IN ('platform', 'feishu', 'hr_system')),
  valid_from date,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES platform.legal_entities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, parent_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, manager_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, cost_center_id)
    REFERENCES platform.cost_centers(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX org_units_tenant_parent_idx ON platform.org_units (tenant_id, parent_id);

CREATE TABLE platform.positions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  org_unit_id uuid NOT NULL,
  code citext NOT NULL,
  name varchar(200) NOT NULL,
  job_family varchar(100),
  job_level varchar(50),
  headcount_limit numeric(8,2) NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'filled', 'frozen', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, org_unit_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE platform.employments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  org_unit_id uuid NOT NULL,
  position_id uuid,
  manager_person_id uuid,
  employee_number citext NOT NULL,
  employment_type varchar(30) NOT NULL DEFAULT 'employee'
    CHECK (employment_type IN ('employee', 'contractor', 'intern', 'part_time', 'advisor')),
  status varchar(30) NOT NULL DEFAULT 'preboarding'
    CHECK (status IN ('preboarding', 'active', 'leave', 'terminated')),
  start_date date,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_number),
  FOREIGN KEY (tenant_id, person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES platform.legal_entities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, org_unit_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, position_id)
    REFERENCES platform.positions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, manager_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX employments_person_idx ON platform.employments (tenant_id, person_id, status);
CREATE INDEX employments_org_idx ON platform.employments (tenant_id, org_unit_id, status);

CREATE TABLE platform.external_identities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  person_id uuid NOT NULL,
  provider varchar(40) NOT NULL,
  provider_tenant_id varchar(200) NOT NULL,
  external_subject varchar(300) NOT NULL,
  identity_kind varchar(30) NOT NULL DEFAULT 'user'
    CHECK (identity_kind IN ('user', 'service', 'bot')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_tenant_id, external_subject),
  FOREIGN KEY (tenant_id, person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE platform.resources (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  domain varchar(60) NOT NULL,
  resource_type varchar(100) NOT NULL,
  source_id uuid NOT NULL,
  legal_entity_id uuid,
  owner_person_id uuid,
  owner_org_unit_id uuid,
  classification varchar(20) NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, domain, resource_type, source_id),
  FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES platform.legal_entities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_person_id)
    REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_org_unit_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX resources_lookup_idx
  ON platform.resources (tenant_id, domain, resource_type, classification);

CREATE TABLE platform.outbox_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  event_type varchar(200) NOT NULL,
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  aggregate_type varchar(100) NOT NULL,
  aggregate_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  trace_id varchar(200) NOT NULL,
  idempotency_key varchar(300) NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX outbox_pending_idx
  ON platform.outbox_events (available_at, occurred_at)
  WHERE published_at IS NULL;

CREATE TABLE integration.external_mappings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  resource_id uuid NOT NULL,
  provider varchar(50) NOT NULL,
  external_tenant_id varchar(200) NOT NULL,
  external_type varchar(100) NOT NULL,
  external_id varchar(500) NOT NULL,
  external_parent_id varchar(500),
  sync_direction varchar(30) NOT NULL DEFAULT 'bidirectional'
    CHECK (sync_direction IN ('to_external', 'from_external', 'bidirectional')),
  external_version varchar(200),
  internal_version bigint,
  sync_status varchar(30) NOT NULL DEFAULT 'pending'
    CHECK (sync_status IN ('pending', 'synced', 'failed', 'conflict', 'disabled')),
  last_synced_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, external_tenant_id, external_type, external_id),
  FOREIGN KEY (tenant_id, resource_id)
    REFERENCES platform.resources(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX external_mappings_resource_idx
  ON integration.external_mappings (tenant_id, resource_id, provider);

COMMIT;

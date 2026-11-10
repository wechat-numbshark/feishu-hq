BEGIN;

CREATE TABLE authz.roles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  code citext NOT NULL,
  name varchar(200) NOT NULL,
  description text,
  role_kind varchar(30) NOT NULL DEFAULT 'business'
    CHECK (role_kind IN ('platform', 'business', 'data_domain', 'external')),
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE authz.policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  code citext NOT NULL,
  name varchar(200) NOT NULL,
  effect varchar(10) NOT NULL CHECK (effect IN ('allow', 'deny')),
  document jsonb NOT NULL,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'testing', 'active', 'retired')),
  valid_from timestamptz,
  valid_to timestamptz,
  created_by uuid,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code, policy_version),
  CHECK (jsonb_typeof(document) = 'object'),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE INDEX policies_active_idx
  ON authz.policies (tenant_id, status, code)
  WHERE deleted_at IS NULL;

CREATE TABLE authz.role_bindings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL,
  subject_type varchar(30) NOT NULL
    CHECK (subject_type IN ('person', 'service', 'group')),
  subject_id uuid NOT NULL,
  scope_resource_id uuid,
  scope_org_unit_id uuid,
  valid_from timestamptz,
  valid_to timestamptz,
  granted_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id)
    REFERENCES authz.roles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scope_resource_id)
    REFERENCES platform.resources(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scope_org_unit_id)
    REFERENCES platform.org_units(tenant_id, id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE INDEX role_bindings_subject_idx
  ON authz.role_bindings (tenant_id, subject_type, subject_id);

CREATE TABLE authz.access_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  subject_type varchar(30) NOT NULL
    CHECK (subject_type IN ('person', 'service', 'group')),
  subject_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  actions text[] NOT NULL,
  field_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  approval_instance_id varchar(300),
  granted_by uuid NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id)
    REFERENCES platform.resources(tenant_id, id) ON DELETE CASCADE,
  CHECK (cardinality(actions) > 0),
  CHECK (valid_to > valid_from)
);

CREATE INDEX access_grants_active_idx
  ON authz.access_grants (tenant_id, subject_type, subject_id, valid_to)
  WHERE revoked_at IS NULL;

CREATE TABLE audit.authorization_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  subject_id varchar(300) NOT NULL,
  delegated_by_subject_id varchar(300),
  actor_type varchar(30) NOT NULL,
  action varchar(200) NOT NULL,
  resource_id uuid NOT NULL,
  allowed boolean NOT NULL,
  reason varchar(500) NOT NULL,
  matched_policy_ids text[] NOT NULL DEFAULT '{}',
  masked_field_ids text[] NOT NULL DEFAULT '{}',
  obligations text[] NOT NULL DEFAULT '{}',
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id varchar(200) NOT NULL
);

CREATE INDEX authorization_decisions_trace_idx
  ON audit.authorization_decisions (tenant_id, trace_id, occurred_at);
CREATE INDEX authorization_decisions_subject_idx
  ON audit.authorization_decisions (tenant_id, subject_id, occurred_at DESC);

CREATE TABLE audit.audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id varchar(300) NOT NULL,
  delegated_by_actor_id varchar(300),
  action varchar(200) NOT NULL,
  resource_id uuid,
  resource_type varchar(100),
  outcome varchar(30) NOT NULL
    CHECK (outcome IN ('success', 'failure', 'denied', 'partial')),
  change_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id varchar(200) NOT NULL,
  previous_hash varchar(128),
  event_hash varchar(128)
);

CREATE INDEX audit_events_resource_idx
  ON audit.audit_events (tenant_id, resource_id, occurred_at DESC);
CREATE INDEX audit_events_trace_idx
  ON audit.audit_events (tenant_id, trace_id, occurred_at);

COMMIT;


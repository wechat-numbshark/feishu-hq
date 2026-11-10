BEGIN;

-- Migration 0015: AI session ownership, delegation metadata and tool authorization.
-- The AI gateway always executes as the signed-in person. A conversation is
-- scoped to one tenant/person pair, and tool grants are tenant-wide defaults or
-- explicit person grants. Explicit deny always wins over a default grant.

ALTER TABLE platform.ai_conversations
  ADD COLUMN IF NOT EXISTS delegated_by_person_id uuid,
  ADD COLUMN IF NOT EXISTS trace_id varchar(200),
  ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'failed', 'completed')),
  ADD COLUMN IF NOT EXISTS last_tool_call_at timestamptz;

ALTER TABLE platform.ai_conversations
  ADD CONSTRAINT ai_conversations_delegated_by_person_fk
  FOREIGN KEY (tenant_id, delegated_by_person_id)
  REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE platform.ai_messages
  ADD COLUMN IF NOT EXISTS person_id uuid,
  ADD COLUMN IF NOT EXISTS tool_name varchar(200),
  ADD COLUMN IF NOT EXISTS trace_id varchar(200);

UPDATE platform.ai_messages m
SET person_id = c.person_id
FROM platform.ai_conversations c
WHERE c.tenant_id = m.tenant_id
  AND c.id = m.conversation_id
  AND m.person_id IS NULL;

ALTER TABLE platform.ai_messages
  ADD CONSTRAINT ai_messages_person_fk
  FOREIGN KEY (tenant_id, person_id)
  REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS platform.ai_tool_authorizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  person_id uuid,
  tool_name varchar(200) NOT NULL,
  action varchar(200) NOT NULL,
  risk_level varchar(2) NOT NULL CHECK (risk_level IN ('L0', 'L1', 'L2', 'L3')),
  data_domain varchar(100) NOT NULL,
  effect varchar(10) NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  valid_from timestamptz,
  valid_to timestamptz,
  granted_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES platform.people(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, granted_by) REFERENCES platform.people(tenant_id, id) ON DELETE RESTRICT,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX ai_tool_authorizations_person_tool_uq
  ON platform.ai_tool_authorizations (tenant_id, person_id, tool_name)
  WHERE person_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ai_tool_authorizations_default_tool_uq
  ON platform.ai_tool_authorizations (tenant_id, tool_name)
  WHERE person_id IS NULL AND deleted_at IS NULL;
CREATE INDEX ai_tool_authorizations_active_idx
  ON platform.ai_tool_authorizations (tenant_id, person_id, tool_name, valid_to)
  WHERE deleted_at IS NULL AND status = 'active';

ALTER TABLE platform.ai_tool_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.ai_tool_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_tool_authorizations_tenant
  ON platform.ai_tool_authorizations
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

-- Seed existing tenants with authenticated-read defaults. L1+ writes still
-- require an explicit person grant or a tenant administrator override.
INSERT INTO platform.ai_tool_authorizations
  (id, tenant_id, person_id, tool_name, action, risk_level, data_domain, effect, status, reason)
SELECT gen_random_uuid(), t.id, NULL, tool_name, action, risk_level, data_domain, 'allow', 'active',
       'authenticated read default'
FROM platform.tenants t
CROSS JOIN (VALUES
  ('query_projects', 'project.project.read', 'L0', 'project'),
  ('query_crm', 'crm.opportunity.read', 'L0', 'crm'),
  ('query_hr', 'hr.requisition.read', 'L0', 'hr'),
  ('query_finance', 'finance.summary.read', 'L0', 'finance'),
  ('search_knowledge', 'knowledge.item.read', 'L0', 'knowledge'),
  ('get_workspace_overview', 'platform.overview.read', 'L0', 'platform')
) AS defaults(tool_name, action, risk_level, data_domain)
WHERE t.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM platform.ai_tool_authorizations a
    WHERE a.tenant_id = t.id AND a.person_id IS NULL AND a.tool_name = defaults.tool_name
      AND a.deleted_at IS NULL
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.ai_tool_authorizations TO hq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform TO hq_app;

COMMIT;

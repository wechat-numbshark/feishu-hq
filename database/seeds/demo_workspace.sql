BEGIN;

INSERT INTO platform.tenants (id, code, name, deployment_mode, data_region, settings)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  'demo-weilan',
  '未蓝科技',
  'saas',
  'cn-east',
  '{"plan":"professional","member_count":28,"demo":true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  settings = EXCLUDED.settings;

INSERT INTO platform.people (id, tenant_id, display_name, legal_name, primary_email, classification)
VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '总部管理员',
  '总部管理员',
  'demo@feishu-hq.local',
  'confidential'
)
ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO authz.roles (id, tenant_id, code, name, description, role_kind, status)
VALUES (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'tenant_admin',
  '企业管理员',
  '体验企业的管理员角色',
  'platform',
  'active'
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason)
VALUES (
  '40000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'person',
  '20000000-0000-4000-8000-000000000001',
  'staging demo workspace administrator'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform.workspace_snapshots (
  id, tenant_id, snapshot_date, metrics, decisions, connections, modules
)
VALUES (
  '50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  CURRENT_DATE,
  '{
    "monthly_receipts":{"value":"¥ 1,284,600","change":"+18.6%","progress":71},
    "sales_pipeline":{"value":"¥ 3,760,000","new_this_week":8},
    "project_health":{"value":75,"healthy":9,"total":12},
    "headcount":{"value":28,"joined_this_month":2}
  }'::jsonb,
  '[
    {"id":"decision-project-risk","level":"high","title":"华东交付项目延期风险","summary":"预计延期 6 天 · 项目负责人请求增派 2 人","action":"查看"},
    {"id":"decision-discount","level":"medium","title":"销售折扣审批","summary":"远山零售 · 合同金额 ¥480,000 · 申请 12% 折扣","action":"审批"},
    {"id":"decision-recruiting","level":"normal","title":"高级产品经理终面确认","summary":"候选人已完成三轮面试 · 等待管理者确认","action":"确认"}
  ]'::jsonb,
  '[
    {"key":"feishu","name":"飞书组织与协作","status":"awaiting_credentials","records":0},
    {"key":"postgres","name":"总部数据平台","status":"connected","records":1284},
    {"key":"nas","name":"可道云 NAS","status":"planned","records":421},
    {"key":"ai","name":"企业 AI 网关","status":"configured","records":42}
  ]'::jsonb,
  '{"projects":12,"crm_opportunities":31,"employees":28,"finance_pending":3,"it_assets":86,"knowledge_items":1284}'::jsonb
)
ON CONFLICT (tenant_id, snapshot_date) DO UPDATE SET
  metrics = EXCLUDED.metrics,
  decisions = EXCLUDED.decisions,
  connections = EXCLUDED.connections,
  modules = EXCLUDED.modules,
  updated_at = now();

COMMIT;

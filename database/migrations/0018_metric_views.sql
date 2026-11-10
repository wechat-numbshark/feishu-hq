BEGIN;

-- ═══════════════════════════════════════════════════════════
-- 0018 · 指标视图（reporting）：有口径、有来源、有权限过滤
-- 口径 = definition/unit；来源 = source(源表/视图)；
-- 权限过滤 = security_invoker 视图沿用调用者(hq_app)的行级安全(RLS)，
--            因此同一指标在不同租户下只聚合本租户数据。
-- ═══════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS reporting;
GRANT USAGE ON SCHEMA reporting TO hq_app;

-- 指标定义（口径 + 来源 + 权限口径），全局配置目录，无租户列。
CREATE TABLE reporting.metric_definitions (
  metric_key text PRIMARY KEY,
  name text NOT NULL,
  unit text NOT NULL,
  definition text NOT NULL,          -- 口径：如何计算
  source text NOT NULL,              -- 来源：源表/源视图
  permission_scope text NOT NULL,    -- 权限过滤：作用域说明
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON reporting.metric_definitions TO hq_app;

INSERT INTO reporting.metric_definitions
  (metric_key, name, unit, definition, source, permission_scope)
VALUES
  ('project.total', '项目总数', 'count', '当前租户全部项目记录数', 'project.projects', '按租户 RLS 隔离(security_invoker)'),
  ('project.active', '进行中项目数', 'count', 'status=active 的项目数', 'project.projects', '按租户 RLS 隔离(security_invoker)'),
  ('project.at_risk', '风险项目数', 'count', 'status=at_risk 的项目数', 'project.projects', '按租户 RLS 隔离(security_invoker)'),
  ('crm.open_pipeline_cents', '销售漏斗在途金额', 'cents', 'stage 不属于 won/lost 的商机金额合计', 'crm.opportunities', '按租户 RLS 隔离(security_invoker)'),
  ('hr.open_requisition_headcount', '在招岗位人数', 'headcount', 'status=open 的招聘需求 headcount 合计', 'hr.job_requisitions', '按租户 RLS 隔离(security_invoker)'),
  ('finance.pending_expense_cents', '待审报销金额', 'cents', 'status 属于 submitted/approved 的报销金额合计', 'finance.expenses', '按租户 RLS 隔离(security_invoker)');

-- 指标取值视图：以调用者身份执行 → 底层业务表 RLS 生效 → 仅聚合本租户数据。
CREATE VIEW reporting.v_metric_values WITH (security_invoker = true) AS
  SELECT 'project.total'::text AS metric_key, count(*)::numeric AS metric_value FROM project.projects
  UNION ALL SELECT 'project.active', count(*) FILTER (WHERE status = 'active')::numeric FROM project.projects
  UNION ALL SELECT 'project.at_risk', count(*) FILTER (WHERE status = 'at_risk')::numeric FROM project.projects
  UNION ALL SELECT 'crm.open_pipeline_cents', coalesce(sum(amount_cents), 0)::numeric FROM crm.opportunities WHERE stage NOT IN ('won', 'lost')
  UNION ALL SELECT 'hr.open_requisition_headcount', coalesce(sum(headcount), 0)::numeric FROM hr.job_requisitions WHERE status = 'open'
  UNION ALL SELECT 'finance.pending_expense_cents', coalesce(sum(amount_cents), 0)::numeric FROM finance.expenses WHERE status IN ('submitted', 'approved');
GRANT SELECT ON reporting.v_metric_values TO hq_app;

-- 指标目录视图：口径 + 来源 + 权限口径 + 实时值，一屏可核。
CREATE VIEW reporting.v_metric_catalog WITH (security_invoker = true) AS
  SELECT d.metric_key, d.name, d.unit,
         d.definition AS caliber, d.source AS data_source, d.permission_scope,
         v.metric_value
  FROM reporting.metric_definitions d
  LEFT JOIN reporting.v_metric_values v ON v.metric_key = d.metric_key;
GRANT SELECT ON reporting.v_metric_catalog TO hq_app;

COMMIT;

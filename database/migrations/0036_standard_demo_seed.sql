-- 0036: 标准体验企业的最小可信业务数据
-- 目的：首次进入"体验企业"时不再是空表——项目、客户、商机、任务、回款、知识各有可读数据，
-- 且全部 is_demo=true，可被"重置体验数据"识别。幂等：固定 UUID + ON CONFLICT DO NOTHING。

BEGIN;

-- 客户
INSERT INTO crm.accounts (id, tenant_id, name, industry, company_size, website, owner_person_id, account_type, is_demo)
VALUES
  ('10000000-0000-4000-8000-00000000c001', '10000000-0000-4000-8000-000000000001', '远山零售', 'retail', '201-500', 'https://yuanshan.example.com', '20000000-0000-4000-8000-000000000001', 'customer', true),
  ('10000000-0000-4000-8000-00000000c002', '10000000-0000-4000-8000-000000000001', '拾光餐饮', 'other', '51-200', NULL, '20000000-0000-4000-8000-000000000001', 'prospect', true),
  ('10000000-0000-4000-8000-00000000c003', '10000000-0000-4000-8000-000000000001', '云启科技', 'tech', '51-200', 'https://yunqi.example.com', '20000000-0000-4000-8000-000000000001', 'prospect', true),
  ('10000000-0000-4000-8000-00000000c004', '10000000-0000-4000-8000-000000000001', '北辰物流', 'other', '201-500', NULL, '20000000-0000-4000-8000-000000000001', 'prospect', true)
ON CONFLICT DO NOTHING;

-- 商机（覆盖 5 个阶段）
INSERT INTO crm.opportunities (id, tenant_id, name, customer_name, owner_person_id, amount_cents, stage, win_probability, expected_close_date, account_id, is_demo)
VALUES
  ('10000000-0000-4000-8000-00000000d001', '10000000-0000-4000-8000-000000000001', '远山门店数字化升级', '远山零售', '20000000-0000-4000-8000-000000000001', 48000000, 'negotiation', 75, current_date + 18, '10000000-0000-4000-8000-00000000c001', true),
  ('10000000-0000-4000-8000-00000000d002', '10000000-0000-4000-8000-000000000001', '拾光会员与储值系统', '拾光餐饮', '20000000-0000-4000-8000-000000000001', 22000000, 'proposal', 55, current_date + 35, '10000000-0000-4000-8000-00000000c002', true),
  ('10000000-0000-4000-8000-00000000d003', '10000000-0000-4000-8000-000000000001', '云启数据中台预研', '云启科技', '20000000-0000-4000-8000-000000000001', 96000000, 'qualified', 35, current_date + 60, '10000000-0000-4000-8000-00000000c003', true),
  ('10000000-0000-4000-8000-00000000d004', '10000000-0000-4000-8000-000000000001', '北辰仓配一体化', '北辰物流', '20000000-0000-4000-8000-000000000001', 35000000, 'lead', 20, current_date + 80, '10000000-0000-4000-8000-00000000c004', true),
  ('10000000-0000-4000-8000-00000000d005', '10000000-0000-4000-8000-000000000001', '老客户年度续约', '远山零售', '20000000-0000-4000-8000-000000000001', 18000000, 'won', 100, current_date - 10, '10000000-0000-4000-8000-00000000c001', true)
ON CONFLICT DO NOTHING;

-- 项目
INSERT INTO project.projects (id, tenant_id, source_opportunity_id, code, name, customer_name, owner_person_id, budget_cents, status, start_date, end_date, progress, is_demo)
VALUES
  ('10000000-0000-4000-8000-00000000e001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000d001', 'PRJ-YS-001', '远山零售数字化一期', '远山零售', '20000000-0000-4000-8000-000000000001', 48000000, 'active', current_date - 45, current_date + 75, 45, true),
  ('10000000-0000-4000-8000-00000000e002', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000d003', 'PRJ-YQ-001', '云启数据中台预研', '云启科技', '20000000-0000-4000-8000-000000000001', 18000000, 'planning', current_date + 5, current_date + 95, 10, true),
  ('10000000-0000-4000-8000-00000000e003', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000d004', 'PRJ-BC-001', '北辰仓配优化', '北辰物流', '20000000-0000-4000-8000-000000000001', 35000000, 'at_risk', current_date - 30, current_date + 30, 60, true)
ON CONFLICT DO NOTHING;

-- 里程碑
INSERT INTO project.milestones (id, tenant_id, project_id, name, due_date, status)
VALUES
  ('10000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e001', '门店试点上线', current_date - 5, 'completed'),
  ('10000000-0000-4000-8000-00000000f002', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e001', '全量门店推广', current_date + 40, 'in_progress'),
  ('10000000-0000-4000-8000-00000000f003', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e003', '仓配流程验收', current_date + 12, 'pending')
ON CONFLICT DO NOTHING;

-- 任务
INSERT INTO project.tasks (id, tenant_id, project_id, title, assignee_person_id, reporter_person_id, priority, status, due_date)
VALUES
  ('10000000-0000-4000-8000-000000010001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e001', '完成门店库存接口联调', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'high', 'in_progress', current_date + 3),
  ('10000000-0000-4000-8000-000000010002', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e001', '输出试点门店复盘报告', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'medium', 'todo', current_date + 7),
  ('10000000-0000-4000-8000-000000010003', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e002', '确认数据源与口径清单', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'high', 'todo', current_date + 10),
  ('10000000-0000-4000-8000-000000010004', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e003', '梳理仓配异常处理流程', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'critical', 'blocked', current_date - 1)
ON CONFLICT DO NOTHING;

-- 回款计划
INSERT INTO finance.payment_plans (id, tenant_id, project_id, customer_name, amount_cents, due_date, milestone, status, is_demo)
VALUES
  ('10000000-0000-4000-8000-000000012001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e001', '远山零售', 14400000, current_date - 20, '首期款 30%', 'paid', true),
  ('10000000-0000-4000-8000-000000012002', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e001', '远山零售', 19200000, current_date + 25, '试点上线 40%', 'planned', true),
  ('10000000-0000-4000-8000-000000012003', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000e003', '北辰物流', 10500000, current_date + 15, '验收款 30%', 'invoiced', true)
ON CONFLICT DO NOTHING;

-- 知识
INSERT INTO knowledge.items (id, tenant_id, title, content, content_type, source_type, classification, owner_person_id, published_at, index_status)
VALUES
  ('10000000-0000-4000-8000-000000014001', '10000000-0000-4000-8000-000000000001', '门店数字化交付检查清单', '上线前检查：网络、POS 版本、库存初始化、权限矩阵、培训签到、应急预案。', 'markdown', 'manual', 'internal', '20000000-0000-4000-8000-000000000001', now(), 'pending'),
  ('10000000-0000-4000-8000-000000014002', '10000000-0000-4000-8000-000000000001', '数据中台需求访谈提纲', '业务目标、指标口径、数据源、更新频率、权限边界、验收标准。', 'markdown', 'manual', 'internal', '20000000-0000-4000-8000-000000000001', now(), 'pending'),
  ('10000000-0000-4000-8000-000000014003', '10000000-0000-4000-8000-000000000001', '仓配项目风险台账', '主要风险：客户仓库网络不稳定、历史数据缺失、验收标准未量化。', 'markdown', 'manual', 'confidential', '20000000-0000-4000-8000-000000000001', now(), 'pending')
ON CONFLICT DO NOTHING;

-- 首页快照（让经营总览有可信数字，而不是 —）
INSERT INTO platform.workspace_snapshots (id, tenant_id, snapshot_date, metrics, decisions, connections, modules)
VALUES (
  '10000000-0000-4000-8000-000000016001',
  '10000000-0000-4000-8000-000000000001',
  current_date,
  '{"monthly_receipts":{"value":"¥ 1,440,000","change":"+12.4%","progress":64},"sales_pipeline":{"value":"¥ 2,010,000","new_this_week":2},"project_health":{"value":72,"healthy":2,"total":3},"headcount":{"value":28,"joined_this_month":1}}'::jsonb,
  '[{"id":"decision-project-risk","level":"high","title":"北辰仓配项目存在延期风险","summary":"关键任务阻塞 1 天 · 建议今日协调客户网络","action":"查看"},{"id":"decision-receivable","level":"medium","title":"远山二期回款待确认","summary":"¥192,000 将于 25 天后到期","action":"跟进"}]'::jsonb,
  '[{"key":"feishu","name":"飞书组织与协作","status":"configured","records":28},{"key":"postgres","name":"总部数据平台","status":"connected","records":11},{"key":"ai","name":"企业 AI 网关","status":"configured","records":0}]'::jsonb,
  '{"projects":3,"crm_opportunities":5,"employees":28,"finance_pending":2,"it_assets":0,"knowledge_items":3}'::jsonb
)
ON CONFLICT (tenant_id, snapshot_date) DO UPDATE
SET metrics = EXCLUDED.metrics, decisions = EXCLUDED.decisions,
    connections = EXCLUDED.connections, modules = EXCLUDED.modules, updated_at = now();

COMMIT;

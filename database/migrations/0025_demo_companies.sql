-- 0025 · 演示公司预置（一键换公司）：恒精精密制造 + 云枢软件
-- 两个独立演示租户（RLS 完全隔离），各带组织/人员/角色/审批流/AI 授权与代表性业务数据，
-- 与既有「总部 OS 体验企业」(DEMO_TENANT) 并列，由 POST /v1/session/demo {company} 一键切换。
-- 全部固定 UUID + ON CONFLICT DO NOTHING，可重复执行（幂等）。
BEGIN;

-- ── 0. 保障「总部 OS 体验企业」（standard）在全新安装中存在 ──
-- （历史上它只由验收种子创建；此处幂等补齐租户/管理员/组织，已有环境不受影响）
INSERT INTO platform.tenants (id, code, name, deployment_mode, status)
VALUES ('10000000-0000-4000-8000-000000000001','demo','总部 OS 体验企业','private','active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO platform.people (id, tenant_id, display_name, primary_email, status, classification)
VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','体验管理员','admin@demo.feishu-hq.local','active','internal')
ON CONFLICT (id) DO NOTHING;
INSERT INTO platform.legal_entities (id, tenant_id, code, name, status)
SELECT '10000000-0000-4000-8000-00000000e001','10000000-0000-4000-8000-000000000001','LE-DEMO','体验企业主法人','active'
WHERE NOT EXISTS (SELECT 1 FROM platform.legal_entities le WHERE le.tenant_id='10000000-0000-4000-8000-000000000001');
INSERT INTO platform.org_units (id, tenant_id, code, name, type, status)
SELECT '10000000-0000-4000-8000-00000000e002','10000000-0000-4000-8000-000000000001','DEMO-HQ','总部','company','active'
WHERE NOT EXISTS (SELECT 1 FROM platform.org_units ou WHERE ou.tenant_id='10000000-0000-4000-8000-000000000001' AND ou.deleted_at IS NULL);
INSERT INTO platform.employments (id, tenant_id, person_id, legal_entity_id, org_unit_id, employee_number, employment_type, status, start_date)
SELECT '10000000-0000-4000-8000-00000000e003','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
       (SELECT id FROM platform.legal_entities WHERE tenant_id='10000000-0000-4000-8000-000000000001' ORDER BY created_at LIMIT 1),
       (SELECT id FROM platform.org_units WHERE tenant_id='10000000-0000-4000-8000-000000000001' AND deleted_at IS NULL ORDER BY created_at LIMIT 1),
       'DEMO-0001','employee','active',current_date - interval '30 days'
WHERE NOT EXISTS (SELECT 1 FROM platform.employments e WHERE e.tenant_id='10000000-0000-4000-8000-000000000001' AND e.person_id='20000000-0000-4000-8000-000000000001' AND e.deleted_at IS NULL);
INSERT INTO platform.approval_flows (id, tenant_id, code, name, module, steps, auto_approve_if_no_approver, is_active) VALUES
('10000000-0000-4000-8000-00000000e011','10000000-0000-4000-8000-000000000001','expense','费用报销审批','finance','[{"order":1,"type":"manager","label":"直属上级"}]'::jsonb,false,true),
('10000000-0000-4000-8000-00000000e012','10000000-0000-4000-8000-000000000001','leave_request','请假审批','hr','[{"order":1,"type":"manager","label":"直属上级"}]'::jsonb,false,true)
ON CONFLICT (tenant_id, code) DO NOTHING;
INSERT INTO platform.ai_tool_authorizations (id, tenant_id, person_id, tool_name, action, risk_level, data_domain, effect, status, reason)
SELECT gen_random_uuid(),'10000000-0000-4000-8000-000000000001',NULL,x.tool,x.action,'L0',x.domain,'allow','active','demo company preset'
FROM (VALUES
  ('query_projects','project.project.read','project'),
  ('query_crm','crm.opportunity.read','crm'),
  ('query_hr','hr.requisition.read','hr'),
  ('query_finance','finance.summary.read','finance'),
  ('search_knowledge','knowledge.item.read','knowledge'),
  ('get_workspace_overview','platform.overview.read','platform')
) AS x(tool,action,domain)
ON CONFLICT (tenant_id, tool_name) WHERE person_id IS NULL AND deleted_at IS NULL DO NOTHING;
INSERT INTO platform.tenant_settings (tenant_id, namespace, key, value, updated_at)
VALUES ('10000000-0000-4000-8000-000000000001','finance','approval_threshold_cents','500000'::jsonb,now())
ON CONFLICT (tenant_id, namespace, key) DO UPDATE SET value = '500000'::jsonb, updated_at = now();

-- ═══════════════════════════════════════════════════════════════
-- 公司一：恒精精密制造股份有限公司（离散制造 · MTO）
-- 租户 d0000001-0000-4000-8000-000000000001
-- ═══════════════════════════════════════════════════════════════
INSERT INTO platform.tenants (id, code, name, deployment_mode, status)
VALUES ('d0000001-0000-4000-8000-000000000001','demo-mfg','恒精精密制造','private','active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform.legal_entities (id, tenant_id, code, name, status)
VALUES ('d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-000000000001','LE-MFG','恒精精密制造股份有限公司','active')
ON CONFLICT (id) DO NOTHING;

-- 人员（aa01=总经理/演示管理员 … aa08=财务总监）
INSERT INTO platform.people (id, tenant_id, display_name, primary_email, status, classification) VALUES
('d0000001-0000-4000-8000-00000000aa01','d0000001-0000-4000-8000-000000000001','陈志恒','zh@hengjing.demo','active','internal'),
('d0000001-0000-4000-8000-00000000aa02','d0000001-0000-4000-8000-000000000001','刘慧敏','liu@hengjing.demo','active','internal'),
('d0000001-0000-4000-8000-00000000aa03','d0000001-0000-4000-8000-000000000001','王芳','wang@hengjing.demo','active','internal'),
('d0000001-0000-4000-8000-00000000aa04','d0000001-0000-4000-8000-000000000001','赵国庆','zhao@hengjing.demo','active','internal'),
('d0000001-0000-4000-8000-00000000aa05','d0000001-0000-4000-8000-000000000001','李雷','lilei@hengjing.demo','active','internal'),
('d0000001-0000-4000-8000-00000000aa06','d0000001-0000-4000-8000-000000000001','周建军','zhou@hengjing.demo','active','internal'),
('d0000001-0000-4000-8000-00000000aa07','d0000001-0000-4000-8000-000000000001','孙倩','sun@hengjing.demo','active','internal'),
('d0000001-0000-4000-8000-00000000aa08','d0000001-0000-4000-8000-000000000001','赵敏','zhaomin@hengjing.demo','active','internal')
ON CONFLICT (id) DO NOTHING;

-- 部门（ac01 总经办 … ac07 财务部）
INSERT INTO platform.org_units (id, tenant_id, code, name, type, status, manager_person_id) VALUES
('d0000001-0000-4000-8000-00000000ac01','d0000001-0000-4000-8000-000000000001','MFG-EXEC','总经办','department','active','d0000001-0000-4000-8000-00000000aa01'),
('d0000001-0000-4000-8000-00000000ac02','d0000001-0000-4000-8000-000000000001','MFG-SALES','销售部','department','active','d0000001-0000-4000-8000-00000000aa02'),
('d0000001-0000-4000-8000-00000000ac03','d0000001-0000-4000-8000-000000000001','MFG-TECH','研发工艺部','department','active','d0000001-0000-4000-8000-00000000aa03'),
('d0000001-0000-4000-8000-00000000ac04','d0000001-0000-4000-8000-000000000001','MFG-PROD','生产部','department','active','d0000001-0000-4000-8000-00000000aa04'),
('d0000001-0000-4000-8000-00000000ac05','d0000001-0000-4000-8000-000000000001','MFG-PURCHASE','采购部','department','active','d0000001-0000-4000-8000-00000000aa06'),
('d0000001-0000-4000-8000-00000000ac06','d0000001-0000-4000-8000-000000000001','MFG-QC','质检部','department','active','d0000001-0000-4000-8000-00000000aa07'),
('d0000001-0000-4000-8000-00000000ac07','d0000001-0000-4000-8000-000000000001','MFG-FINANCE','财务部','department','active','d0000001-0000-4000-8000-00000000aa08')
ON CONFLICT (id) DO NOTHING;

-- 雇佣（ae01..ae08；采购专员→采购经理，其余业务岗→总经理）
INSERT INTO platform.employments (id, tenant_id, person_id, legal_entity_id, org_unit_id, manager_person_id, employee_number, employment_type, status, start_date) VALUES
('d0000001-0000-4000-8000-00000000ae01','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa01','d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-00000000ac01',NULL,'HJ-0001','employee','active',current_date - interval '2200 days'),
('d0000001-0000-4000-8000-00000000ae02','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa02','d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-00000000ac02','d0000001-0000-4000-8000-00000000aa01','HJ-0002','employee','active',current_date - interval '1500 days'),
('d0000001-0000-4000-8000-00000000ae03','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa03','d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-00000000ac03','d0000001-0000-4000-8000-00000000aa01','HJ-0003','employee','active',current_date - interval '1200 days'),
('d0000001-0000-4000-8000-00000000ae04','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa04','d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-00000000ac04','d0000001-0000-4000-8000-00000000aa01','HJ-0004','employee','active',current_date - interval '900 days'),
('d0000001-0000-4000-8000-00000000ae05','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa05','d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-00000000ac05','d0000001-0000-4000-8000-00000000aa06','HJ-0005','employee','active',current_date - interval '400 days'),
('d0000001-0000-4000-8000-00000000ae06','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa06','d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-00000000ac05','d0000001-0000-4000-8000-00000000aa01','HJ-0006','employee','active',current_date - interval '1000 days'),
('d0000001-0000-4000-8000-00000000ae07','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa07','d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-00000000ac06','d0000001-0000-4000-8000-00000000aa01','HJ-0007','employee','active',current_date - interval '600 days'),
('d0000001-0000-4000-8000-00000000ae08','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa08','d0000001-0000-4000-8000-000000000101','d0000001-0000-4000-8000-00000000ac07','d0000001-0000-4000-8000-00000000aa01','HJ-0008','employee','active',current_date - interval '1800 days')
ON CONFLICT (id) DO NOTHING;

-- 岗位角色 + 绑定（采购经理=manager，财务总监=finance_manager）
INSERT INTO authz.roles (id, tenant_id, code, name, role_kind, status) VALUES
('d0000001-0000-4000-8000-00000000af01','d0000001-0000-4000-8000-000000000001','manager','部门主管','business','active'),
('d0000001-0000-4000-8000-00000000af02','d0000001-0000-4000-8000-000000000001','finance_manager','财务管理员','business','active')
ON CONFLICT (tenant_id, code) DO NOTHING;
INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason) VALUES
('d0000001-0000-4000-8000-00000000b001','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000af01','person','d0000001-0000-4000-8000-00000000aa06','演示预置'),
('d0000001-0000-4000-8000-00000000b002','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000af02','person','d0000001-0000-4000-8000-00000000aa08','演示预置')
ON CONFLICT (id) DO NOTHING;

-- 审批流（确定性 person 步）
INSERT INTO platform.approval_flows (id, tenant_id, code, name, module, steps, auto_approve_if_no_approver, is_active) VALUES
('d0000001-0000-4000-8000-00000000b011','d0000001-0000-4000-8000-000000000001','expense','费用报销审批','finance','[{"order":1,"type":"manager","label":"直属上级"},{"order":2,"type":"person","person_id":"d0000001-0000-4000-8000-00000000aa08","label":"财务总监"}]'::jsonb,false,true),
('d0000001-0000-4000-8000-00000000b012','d0000001-0000-4000-8000-000000000001','leave_request','请假审批','hr','[{"order":1,"type":"manager","label":"直属上级"}]'::jsonb,false,true),
('d0000001-0000-4000-8000-00000000b013','d0000001-0000-4000-8000-000000000001','contract','销售合同审批','sales','[{"order":1,"type":"manager","label":"直属上级"}]'::jsonb,false,true)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- AI 工具 L0 只读默认放行（写工具由管理员会话自动放行）
INSERT INTO platform.ai_tool_authorizations (id, tenant_id, person_id, tool_name, action, risk_level, data_domain, effect, status, reason)
SELECT gen_random_uuid(),'d0000001-0000-4000-8000-000000000001',NULL,x.tool,x.action,'L0',x.domain,'allow','active','demo company preset'
FROM (VALUES
  ('query_projects','project.project.read','project'),
  ('query_crm','crm.opportunity.read','crm'),
  ('query_hr','hr.requisition.read','hr'),
  ('query_finance','finance.summary.read','finance'),
  ('search_knowledge','knowledge.item.read','knowledge'),
  ('get_workspace_overview','platform.overview.read','platform')
) AS x(tool,action,domain)
ON CONFLICT (tenant_id, tool_name) WHERE person_id IS NULL AND deleted_at IS NULL DO NOTHING;

INSERT INTO platform.tenant_settings (tenant_id, namespace, key, value, updated_at)
VALUES ('d0000001-0000-4000-8000-000000000001','finance','approval_threshold_cents','500000'::jsonb,now())
ON CONFLICT (tenant_id, namespace, key) DO UPDATE SET value = '500000'::jsonb, updated_at = now();

-- 薪资（工艺工程师，供 ABAC 演示）
INSERT INTO hr.salary_components (id, tenant_id, person_id, employment_id, component_type, name, amount_cents, is_fixed, effective_from)
SELECT 'd0000001-0000-4000-8000-00000000ba90','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000aa03',e.id,'base','基本工资',4200000,true,current_date - interval '60 days'
FROM platform.employments e
WHERE e.tenant_id='d0000001-0000-4000-8000-000000000001' AND e.person_id='d0000001-0000-4000-8000-00000000aa03' LIMIT 1
ON CONFLICT (id) DO NOTHING;

-- ── 恒精业务数据 ──
-- 战略 OKR
INSERT INTO strategy.periods (id, tenant_id, label, period_type, start_date, end_date, status)
VALUES ('d0000001-0000-4000-8000-00000000ba01','d0000001-0000-4000-8000-000000000001','FY2026','year','2026-01-01','2026-12-31','active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO strategy.objectives (id, tenant_id, period_id, owner_person_id, title, type, status, progress, confidence)
VALUES ('d0000001-0000-4000-8000-00000000ba02','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba01','d0000001-0000-4000-8000-00000000aa01','制造提质保交付，营收破亿','company','active',68,75)
ON CONFLICT (id) DO NOTHING;
INSERT INTO strategy.key_results (id, tenant_id, objective_id, owner_person_id, title, kr_type, target_value, unit, status)
VALUES
('d0000001-0000-4000-8000-00000000ba03','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba02','d0000001-0000-4000-8000-00000000aa07','机加工一次合格率','percentage',99,'%','active'),
('d0000001-0000-4000-8000-00000000ba04','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba02','d0000001-0000-4000-8000-00000000aa04','订单准时交付率 OTD','percentage',98,'%','active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO strategy.checkins (id, tenant_id, key_result_id, author_person_id, value_at_checkin, confidence, summary, checked_at)
VALUES
('d0000001-0000-4000-8000-00000000ba05','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba03','d0000001-0000-4000-8000-00000000aa07',98.9,80,'SPO 投放后稳步爬升',now() - interval '3 days'),
('d0000001-0000-4000-8000-00000000ba06','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba04','d0000001-0000-4000-8000-00000000aa04',97.5,72,'瓶颈在热处理产能',now() - interval '3 days')
ON CONFLICT (id) DO NOTHING;

-- CRM
INSERT INTO crm.accounts (id, tenant_id, name, industry, company_size, city) VALUES
('d0000001-0000-4000-8000-00000000ba10','d0000001-0000-4000-8000-000000000001','华驰动力','汽车零部件制造','501-2000','苏州'),
('d0000001-0000-4000-8000-00000000ba11','d0000001-0000-4000-8000-000000000001','恒创机电','通用设备制造','201-500','常州')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.opportunities (id, tenant_id, name, customer_name, account_id, owner_person_id, amount_cents, stage, win_probability, expected_close_date, won_at, notes) VALUES
('d0000001-0000-4000-8000-00000000ba12','d0000001-0000-4000-8000-000000000001','华驰年框 HX 传动轴','华驰动力','d0000001-0000-4000-8000-00000000ba10','d0000001-0000-4000-8000-00000000aa02',800000000,'won',100,'2026-08-20',now() - interval '30 days','年度框架已中标'),
('d0000001-0000-4000-8000-00000000ba13','d0000001-0000-4000-8000-000000000001','恒创 CNC 结构件二期','恒创机电','d0000001-0000-4000-8000-00000000ba11','d0000001-0000-4000-8000-00000000aa02',320000000,'proposal',55,'2026-11-15',NULL,'等待打样确认'),
('d0000001-0000-4000-8000-00000000ba14','d0000001-0000-4000-8000-000000000001','华驰新能源轴原型','华驰动力','d0000001-0000-4000-8000-00000000ba10','d0000001-0000-4000-8000-00000000aa02',150000000,'qualified',40,'2026-12-31',NULL,'新能源平台预研')
ON CONFLICT (id) DO NOTHING;

-- 项目与里程碑/任务
INSERT INTO project.projects (id, tenant_id, source_opportunity_id, code, name, customer_name, owner_person_id, budget_cents, status, start_date, end_date, progress)
VALUES ('d0000001-0000-4000-8000-00000000ba20','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba12','HJ-2026-001','华驰年框 HX 传动轴量产项目','华驰动力','d0000001-0000-4000-8000-00000000aa01',800000000,'active','2026-09-01','2027-03-31',62)
ON CONFLICT (id) DO NOTHING;
INSERT INTO project.milestones (id, tenant_id, project_id, name, status, due_date) VALUES
('d0000001-0000-4000-8000-00000000ba21','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba20','PPAP 认可','completed',current_date - interval '10 days'),
('d0000001-0000-4000-8000-00000000ba22','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba20','SOP 量产爬坡','in_progress',current_date + interval '30 days')
ON CONFLICT (id) DO NOTHING;
INSERT INTO project.tasks (id, tenant_id, project_id, milestone_id, title, assignee_person_id, reporter_person_id, priority, status, due_date, actual_hours)
VALUES
('d0000001-0000-4000-8000-00000000ba23','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba20','d0000001-0000-4000-8000-00000000ba21','PPAP 文件包提交','d0000001-0000-4000-8000-00000000aa03','d0000001-0000-4000-8000-00000000aa01','high','done',current_date - interval '12 days',16),
('d0000001-0000-4000-8000-00000000ba24','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba20','d0000001-0000-4000-8000-00000000ba22','产线 SPO 参数固化','d0000001-0000-4000-8000-00000000aa04','d0000001-0000-4000-8000-00000000aa01','critical','in_progress',current_date + interval '7 days',8)
ON CONFLICT (id) DO NOTHING;

-- 制造主数据：物料/产品 + 已发布 BOM + 工艺路线
INSERT INTO mfg.parts (id, tenant_id, part_number, name, kind, uom, spec, safety_stock, status) VALUES
('d0000001-0000-4000-8000-00000000ba30','d0000001-0000-4000-8000-000000000001','MAT-40CR-BAR','40Cr 合金钢棒料','raw','KG','Φ45×6000',500,'active'),
('d0000001-0000-4000-8000-00000000ba31','d0000001-0000-4000-8000-000000000001','HX-SHAFT-001','HX 系列传动轴总成','product','PCS','HX-Φ32-L480',100,'active'),
('d0000001-0000-4000-8000-00000000ba32','d0000001-0000-4000-8000-000000000001','CNC-BRKT-014','CNC 结构件 014','product','PCS','6061-T6',50,'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO mfg.boms (id, tenant_id, product_part_id, version, status, effective_date)
VALUES ('d0000001-0000-4000-8000-00000000ba33','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba31','V1.2','released',current_date - interval '45 days')
ON CONFLICT (id) DO NOTHING;
INSERT INTO mfg.bom_lines (id, tenant_id, bom_id, child_part_id, position_no, quantity, scrap_rate)
VALUES ('d0000001-0000-4000-8000-00000000ba34','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba33','d0000001-0000-4000-8000-00000000ba30',10,2.5,0.02)
ON CONFLICT (id) DO NOTHING;
INSERT INTO mfg.routings (id, tenant_id, product_part_id, version, status)
VALUES ('d0000001-0000-4000-8000-00000000ba35','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba31','V1.1','released')
ON CONFLICT (id) DO NOTHING;
INSERT INTO mfg.routing_ops (id, tenant_id, routing_id, seq_no, operation_no, name, work_center, standard_hours, inspect) VALUES
('d0000001-0000-4000-8000-00000000ba36','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba35',10,'10','车削','WC-CNC-01',0.5,true),
('d0000001-0000-4000-8000-00000000ba37','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba35',20,'20','磨削','WC-GRIND-01',0.3,true)
ON CONFLICT (id) DO NOTHING;

-- 工单：1 个已完工（OTD 达成 + 报工良率 98.9%）+ 2 个在制
INSERT INTO mfg.work_orders (id, tenant_id, wo_number, product_part_id, project_id, bom_id, routing_id, planned_qty, completed_qty, status, priority, planned_start, planned_finish, actual_finish) VALUES
('d0000001-0000-4000-8000-00000000ba40','d0000001-0000-4000-8000-000000000001','WO-2026-018','d0000001-0000-4000-8000-00000000ba31','d0000001-0000-4000-8000-00000000ba20','d0000001-0000-4000-8000-00000000ba33','d0000001-0000-4000-8000-00000000ba35',1300,1300,'completed','high',current_date - interval '20 days',current_date - interval '5 days',current_date - interval '6 days'),
('d0000001-0000-4000-8000-00000000ba41','d0000001-0000-4000-8000-000000000001','WO-2026-019','d0000001-0000-4000-8000-00000000ba31','d0000001-0000-4000-8000-00000000ba20','d0000001-0000-4000-8000-00000000ba33','d0000001-0000-4000-8000-00000000ba35',800,320,'released','high',current_date - interval '3 days',current_date + interval '12 days',NULL),
('d0000001-0000-4000-8000-00000000ba42','d0000001-0000-4000-8000-000000000001','WO-2026-020','d0000001-0000-4000-8000-00000000ba31',NULL,'d0000001-0000-4000-8000-00000000ba33','d0000001-0000-4000-8000-00000000ba35',200,0,'released','medium',current_date, current_date + interval '20 days',NULL)
ON CONFLICT (id) DO NOTHING;
INSERT INTO mfg.work_order_ops (id, tenant_id, work_order_id, seq_no, operation_no, name, work_center, standard_hours, inspect) VALUES
('d0000001-0000-4000-8000-00000000ba43','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba40',10,'10','车削','WC-CNC-01',0.5,true),
('d0000001-0000-4000-8000-00000000ba44','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba40',20,'20','磨削','WC-GRIND-01',0.3,true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO mfg.work_reports (id, tenant_id, work_order_id, work_order_op_id, person_id, qty_good, qty_scrap, reported_at)
VALUES ('d0000001-0000-4000-8000-00000000ba45','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba40','d0000001-0000-4000-8000-00000000ba44','d0000001-0000-4000-8000-00000000aa04',1286,14,current_date - interval '6 days')
ON CONFLICT (id) DO NOTHING;

-- 采购：供应商 + 未结 PO
INSERT INTO purchase.suppliers (id, tenant_id, supplier_code, name, contact_person, contact_phone, lead_time_days, status)
VALUES ('d0000001-0000-4000-8000-00000000ba50','d0000001-0000-4000-8000-000000000001','SUP-STEEL-01','宝锐特钢','钱伟','13800000007',7,'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO purchase.purchase_orders (id, tenant_id, po_number, supplier_id, status, total_amount_cents, order_date, expected_delivery_date)
VALUES ('d0000001-0000-4000-8000-00000000ba51','d0000001-0000-4000-8000-000000000001','PO-2026-031','d0000001-0000-4000-8000-00000000ba50','approved',4100000,current_date - interval '2 days',current_date + interval '7 days')
ON CONFLICT (id) DO NOTHING;
INSERT INTO purchase.purchase_order_lines (id, tenant_id, order_id, part_id, quantity, unit_price_cents, amount_cents)
VALUES ('d0000001-0000-4000-8000-00000000ba52','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba51','d0000001-0000-4000-8000-00000000ba30',500,8200,4100000)
ON CONFLICT (id) DO NOTHING;

-- 合同→收款计划→发票（部分回款，形成 0-30 天账龄）
INSERT INTO sales.contracts (id, tenant_id, contract_no, title, contract_type, account_id, opportunity_id, project_id, status, amount_cents, payment_terms, sign_date, start_date, end_date, owner_person_id, signed_at)
VALUES ('d0000001-0000-4000-8000-00000000ba60','d0000001-0000-4000-8000-000000000001','CT-2026-HJ-001','华驰年框供货合同','hardware','d0000001-0000-4000-8000-00000000ba10','d0000001-0000-4000-8000-00000000ba12','d0000001-0000-4000-8000-00000000ba20','signed',800000000,'4:4:2 分三期',current_date - interval '25 days','2026-09-01','2027-08-31','d0000001-0000-4000-8000-00000000aa02',now() - interval '25 days')
ON CONFLICT (id) DO NOTHING;
INSERT INTO finance.payment_plans (id, tenant_id, project_id, customer_name, amount_cents, due_date, milestone, status) VALUES
('d0000001-0000-4000-8000-00000000ba61','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba20','华驰动力',320000000,current_date - interval '10 days','合同:CT-2026-HJ-001','paid'),
('d0000001-0000-4000-8000-00000000ba62','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba20','华驰动力',320000000,current_date + interval '80 days','合同:CT-2026-HJ-001','planned')
ON CONFLICT (id) DO NOTHING;
INSERT INTO finance.invoices (id, tenant_id, invoice_type, invoice_number, counterparty_name, amount_cents, paid_cents, issue_date, due_date, status)
VALUES ('d0000001-0000-4000-8000-00000000ba63','d0000001-0000-4000-8000-000000000001','receivable','INV-HJ-2026-0018','华驰动力',320000000,160000000,current_date - interval '40 days',current_date - interval '10 days','partial')
ON CONFLICT (id) DO NOTHING;

-- 知识库（已索引，可检索）
INSERT INTO knowledge.categories (id, tenant_id, name, slug, description)
VALUES ('d0000001-0000-4000-8000-00000000ba70','d0000001-0000-4000-8000-000000000001','工艺与质量','gongyi-zhiliang','作业指导书与检验规范')
ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge.items (id, tenant_id, category_id, title, content, content_type, source_type, classification, owner_person_id, index_status) VALUES
('d0000001-0000-4000-8000-00000000ba71','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba70','HX 传动轴车削作业指导书','适用 HX-SHAFT-001：粗车留磨量 0.3mm，转速 1200rpm，进给 0.15mm/r；首件必检中径与同轴度。','markdown','manual','internal','d0000001-0000-4000-8000-00000000aa03','indexed'),
('d0000001-0000-4000-8000-00000000ba72','d0000001-0000-4000-8000-000000000001','d0000001-0000-4000-8000-00000000ba70','传动轴成品检验规范','全尺寸抽检 AQL 0.65；硬度 HRC 28-32；磁粉探伤无裂纹显示；每批次留存 SPC 记录 3 年。','markdown','manual','internal','d0000001-0000-4000-8000-00000000aa07','indexed')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 公司二：云枢软件（B2B SaaS + 定制交付）
-- 租户 d0000002-0000-4000-8000-000000000001
-- ═══════════════════════════════════════════════════════════════
INSERT INTO platform.tenants (id, code, name, deployment_mode, status)
VALUES ('d0000002-0000-4000-8000-000000000001','demo-sw','云枢软件','private','active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform.legal_entities (id, tenant_id, code, name, status)
VALUES ('d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-000000000001','LE-SW','云枢软件科技有限公司','active')
ON CONFLICT (id) DO NOTHING;

-- 人员（bb01=CEO/演示管理员 … bb0a=测试）
INSERT INTO platform.people (id, tenant_id, display_name, primary_email, status, classification) VALUES
('d0000002-0000-4000-8000-00000000bb01','d0000002-0000-4000-8000-000000000001','郭诚','guo@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb02','d0000002-0000-4000-8000-000000000001','周明远','zhou@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb03','d0000002-0000-4000-8000-000000000001','罗幻','luo@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb04','d0000002-0000-4000-8000-000000000001','严斌','yan@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb05','d0000002-0000-4000-8000-000000000001','魏东','wei@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb06','d0000002-0000-4000-8000-000000000001','何柳','he@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb07','d0000002-0000-4000-8000-000000000001','林晓菲','lin@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb08','d0000002-0000-4000-8000-000000000001','李默','limo@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb09','d0000002-0000-4000-8000-000000000001','苏娟','su@yunshu.demo','active','internal'),
('d0000002-0000-4000-8000-00000000bb0a','d0000002-0000-4000-8000-000000000001','白山','bai@yunshu.demo','active','internal')
ON CONFLICT (id) DO NOTHING;

-- 部门
INSERT INTO platform.org_units (id, tenant_id, code, name, type, status, manager_person_id) VALUES
('d0000002-0000-4000-8000-00000000bd01','d0000002-0000-4000-8000-000000000001','SW-EXEC','总经办','department','active','d0000002-0000-4000-8000-00000000bb01'),
('d0000002-0000-4000-8000-00000000bd02','d0000002-0000-4000-8000-000000000001','SW-PRODUCT','产品部','department','active','d0000002-0000-4000-8000-00000000bb06'),
('d0000002-0000-4000-8000-00000000bd03','d0000002-0000-4000-8000-000000000001','SW-RND','研发中心','department','active','d0000002-0000-4000-8000-00000000bb02'),
('d0000002-0000-4000-8000-00000000bd04','d0000002-0000-4000-8000-000000000001','SW-HR','人事部','department','active','d0000002-0000-4000-8000-00000000bb03'),
('d0000002-0000-4000-8000-00000000bd05','d0000002-0000-4000-8000-000000000001','SW-FINANCE','财务部','department','active','d0000002-0000-4000-8000-00000000bb04'),
('d0000002-0000-4000-8000-00000000bd06','d0000002-0000-4000-8000-000000000001','SW-IT','IT 部','department','active','d0000002-0000-4000-8000-00000000bb05')
ON CONFLICT (id) DO NOTHING;

-- 雇佣（研发/产品一线 → CTO 或产品总监）
INSERT INTO platform.employments (id, tenant_id, person_id, legal_entity_id, org_unit_id, manager_person_id, employee_number, employment_type, status, start_date) VALUES
('d0000002-0000-4000-8000-00000000bf01','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb01','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd01',NULL,'YS-0001','employee','active',current_date - interval '1800 days'),
('d0000002-0000-4000-8000-00000000bf02','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb02','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd03','d0000002-0000-4000-8000-00000000bb01','YS-0002','employee','active',current_date - interval '1400 days'),
('d0000002-0000-4000-8000-00000000bf03','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb03','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd04','d0000002-0000-4000-8000-00000000bb01','YS-0003','employee','active',current_date - interval '1100 days'),
('d0000002-0000-4000-8000-00000000bf04','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb04','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd05','d0000002-0000-4000-8000-00000000bb01','YS-0004','employee','active',current_date - interval '900 days'),
('d0000002-0000-4000-8000-00000000bf05','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb05','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd06','d0000002-0000-4000-8000-00000000bb02','YS-0005','employee','active',current_date - interval '700 days'),
('d0000002-0000-4000-8000-00000000bf06','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb06','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd02','d0000002-0000-4000-8000-00000000bb01','YS-0006','employee','active',current_date - interval '1000 days'),
('d0000002-0000-4000-8000-00000000bf07','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb07','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd02','d0000002-0000-4000-8000-00000000bb06','YS-0007','employee','active',current_date - interval '500 days'),
('d0000002-0000-4000-8000-00000000bf08','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb08','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd03','d0000002-0000-4000-8000-00000000bb02','YS-0008','employee','active',current_date - interval '800 days'),
('d0000002-0000-4000-8000-00000000bf09','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb09','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd03','d0000002-0000-4000-8000-00000000bb02','YS-0009','employee','active',current_date - interval '600 days'),
('d0000002-0000-4000-8000-00000000bf0a','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb0a','d0000002-0000-4000-8000-000000000201','d0000002-0000-4000-8000-00000000bd03','d0000002-0000-4000-8000-00000000bb02','YS-0010','employee','active',current_date - interval '170 days')
ON CONFLICT (id) DO NOTHING;

-- 角色 + 绑定（CTO=manager，HRD=hr_manager，CFO=finance_manager）
INSERT INTO authz.roles (id, tenant_id, code, name, role_kind, status) VALUES
('d0000002-0000-4000-8000-00000000cf01','d0000002-0000-4000-8000-000000000001','manager','部门主管','business','active'),
('d0000002-0000-4000-8000-00000000cf02','d0000002-0000-4000-8000-000000000001','hr_manager','人事管理员','business','active'),
('d0000002-0000-4000-8000-00000000cf03','d0000002-0000-4000-8000-000000000001','finance_manager','财务管理员','business','active')
ON CONFLICT (tenant_id, code) DO NOTHING;
INSERT INTO authz.role_bindings (id, tenant_id, role_id, subject_type, subject_id, reason) VALUES
('d0000002-0000-4000-8000-00000000d001','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cf01','person','d0000002-0000-4000-8000-00000000bb02','演示预置'),
('d0000002-0000-4000-8000-00000000d002','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cf02','person','d0000002-0000-4000-8000-00000000bb03','演示预置'),
('d0000002-0000-4000-8000-00000000d003','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cf03','person','d0000002-0000-4000-8000-00000000bb04','演示预置')
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform.approval_flows (id, tenant_id, code, name, module, steps, auto_approve_if_no_approver, is_active) VALUES
('d0000002-0000-4000-8000-00000000d011','d0000002-0000-4000-8000-000000000001','expense','费用报销审批','finance','[{"order":1,"type":"manager","label":"直属上级"},{"order":2,"type":"person","person_id":"d0000002-0000-4000-8000-00000000bb04","label":"财务总监"}]'::jsonb,false,true),
('d0000002-0000-4000-8000-00000000d012','d0000002-0000-4000-8000-000000000001','leave_request','请假审批','hr','[{"order":1,"type":"manager","label":"直属上级"},{"order":2,"type":"person","person_id":"d0000002-0000-4000-8000-00000000bb03","label":"HRD"}]'::jsonb,false,true),
('d0000002-0000-4000-8000-00000000d013','d0000002-0000-4000-8000-000000000001','contract','销售合同审批','sales','[{"order":1,"type":"person","person_id":"d0000002-0000-4000-8000-00000000bb04","label":"财务总监"}]'::jsonb,false,true)
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO platform.ai_tool_authorizations (id, tenant_id, person_id, tool_name, action, risk_level, data_domain, effect, status, reason)
SELECT gen_random_uuid(),'d0000002-0000-4000-8000-000000000001',NULL,x.tool,x.action,'L0',x.domain,'allow','active','demo company preset'
FROM (VALUES
  ('query_projects','project.project.read','project'),
  ('query_crm','crm.opportunity.read','crm'),
  ('query_hr','hr.requisition.read','hr'),
  ('query_finance','finance.summary.read','finance'),
  ('search_knowledge','knowledge.item.read','knowledge'),
  ('get_workspace_overview','platform.overview.read','platform')
) AS x(tool,action,domain)
ON CONFLICT (tenant_id, tool_name) WHERE person_id IS NULL AND deleted_at IS NULL DO NOTHING;

INSERT INTO platform.tenant_settings (tenant_id, namespace, key, value, updated_at)
VALUES ('d0000002-0000-4000-8000-000000000001','finance','approval_threshold_cents','500000'::jsonb,now())
ON CONFLICT (tenant_id, namespace, key) DO UPDATE SET value = '500000'::jsonb, updated_at = now();

-- 薪资（后端工程师，供 ABAC 演示）
INSERT INTO hr.salary_components (id, tenant_id, person_id, employment_id, component_type, name, amount_cents, is_fixed, effective_from)
SELECT 'd0000002-0000-4000-8000-00000000cb90','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb08',e.id,'base','基本工资',3600000,true,current_date - interval '60 days'
FROM platform.employments e
WHERE e.tenant_id='d0000002-0000-4000-8000-000000000001' AND e.person_id='d0000002-0000-4000-8000-00000000bb08' LIMIT 1
ON CONFLICT (id) DO NOTHING;

-- ── 云枢业务数据 ──
INSERT INTO strategy.periods (id, tenant_id, label, period_type, start_date, end_date, status)
VALUES ('d0000002-0000-4000-8000-00000000cb01','d0000002-0000-4000-8000-000000000001','FY2026','year','2026-01-01','2026-12-31','active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO strategy.objectives (id, tenant_id, period_id, owner_person_id, title, type, status, progress, confidence)
VALUES ('d0000002-0000-4000-8000-00000000cb02','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb01','d0000002-0000-4000-8000-00000000bb01','SaaS 商业化突破','company','active',55,72)
ON CONFLICT (id) DO NOTHING;
INSERT INTO strategy.key_results (id, tenant_id, objective_id, owner_person_id, title, kr_type, target_value, unit, status) VALUES
('d0000002-0000-4000-8000-00000000cb03','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb02','d0000002-0000-4000-8000-00000000bb01','SaaS 月经常性收入 MRR','numeric',50,'万元','active'),
('d0000002-0000-4000-8000-00000000cb04','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb02','d0000002-0000-4000-8000-00000000bb02','交付项目准交率','percentage',95,'%','active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO strategy.checkins (id, tenant_id, key_result_id, author_person_id, value_at_checkin, confidence, summary, checked_at) VALUES
('d0000002-0000-4000-8000-00000000cb05','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb03','d0000002-0000-4000-8000-00000000bb01',14.4,70,'两家客户升级专业版',now() - interval '2 days'),
('d0000002-0000-4000-8000-00000000cb06','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb04','d0000002-0000-4000-8000-00000000bb02',93,68,'受需求分办耗时影响',now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.accounts (id, tenant_id, name, industry, company_size, city) VALUES
('d0000002-0000-4000-8000-00000000cb10','d0000002-0000-4000-8000-000000000001','恒精精密','汽车零部件制造','201-500','苏州'),
('d0000002-0000-4000-8000-00000000cb11','d0000002-0000-4000-8000-000000000001','华驰动力','汽车零部件制造','501-2000','苏州'),
('d0000002-0000-4000-8000-00000000cb12','d0000002-0000-4000-8000-000000000001','蓝湖智造','工业软件','51-200','杭州')
ON CONFLICT (id) DO NOTHING;
INSERT INTO crm.opportunities (id, tenant_id, name, customer_name, account_id, owner_person_id, amount_cents, stage, win_probability, expected_close_date, won_at, notes) VALUES
('d0000002-0000-4000-8000-00000000cb13','d0000002-0000-4000-8000-000000000001','恒精数字化平台三年服务包','恒精精密','d0000002-0000-4000-8000-00000000cb10','d0000002-0000-4000-8000-00000000bb07',60000000,'won',100,'2026-09-10',now() - interval '18 days','已签约进入交付'),
('d0000002-0000-4000-8000-00000000cb14','d0000002-0000-4000-8000-000000000001','华驰 MES 数据中台','华驰动力','d0000002-0000-4000-8000-00000000cb11','d0000002-0000-4000-8000-00000000bb07',80000000,'negotiation',65,'2026-10-31',NULL,'商务谈判中'),
('d0000002-0000-4000-8000-00000000cb15','d0000002-0000-4000-8000-000000000001','蓝湖 SaaS 标准版 50 席','蓝湖智造','d0000002-0000-4000-8000-00000000cb12','d0000002-0000-4000-8000-00000000bb07',30000000,'proposal',50,'2026-11-30',NULL,'等待 POC 结束')
ON CONFLICT (id) DO NOTHING;

INSERT INTO project.projects (id, tenant_id, source_opportunity_id, code, name, customer_name, owner_person_id, budget_cents, status, start_date, end_date, progress)
VALUES ('d0000002-0000-4000-8000-00000000cb20','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb13','YS-2026-003','恒精数字化交付项目','恒精精密','d0000002-0000-4000-8000-00000000bb02',60000000,'active','2026-09-15','2027-02-28',45)
ON CONFLICT (id) DO NOTHING;
INSERT INTO project.milestones (id, tenant_id, project_id, name, status, due_date) VALUES
('d0000002-0000-4000-8000-00000000cb21','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','一期上线·核心模块','in_progress',current_date + interval '45 days'),
('d0000002-0000-4000-8000-00000000cb22','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','蓝图确认','completed',current_date - interval '8 days')
ON CONFLICT (id) DO NOTHING;
INSERT INTO project.tasks (id, tenant_id, project_id, milestone_id, title, assignee_person_id, reporter_person_id, priority, status, due_date, story_points, estimated_hours, actual_hours) VALUES
('d0000002-0000-4000-8000-00000000cb23','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','d0000002-0000-4000-8000-00000000cb21','MES 接口联调','d0000002-0000-4000-8000-00000000bb08','d0000002-0000-4000-8000-00000000bb02','high','in_progress',current_date + interval '10 days',8,24,12),
('d0000002-0000-4000-8000-00000000cb24','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','d0000002-0000-4000-8000-00000000cb21','交付看板前端','d0000002-0000-4000-8000-00000000bb09','d0000002-0000-4000-8000-00000000bb02','medium','todo',current_date + interval '20 days',5,20,0),
('d0000002-0000-4000-8000-00000000cb25','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','d0000002-0000-4000-8000-00000000cb22','需求蓝图评审','d0000002-0000-4000-8000-00000000bb07','d0000002-0000-4000-8000-00000000bb02','high','done',current_date - interval '9 days',3,8,7)
ON CONFLICT (id) DO NOTHING;
INSERT INTO project.project_members (id, tenant_id, project_id, person_id, role, joined_at) VALUES
('d0000002-0000-4000-8000-00000000cb26','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','d0000002-0000-4000-8000-00000000bb08','member',now()),
('d0000002-0000-4000-8000-00000000cb27','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','d0000002-0000-4000-8000-00000000bb09','member',now()),
('d0000002-0000-4000-8000-00000000cb28','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','d0000002-0000-4000-8000-00000000bb0a','member',now())
ON CONFLICT (id) DO NOTHING;

-- 研发域：需求 / 缺陷 / 迭代 / 版本
INSERT INTO sw.requirements (id, tenant_id, project_id, code, title, description, source, priority, status, story_points, owner_person_id, requester_person_id) VALUES
('d0000002-0000-4000-8000-00000000cb30','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','REQ-2026-011','订阅计费自助化（在线扩容席位）','客户管理员可自助升降级席位并即时生效','customer','high','doing',13,'d0000002-0000-4000-8000-00000000bb08','d0000002-0000-4000-8000-00000000bb07'),
('d0000002-0000-4000-8000-00000000cb31','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','REQ-2026-012','交付看板移动端适配','管理层手机查看里程碑与燃尽','internal','medium','queued',5,'d0000002-0000-4000-8000-00000000bb09','d0000002-0000-4000-8000-00000000bb06'),
('d0000002-0000-4000-8000-00000000cb32','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','REQ-2026-013','开放 Webhook 事件订阅','工单/缺陷状态变化推送客户系统','market','low','new',8,NULL,'d0000002-0000-4000-8000-00000000bb06')
ON CONFLICT (id) DO NOTHING;
INSERT INTO sw.iterations (id, tenant_id, project_id, name, goal, status, capacity_points, start_date, end_date)
VALUES ('d0000002-0000-4000-8000-00000000cb33','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','Sprint 3','计费自助化后端 + 看板联调','active',30,current_date - interval '5 days',current_date + interval '9 days')
ON CONFLICT (id) DO NOTHING;
INSERT INTO sw.iteration_items (id, tenant_id, iteration_id, task_id, story_points) VALUES
('d0000002-0000-4000-8000-00000000cb34','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb33','d0000002-0000-4000-8000-00000000cb23',8),
('d0000002-0000-4000-8000-00000000cb35','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb33','d0000002-0000-4000-8000-00000000cb24',5),
('d0000002-0000-4000-8000-00000000cb36','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb33','d0000002-0000-4000-8000-00000000cb25',3)
ON CONFLICT (id) DO NOTHING;
INSERT INTO sw.versions (id, tenant_id, project_id, iteration_id, version_number, status, release_notes, released_at, released_by_person_id)
VALUES ('d0000002-0000-4000-8000-00000000cb37','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20',NULL,'V2.1.0','released','蓝图模块发布：需求池/评审流/权限细化',now() - interval '5 days','d0000002-0000-4000-8000-00000000bb02')
ON CONFLICT (id) DO NOTHING;
INSERT INTO sw.defects (id, tenant_id, project_id, code, title, severity, priority, status, repro_steps, environment, assignee_person_id, reporter_person_id, resolved_at) VALUES
('d0000002-0000-4000-8000-00000000cb38','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','BUG-2026-021','席位扩容后配额未即时生效','critical','high','verified','1.扩容 10 席 2.立即邀请成员 3.提示无可用席位','staging/V2.1.0','d0000002-0000-4000-8000-00000000bb08','d0000002-0000-4000-8000-00000000bb0a',now() - interval '4 days'),
('d0000002-0000-4000-8000-00000000cb39','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','BUG-2026-022','导出报表中文乱码','minor','medium','new','导出 CSV 用 Excel 打开乱码','chrome/120','d0000002-0000-4000-8000-00000000bb09','d0000002-0000-4000-8000-00000000bb0a',NULL)
ON CONFLICT (id) DO NOTHING;

-- 合同 + 收款 + 发票（部分回款 → 账龄）
INSERT INTO sales.contracts (id, tenant_id, contract_no, title, contract_type, account_id, opportunity_id, project_id, status, amount_cents, payment_terms, sign_date, start_date, end_date, owner_person_id, signed_at)
VALUES ('d0000002-0000-4000-8000-00000000cb40','d0000002-0000-4000-8000-000000000001','CT-2026-YS-003','恒精数字化平台实施与运维服务合同','implementation','d0000002-0000-4000-8000-00000000cb10','d0000002-0000-4000-8000-00000000cb13','d0000002-0000-4000-8000-00000000cb20','signed',60000000,'4:4:2 分三期',current_date - interval '18 days','2026-09-15','2027-09-14','d0000002-0000-4000-8000-00000000bb07',now() - interval '18 days')
ON CONFLICT (id) DO NOTHING;
INSERT INTO finance.payment_plans (id, tenant_id, project_id, customer_name, amount_cents, due_date, milestone, status) VALUES
('d0000002-0000-4000-8000-00000000cb41','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','恒精精密',24000000,current_date - interval '5 days','合同:CT-2026-YS-003','paid'),
('d0000002-0000-4000-8000-00000000cb42','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','恒精精密',24000000,current_date + interval '85 days','合同:CT-2026-YS-003','planned')
ON CONFLICT (id) DO NOTHING;
INSERT INTO finance.invoices (id, tenant_id, invoice_type, invoice_number, counterparty_name, amount_cents, paid_cents, issue_date, due_date, status)
VALUES ('d0000002-0000-4000-8000-00000000cb43','d0000002-0000-4000-8000-000000000001','receivable','INV-YS-2026-0007','恒精精密',24000000,12000000,current_date - interval '30 days',current_date - interval '15 days','partial')
ON CONFLICT (id) DO NOTHING;

-- 订阅（MRR/ARR 演示）：2 生效 + 1 流失
INSERT INTO sales.subscriptions (id, tenant_id, subscription_no, account_id, contract_id, plan_name, seats, billing_cycle, mrr_cents, status, start_date, renewal_date, auto_renew, churned_at) VALUES
('d0000002-0000-4000-8000-00000000cb50','d0000002-0000-4000-8000-000000000001','SUB-2026-001','d0000002-0000-4000-8000-00000000cb10','d0000002-0000-4000-8000-00000000cb40','云枢 SaaS 专业版',40,'monthly',960000,'active',current_date - interval '60 days',current_date + interval '25 days',true,NULL),
('d0000002-0000-4000-8000-00000000cb51','d0000002-0000-4000-8000-000000000001','SUB-2026-002','d0000002-0000-4000-8000-00000000cb11',NULL,'云枢 SaaS 标准版',25,'monthly',480000,'active',current_date - interval '40 days',current_date + interval '50 days',true,NULL),
('d0000002-0000-4000-8000-00000000cb52','d0000002-0000-4000-8000-000000000001','SUB-2026-003','d0000002-0000-4000-8000-00000000cb12',NULL,'云枢 SaaS 标准版',10,'monthly',280000,'churned',current_date - interval '120 days',NULL,false,now() - interval '12 days')
ON CONFLICT (id) DO NOTHING;

-- 人事：假期余额 / 绩效 / 招聘 / 预算报销
INSERT INTO hr.leave_balances (id, tenant_id, person_id, leave_type, year, entitled_days, used_days)
VALUES ('d0000002-0000-4000-8000-00000000cb60','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb08','annual',2026,10,2)
ON CONFLICT (id) DO NOTHING;
INSERT INTO hr.performance_reviews (id, tenant_id, cycle, reviewee_person_id, reviewer_person_id, project_id, status, self_rating, self_comments, self_submitted_at, manager_rating, manager_comments, overall_rating, completed_at, goals)
VALUES ('d0000002-0000-4000-8000-00000000cb61','d0000002-0000-4000-8000-000000000001','2026-H2','d0000002-0000-4000-8000-00000000bb08','d0000002-0000-4000-8000-00000000bb02','d0000002-0000-4000-8000-00000000cb20','completed',4,'计费后端按期交付',now() - interval '6 days',5,'超出预期，主动补齐幂等与回滚',4.5,now() - interval '5 days','[{"title":"交付订阅计费后端","weight":60},{"title":"线上缺陷率<0.5%","weight":40}]'::jsonb)
ON CONFLICT (id) DO NOTHING;
INSERT INTO hr.job_requisitions (id, tenant_id, project_id, title, headcount, reason, status)
VALUES ('d0000002-0000-4000-8000-00000000cb62','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb20','高级 Java 后端工程师',2,'交付项目排期缺口','open')
ON CONFLICT (id) DO NOTHING;
INSERT INTO finance.budget_allocations (id, tenant_id, org_unit_id, name, period_label, period_year, category, total_amount_cents, spent_cents, notes)
VALUES ('d0000002-0000-4000-8000-00000000cb63','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bd03','研发中心 2026 运维预算','2026年',2026,'operations',20000000,7200000,'云服务器与 CDN 等')
ON CONFLICT (tenant_id, org_unit_id, period_year, category) DO NOTHING;
INSERT INTO finance.expenses (id, tenant_id, submitter_person_id, category, amount_cents, expense_date, description, status)
VALUES ('d0000002-0000-4000-8000-00000000cb64','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bb05','software',7200000,current_date - interval '10 days','云服务器与 CDN 年费','approved')
ON CONFLICT (id) DO NOTHING;

-- IT 资产 + 知识
INSERT INTO it.assets (id, tenant_id, asset_code, name, category, vendor, purchase_date, purchase_cost_cents) VALUES
('d0000002-0000-4000-8000-00000000cb70','d0000002-0000-4000-8000-000000000001','IT-LT-0031','MacBook Pro 14 M3','hardware','Apple',current_date - interval '90 days',1999900),
('d0000002-0000-4000-8000-00000000cb71','d0000002-0000-4000-8000-000000000001','IT-SAAS-JB','JetBrains 全家桶授权','saas','JetBrains',current_date - interval '150 days',680000)
ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge.categories (id, tenant_id, name, slug, description)
VALUES ('d0000002-0000-4000-8000-00000000cb72','d0000002-0000-4000-8000-000000000001','研发规范','rd-spec','研发流程与规范文档')
ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge.items (id, tenant_id, category_id, title, content, content_type, source_type, classification, owner_person_id, index_status) VALUES
('d0000002-0000-4000-8000-00000000cb73','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb72','发布流程规范','版本号语义化；发布前缺陷清零 blocker/critical；灰度 10% 观察 2 小时；回滚预案必填。','markdown','manual','internal','d0000002-0000-4000-8000-00000000bb02','indexed'),
('d0000002-0000-4000-8000-00000000cb74','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000cb72','客户现场实施手册','实施前完成数据迁移演练；每日站会同步风险；验收标准以合同里程碑为准。','markdown','manual','internal','d0000002-0000-4000-8000-00000000bb06','indexed')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- 0044: 标准体验企业补深（研发 / HR / 财务 / 知识）
-- 目的：让首次试用的用户在每个主模块都能看到可操作的真实数据，而不是一排 0。
-- 全部固定 UUID + ON CONFLICT DO NOTHING，可重复执行；只写 demo 租户。
BEGIN;

-- 标准体验企业的法人/组织（部分环境只有租户与人员，没有法人/组织，先补齐）
INSERT INTO platform.legal_entities (id, tenant_id, code, name, country_code, base_currency, status)
VALUES ('10000000-0000-4000-8000-00000000e101','10000000-0000-4000-8000-000000000001','DEMO-LEGAL','体验企业主法人','CN','CNY','active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO platform.org_units (id, tenant_id, legal_entity_id, code, name, type, status, source_of_truth)
VALUES ('10000000-0000-4000-8000-00000000e102','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e101','HQ','总部','company','active','platform')
ON CONFLICT (id) DO NOTHING;

-- 4 位演示员工（保留原有 2 位，共 6 位在职）
INSERT INTO platform.people (id, tenant_id, display_name, primary_email, status, classification)
VALUES
  ('10000000-0000-4000-8000-00000000f001','10000000-0000-4000-8000-000000000001','林晓','lin.xiao@demo.local','active','internal'),
  ('10000000-0000-4000-8000-00000000f002','10000000-0000-4000-8000-000000000001','周野','zhou.ye@demo.local','active','internal'),
  ('10000000-0000-4000-8000-00000000f003','10000000-0000-4000-8000-000000000001','苏晴','su.qing@demo.local','active','internal'),
  ('10000000-0000-4000-8000-00000000f004','10000000-0000-4000-8000-000000000001','顾言','gu.yan@demo.local','active','internal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform.employments
  (id, tenant_id, person_id, legal_entity_id, org_unit_id, employee_number, employment_type, status, start_date, probation_end_date, work_location)
VALUES
  ('10000000-0000-4000-8000-00000000f101','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f001','10000000-0000-4000-8000-00000000e101','10000000-0000-4000-8000-00000000e102','EMP-101','employee','active','2026-03-01','2026-06-01','上海'),
  ('10000000-0000-4000-8000-00000000f102','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f002','10000000-0000-4000-8000-00000000e101','10000000-0000-4000-8000-00000000e102','EMP-102','employee','active','2026-05-15','2026-08-15','上海'),
  ('10000000-0000-4000-8000-00000000f103','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f003','10000000-0000-4000-8000-00000000e101','10000000-0000-4000-8000-00000000e102','EMP-103','employee','active','2026-08-01','2026-11-01','北京'),
  ('10000000-0000-4000-8000-00000000f104','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f004','10000000-0000-4000-8000-00000000e101','10000000-0000-4000-8000-00000000e102','EMP-104','employee','active','2026-10-08','2027-01-08','深圳')
ON CONFLICT (id) DO NOTHING;

INSERT INTO hr.job_positions (id, tenant_id, title, code, level, department, description, salary_min_cents, salary_max_cents, headcount_budget, is_active)
VALUES
  ('10000000-0000-4000-8000-00000000f201','10000000-0000-4000-8000-000000000001','高级前端工程师','FE-P6','P6','研发','负责总部 OS Web 体验与设计系统。',2500000,4000000,2,true),
  ('10000000-0000-4000-8000-00000000f202','10000000-0000-4000-8000-000000000001','交付项目经理','PM-P5','P5','交付','负责零售数字化项目交付与客户成功。',2200000,3500000,1,true),
  ('10000000-0000-4000-8000-00000000f203','10000000-0000-4000-8000-000000000001','数据分析师','DA-P4','P4','研发','负责经营分析与指标体系。',1800000,2800000,1,true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO hr.job_requisitions
  (id, tenant_id, title, headcount, reason, status, is_demo, description, department, location, employment_type, salary_min_cents, salary_max_cents, priority, expected_start_date)
VALUES
  ('10000000-0000-4000-8000-00000000f301','10000000-0000-4000-8000-000000000001','高级前端工程师',2,'总部 OS 前端体验升级','open',true,'负责工作台与 AI 交互','研发','上海','employee',2500000,4000000,'high','2026-12-01'),
  ('10000000-0000-4000-8000-00000000f302','10000000-0000-4000-8000-000000000001','交付项目经理',1,'远山零售二期交付','open',true,'负责零售项目交付','交付','上海','employee',2200000,3500000,'normal','2026-12-15'),
  ('10000000-0000-4000-8000-00000000f303','10000000-0000-4000-8000-000000000001','数据分析师',1,'经营分析指标体系','approved',true,'负责经营看板与指标','研发','北京','employee',1800000,2800000,'normal','2026-11-25')
ON CONFLICT (id) DO NOTHING;

INSERT INTO hr.candidates
  (id, tenant_id, requisition_id, name, email, current_company, current_title, years_of_experience, expected_salary_min, expected_salary_max, skills, source, status, is_demo, education, rating)
VALUES
  ('10000000-0000-4000-8000-00000000f401','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f301','张一凡','zhang.yifan@example.com','云图科技','前端工程师',5,3000000,3800000,ARRAY['React','TypeScript','设计系统'],'referral','technical_interview',true,'本科',4),
  ('10000000-0000-4000-8000-00000000f402','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f301','陈可','chen.ke@example.com','北辰软件','高级前端',6,3300000,4200000,ARRAY['Vue','Node.js'],'job_board','resume_screening',true,'本科',3),
  ('10000000-0000-4000-8000-00000000f403','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f302','李沐','li.mu@example.com','远山零售','项目经理',7,2800000,3600000,ARRAY['PMP','零售','交付'],'headhunter','offer_sent',true,'硕士',5),
  ('10000000-0000-4000-8000-00000000f404','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f303','王琢','wang.zhuo@example.com','数澜科技','数据分析师',4,2200000,3000000,ARRAY['SQL','Python','BI'],'linkedin','phone_screening',true,'硕士',4),
  ('10000000-0000-4000-8000-00000000f405','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f303','赵岚','zhao.lan@example.com','某咨询','数据顾问',3,2000000,2600000,ARRAY['Tableau','SQL'],'campus','new',true,'本科',3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO finance.budget_allocations
  (id, tenant_id, org_unit_id, name, period_label, period_year, period_quarter, category, total_amount_cents, spent_cents, status, is_demo)
VALUES
  ('10000000-0000-4000-8000-00000000f501','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e102','2026 差旅预算','2026年',2026,NULL,'travel',12000000,7800000,'active',true),
  ('10000000-0000-4000-8000-00000000f502','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e102','2026 市场预算','2026年',2026,NULL,'marketing',30000000,31500000,'active',true),
  ('10000000-0000-4000-8000-00000000f503','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e102','2026 研发设备','2026年',2026,NULL,'equipment',18000000,6200000,'active',true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO finance.payment_plans
  (id, tenant_id, project_id, customer_name, amount_cents, due_date, milestone, status, is_demo)
VALUES
  ('10000000-0000-4000-8000-00000000f701','10000000-0000-4000-8000-000000000001',(SELECT id FROM project.projects WHERE tenant_id='10000000-0000-4000-8000-000000000001' AND code='PRJ-YS-001' LIMIT 1),'远山零售',9600000,'2026-11-20','远山一期验收款','planned',true),
  ('10000000-0000-4000-8000-00000000f702','10000000-0000-4000-8000-000000000001',(SELECT id FROM project.projects WHERE tenant_id='10000000-0000-4000-8000-000000000001' AND code='PRJ-BC-001' LIMIT 1),'北辰物流',4800000,'2026-12-05','北辰仓配上线款','planned',true),
  ('10000000-0000-4000-8000-00000000f703','10000000-0000-4000-8000-000000000001',(SELECT id FROM project.projects WHERE tenant_id='10000000-0000-4000-8000-000000000001' AND code='PRJ-YQ-001' LIMIT 1),'云启科技',7200000,'2026-10-28','云启预研首款','paid',true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO finance.invoices
  (id, tenant_id, invoice_number, invoice_type, counterparty_name, amount_cents, tax_rate, issue_date, due_date, status, paid_cents, paid_at, notes)
VALUES
  ('10000000-0000-4000-8000-00000000f601','10000000-0000-4000-8000-000000000001','INV-2026-001','receivable','远山零售',9600000,6,'2026-11-01','2026-11-20','sent',0,NULL,'一期验收款发票'),
  ('10000000-0000-4000-8000-00000000f602','10000000-0000-4000-8000-000000000001','INV-2026-002','receivable','北辰物流',4800000,6,'2026-11-05','2026-12-05','partial',2000000,'2026-11-08','仓配项目预收款'),
  ('10000000-0000-4000-8000-00000000f603','10000000-0000-4000-8000-000000000001','INV-2026-003','payable','阿里云',3600000,6,'2026-10-20','2026-11-19','paid',3600000,'2026-11-02','年度云资源')
ON CONFLICT (id) DO NOTHING;

INSERT INTO finance.expenses
  (id, tenant_id, submitter_person_id, category, amount_cents, currency, expense_date, description, status, approved_at, paid_at, is_demo)
VALUES
  ('10000000-0000-4000-8000-00000000f801','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','travel',186000,'CNY','2026-11-03','远山零售现场调研差旅','paid','2026-11-04','2026-11-06',true),
  ('10000000-0000-4000-8000-00000000f802','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f001','software',89900,'CNY','2026-11-05','Figma 团队版续费','approved','2026-11-06',NULL,true),
  ('10000000-0000-4000-8000-00000000f803','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000f002','meals',12800,'CNY','2026-11-07','项目加班餐','submitted',NULL,NULL,true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sw.requirements
  (id, tenant_id, project_id, code, title, description, source, priority, status, story_points, owner_person_id, requester_person_id)
VALUES
  ('10000000-0000-4000-8000-00000000f901','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e001','REQ-001','门店库存实时同步','POS 与总部库存双向同步','customer','high','doing',8,'10000000-0000-4000-8000-00000000f001','20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-00000000f902','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e001','REQ-002','门店日报自动生成','每日 8 点推送经营日报','internal','medium','queued',5,'10000000-0000-4000-8000-00000000f002','20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-00000000f903','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e002','REQ-003','数据源接入清单','统一口径与数据源登记','internal','high','new',3,'10000000-0000-4000-8000-00000000f003','20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-00000000f904','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e003','REQ-004','仓配异常预警','延迟/缺货自动预警','support','medium','triaged',5,'10000000-0000-4000-8000-00000000f001','20000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sw.defects
  (id, tenant_id, project_id, code, title, description, severity, priority, status, environment, assignee_person_id, reporter_person_id)
VALUES
  ('10000000-0000-4000-8000-00000000fa01','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e001','BUG-001','库存同步偶发延迟','高峰期同步超过 2 分钟','major','high','in_progress','prod','10000000-0000-4000-8000-00000000f001','20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-00000000fa02','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e001','BUG-002','日报金额四舍五入不一致','前后端精度不同','minor','medium','confirmed','prod','10000000-0000-4000-8000-00000000f002','20000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-00000000fa03','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e003','BUG-003','仓配预警重复推送','同一异常多次通知','major','high','fixed','staging','10000000-0000-4000-8000-00000000f001','20000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sw.iterations
  (id, tenant_id, project_id, name, goal, status, capacity_points, start_date, end_date)
VALUES
  ('10000000-0000-4000-8000-00000000fb01','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e001','2026-W46','完成库存同步与日报首版','active',40,'2026-11-09','2026-11-20'),
  ('10000000-0000-4000-8000-00000000fb02','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e003','2026-W45','仓配预警上线','completed',30,'2026-11-02','2026-11-13')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sw.versions
  (id, tenant_id, project_id, iteration_id, version_number, status, release_notes, planned_release_date, released_at)
VALUES
  ('10000000-0000-4000-8000-00000000fc01','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e001','10000000-0000-4000-8000-00000000fb01','v1.4.0','planned','库存同步 + 门店日报', '2026-11-22',NULL),
  ('10000000-0000-4000-8000-00000000fc02','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-00000000e003','10000000-0000-4000-8000-00000000fb02','v1.3.2','released','仓配异常预警修复','2026-11-12','2026-11-09')
ON CONFLICT (id) DO NOTHING;

INSERT INTO knowledge.items
  (id, tenant_id, title, content, content_type, source_type, classification, tags, index_status, review_status)
VALUES
  ('10000000-0000-4000-8000-00000000fd01','10000000-0000-4000-8000-000000000001','零售门店上线检查清单','上线前 48 小时检查：网络、POS、库存同步、权限、日报、回滚方案。','markdown','manual','internal',ARRAY['零售','上线','清单'],'indexed','approved'),
  ('10000000-0000-4000-8000-00000000fd02','10000000-0000-4000-8000-000000000001','项目复盘：远山一期','关键经验：提前锁定数据口径；门店培训分两批；上线首周每日站会。','markdown','manual','internal',ARRAY['复盘','交付'],'indexed','approved'),
  ('10000000-0000-4000-8000-00000000fd03','10000000-0000-4000-8000-000000000001','差旅报销标准','一线城市住宿 600 元/晚，交通按实际；超标需事前审批。','markdown','manual','internal',ARRAY['财务','制度'],'indexed','approved')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- 0026 · 演示数据修正：云枢软件预算落到真实表 finance.budget_allocations
-- 背景：0025 曾把演示预算写进旧表 finance.budgets（现行 API 读写的是 budget_allocations）；
-- 0025 已在既有环境应用过（按版本跳过不会重跑），故以追加迁移补齐，幂等。
BEGIN;

INSERT INTO finance.budget_allocations (id, tenant_id, org_unit_id, name, period_label, period_year, category, total_amount_cents, spent_cents, notes)
VALUES ('d0000002-0000-4000-8000-00000000cb64','d0000002-0000-4000-8000-000000000001','d0000002-0000-4000-8000-00000000bd03','研发中心 2026 运维预算','2026年',2026,'operations',20000000,7200000,'云服务器与 CDN 等')
ON CONFLICT (tenant_id, org_unit_id, period_year, category) DO NOTHING;


--- 白山（测试工程师）入职时间校正到试用期提醒窗口内（演示细节）
UPDATE platform.employments SET start_date = current_date - interval '170 days'
WHERE id = 'd0000002-0000-4000-8000-00000000bf0a'
  AND tenant_id = 'd0000002-0000-4000-8000-000000000001';

COMMIT;

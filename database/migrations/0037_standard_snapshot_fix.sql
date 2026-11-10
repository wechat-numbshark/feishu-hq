-- 0037: 校准标准体验企业的首页快照与成员数
-- 0036 里月回款写成 144 万，但实际回款计划是 14.4 万；这里按真实业务数据校正，
-- 避免演示数字与下钻明细不一致。成员数按演示组织设定为 28。

BEGIN;

UPDATE platform.workspace_snapshots
SET metrics = jsonb_set(metrics, '{monthly_receipts,value}', to_jsonb('¥ 144,000'::text)),
    updated_at = now()
WHERE tenant_id = '10000000-0000-4000-8000-000000000001'
  AND snapshot_date = (SELECT max(snapshot_date) FROM platform.workspace_snapshots
                       WHERE tenant_id = '10000000-0000-4000-8000-000000000001');

UPDATE platform.tenants
SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{member_count}', '28'::jsonb),
    updated_at = now()
WHERE id = '10000000-0000-4000-8000-000000000001';

COMMIT;

-- 0042: 数据完整性修复（备份恢复演练暴露）
-- 1) 清理已删除租户遗留的 accounts / workspace_snapshots 孤儿行；
-- 2) 清理 platform.jobs 重复幂等键并重建唯一索引。

BEGIN;

DELETE FROM crm.accounts a
WHERE a.tenant_id NOT IN (SELECT id FROM platform.tenants);

DELETE FROM platform.workspace_snapshots s
WHERE s.tenant_id NOT IN (SELECT id FROM platform.tenants);

DELETE FROM platform.jobs a
USING platform.jobs b
WHERE a.ctid > b.ctid
  AND a.tenant_id = b.tenant_id
  AND a.idempotency_key = b.idempotency_key
  AND a.idempotency_key IS NOT NULL;

REINDEX INDEX platform.jobs_idempotency_idx;

COMMIT;

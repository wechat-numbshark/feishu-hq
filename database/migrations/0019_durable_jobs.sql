-- 0019 持久作业队列：AI 长任务/后台作业的可恢复、可重试、可人工接管的持久队列。
-- 设计：状态机 queued→running→succeeded/failed，超过 max_attempts 转 dead（死信，需人工接管）。
-- 采用与 outbox/知识索引一致的 claim 模式：FOR UPDATE SKIP LOCKED + 租约(lease_until)，
-- 租约到期的 running 作业可被重新领取，进程崩溃后自动恢复。迁移只追加。
BEGIN;

CREATE TABLE platform.jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  kind varchar(100) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  result jsonb,
  idempotency_key varchar(300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- 幂等入队：同租户同 key 只保留一个作业（NULL key 不参与唯一约束）。
CREATE UNIQUE INDEX jobs_idempotency_idx
  ON platform.jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 待领取：排队中且到达可执行时间；租约过期的 running 也需被重新扫出。
CREATE INDEX jobs_claim_idx
  ON platform.jobs (available_at)
  WHERE status IN ('queued','running');

ALTER TABLE platform.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant
  ON platform.jobs
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.jobs TO hq_app;

COMMIT;

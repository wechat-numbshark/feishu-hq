-- 0041: 审批高级能力（条件步骤 / 实例快照 / 加签 / 转交委托 / 超时提醒）
BEGIN;

ALTER TABLE platform.approval_flows
  ADD COLUMN IF NOT EXISTS timeout_hours int NOT NULL DEFAULT 48;

ALTER TABLE platform.approval_instances
  ADD COLUMN IF NOT EXISTS steps_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

ALTER TABLE platform.approval_actions
  ADD COLUMN IF NOT EXISTS delegated_from_person_id uuid,
  ADD COLUMN IF NOT EXISTS delegated_at timestamptz,
  ADD COLUMN IF NOT EXISTS transfer_reason text,
  ADD COLUMN IF NOT EXISTS is_added boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS approval_instances_due_idx
  ON platform.approval_instances (tenant_id, due_at)
  WHERE status = 'pending';

COMMIT;

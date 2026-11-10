-- 0032 · 热路径索引（docs/20 优化 P0）：审计/消息/任务/费用/发件箱的高频查询补索引
BEGIN;
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_action_time ON audit.audit_events (tenant_id, actor_id, action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_action_outcome_time ON audit.audit_events (tenant_id, action, outcome, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_decisions_subject_time ON audit.authorization_decisions (tenant_id, subject_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON platform.ai_messages (tenant_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON project.tasks (tenant_id, assignee_person_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_category_date ON finance.expenses (tenant_id, category, expense_date);
CREATE INDEX IF NOT EXISTS idx_outbox_pending_type ON platform.outbox_events (tenant_id, event_type) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employments_manager ON platform.employments (tenant_id, manager_person_id) WHERE deleted_at IS NULL AND status = 'active';
COMMIT;

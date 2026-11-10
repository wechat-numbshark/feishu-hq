-- 0031 · 修正 standard 体验租户的审批流步数（修复 M2 回归根因）
-- 背景：0025 §0 为 standard 租户预置了单步 expense/leave_request 流；该租户与验收种子共用同一 ID，
-- 种子 ON CONFLICT DO NOTHING 被跳过，导致两步审批（直属上级→财务/HR 负责人）退化为一步。
-- 本迁移把 standard 租户的两条流对齐为与验收种子一致的语义（director 上级 → 角色 待指派）。
BEGIN;
UPDATE platform.approval_flows
SET steps = '[{"order":1,"type":"manager","label":"直属上级"},{"order":2,"type":"role","label":"财务负责人"}]'::jsonb,
    updated_at = now()
WHERE tenant_id = '10000000-0000-4000-8000-000000000001' AND code = 'expense'
  AND jsonb_array_length(steps) < 2;

UPDATE platform.approval_flows
SET steps = '[{"order":1,"type":"manager","label":"直属上级"},{"order":2,"type":"role","label":"HR 负责人"}]'::jsonb,
    updated_at = now()
WHERE tenant_id = '10000000-0000-4000-8000-000000000001' AND code = 'leave_request'
  AND jsonb_array_length(steps) < 2;
COMMIT;

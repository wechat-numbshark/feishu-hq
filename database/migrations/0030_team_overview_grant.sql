-- 0030 · 新 L0 工具 query_team_overview 默认放行（docs/19 P3：AI 人人可用的团队公开面）
BEGIN;
INSERT INTO platform.ai_tool_authorizations (id, tenant_id, person_id, tool_name, action, risk_level, data_domain, effect, status, reason)
SELECT gen_random_uuid(), t.id, NULL, 'query_team_overview', 'platform.team.read', 'L0', 'platform', 'allow', 'active', 'authenticated team overview default'
FROM platform.tenants t
WHERE t.code IN ('demo', 'demo-mfg', 'demo-sw')
ON CONFLICT (tenant_id, tool_name) WHERE person_id IS NULL AND deleted_at IS NULL DO NOTHING;
COMMIT;

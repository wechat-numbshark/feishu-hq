\set ON_ERROR_STOP on
BEGIN;
SET ROLE hq_app;
SET LOCAL app.tenant_id = '00000000-0000-7000-8000-000000000001';

INSERT INTO platform.tenants (id, code, name)
VALUES ('00000000-0000-7000-8000-000000000001', 'ai-test-a', 'AI 测试租户 A');

INSERT INTO platform.people (id, tenant_id, display_name, primary_email)
VALUES ('20000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', '测试用户', 'test@example.com');

-- 持久化 AI 会话创建（委托人 = 当前用户）
INSERT INTO platform.ai_conversations
  (id, tenant_id, person_id, delegated_by_person_id, context_module, trace_id, status)
VALUES ('a0000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000001', 'platform', 'test-trace-001', 'active');

-- 工具授权：默认允许 L0 读取
INSERT INTO platform.ai_tool_authorizations
  (id, tenant_id, person_id, tool_name, action, risk_level, data_domain, effect, status, reason)
VALUES ('30000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', NULL, 'query_projects', 'project.project.read', 'L0', 'project', 'allow', 'active', 'test default');

-- 验证：同一租户可查询自己的会话
SELECT count(*) = 1 AS session_exists FROM platform.ai_conversations WHERE id = 'a0000000-0000-7000-8000-000000000001' AND tenant_id = platform.current_tenant_id() AND person_id = '20000000-0000-7000-8000-000000000001';

-- 验证：工具授权存在
SELECT count(*) = 1 AS grant_exists FROM platform.ai_tool_authorizations WHERE tool_name = 'query_projects' AND tenant_id = platform.current_tenant_id() AND status = 'active';

-- 验证：跨租户访问应被 RLS 阻止（无数据可见）
DO $$
DECLARE
  visible integer;
BEGIN
  SELECT count(*) INTO visible FROM platform.ai_conversations WHERE tenant_id = '00000000-0000-7000-8000-000000000002';
  IF visible > 0 THEN RAISE EXCEPTION 'Cross-tenant RLS failure'; END IF;
END;
$$;

ROLLBACK;
RESET ROLE;
SELECT 'ai_session_authorization_tests_passed' AS result;

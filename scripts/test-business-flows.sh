#!/bin/bash
# M2+M3 验收：审批内核（选人/职责分离/幂等/版本快照/设置生效）与三条业务链端到端真实集成测试。
# 隔离库 + 真实 HTTP + 真实 RLS，逐环节以真实库读回记录 ID 与状态流转。
# 实现：scripts/acceptance/m2-approval-settings.mjs + m3-business-flows.mjs。
# 用法：bash scripts/test-business-flows.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_NO_WARNINGS=1
node --experimental-strip-types scripts/acceptance/m2-approval-settings.mjs "$@"
exec node --experimental-strip-types scripts/acceptance/m3-business-flows.mjs "$@"

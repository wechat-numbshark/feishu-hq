#!/bin/bash
# M4 验收：AI 执行闭环 6 用例（L0 放行 / 越权写工具拒绝 / 管理员执行闭环 / 会话隔离 / 提示注入不越权 / 会话可恢复）。
# 真实 /v1/ai/chat + 确定性桩模型 tool_calls + 真实库读回（授权决策/拒绝审计/副作用/会话）。
# 实现：scripts/acceptance/m4-ai-execution.mjs。
# 用法：bash scripts/test-ai-execution.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_NO_WARNINGS=1
exec node --experimental-strip-types scripts/acceptance/m4-ai-execution.mjs "$@"

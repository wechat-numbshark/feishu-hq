#!/usr/bin/env bash
# M1 验收：真实角色 × 敏感端点差异矩阵（含匿名 401 与跨租户 RLS 隔离）。
# 隔离 Postgres 容器 + 真实 API 服务器 + 真实 HMAC 会话，逐条 fetch 验证并以真实库读回副作用。
# 实现：scripts/acceptance/m1-matrix.mjs（地基自建，跑完销毁容器）。
# 用法：bash scripts/test-role-endpoint-matrix.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_NO_WARNINGS=1
exec node --experimental-strip-types scripts/acceptance/m1-matrix.mjs "$@"

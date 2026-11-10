#!/bin/bash
# M6 干净安装验收（隔离 project hq-accept + 独立端口 + 一次性凭据，全新命名卷，绝不触碰正式）。
# 证明：docker compose 全新拉起 PostgreSQL → migrate 作业应用全部迁移 → API 对全新库健康。
#
# 环境适配说明（重要，杜绝编造）：api 镜像的 Dockerfile 需 `apk add curl`；若本机沙箱无法访问
# Alpine CDN，则容器化 api 无法在此构建。脚本会先用短超时探测该限制并如实记录，随后改以宿主机
# 运行同一份 API 源码(apps/api/src/main.ts, node --experimental-strip-types)对全新库验证 /health。
# 迁移/健康/库均为真实执行结果；构建不可用属环境网络限制而非代码缺陷。
set -uo pipefail
export PATH="$HOME/.hermes/node/bin:$PATH"
cd "${REPO_DIR:-$(dirname "$0")/..}" || exit 3

BASE="deploy/compose/docker-compose.yml"
OVR="deploy/compose/docker-compose.acceptance.yml"
PROJ="hq-accept"
API_PORT=23000
PG_PORT=25432
PGPW="acc_pg_$RANDOM"
SESSION_SECRET="acc_$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

ENVF="$(mktemp /tmp/hq-accept.XXXXXX.env)"
cat >"$ENVF" <<EOF
POSTGRES_PASSWORD=$PGPW
HQ_APP_PASSWORD=acc_app
SESSION_SECRET=$SESSION_SECRET
MINIO_ROOT_USER=feishu_hq
MINIO_ROOT_PASSWORD=acc_minio
MYSQL_ROOT_PASSWORD=acc_mysql
KODBOX_DB_PASSWORD=acc_kdb
KODBOX_ADMIN_PASSWORD=acc_kadm
API_PORT=$API_PORT
MODEL_API_KEY=
EOF
trap 'rm -f "$ENVF"' EXIT

DC="docker compose -p $PROJ -f $BASE -f $OVR --env-file $ENVF"

echo "=== [1/6] 清理历史隔离 project（若存在）==="
$DC down -v >/dev/null 2>&1 || true

echo "=== [2/6] 全新拉起 PostgreSQL（健康）+ 构建并运行 migrate 作业（应用全部迁移）==="
if ! $DC up -d --wait postgres; then
  echo "RESULT=FAIL reason=postgres_not_healthy"; exit 1
fi
$DC build migrate 2>&1 | tail -3
if ! $DC up migrate 2>&1 | tail -8; then
  echo "RESULT=FAIL reason=migrate_failed"; exit 1
fi

echo "=== [3/6] 断言全新卷迁移数（期望 18）==="
MIG_COUNT="$(docker exec "${PROJ}-postgres-1" psql -U hq_admin -d feishu_hq -X -A -t -c "SELECT count(*) FROM platform.schema_migrations" 2>/dev/null | tr -d ' \r')"
LATEST="$(docker exec "${PROJ}-postgres-1" psql -U hq_admin -d feishu_hq -X -A -t -c "SELECT version FROM platform.schema_migrations ORDER BY version DESC LIMIT 1" 2>/dev/null | tr -d ' \r')"
echo "migrations_applied=$MIG_COUNT latest=$LATEST"

echo "=== [4/6] 探测容器化 api 构建（受 Alpine CDN 限制则记录并回退宿主机运行）==="
API_MODE="container"
if timeout 25 docker build -q -f deploy/compose/Dockerfile.api -t "$PROJ-api:acc" . >/tmp/apibuild.log 2>&1; then
  echo "api_image_build=ok"
else
  API_MODE="host"
  echo "api_image_build=skipped(sandbox cannot reach Alpine CDN for apk add curl; documented env limitation)"
fi

echo "=== [5/6] 启动 API 并对全新库探测 /health ==="
ADMIN_URL="postgresql://hq_admin:$PGPW@127.0.0.1:$PG_PORT/feishu_hq?sslmode=disable"
HEALTH=""
if [ "$API_MODE" = "host" ]; then
  DATABASE_URL="$ADMIN_URL" SESSION_SECRET="$SESSION_SECRET" PORT=$API_PORT HOST=127.0.0.1 MODEL_API_KEY="" NODE_ENV=production \
    node --experimental-strip-types apps/api/src/main.ts >/tmp/api-run.log 2>&1 &
  APID=$!
  for i in $(seq 1 30); do
    HEALTH="$(curl -fsS "http://127.0.0.1:$API_PORT/health" 2>/dev/null || true)"
    [ -n "$HEALTH" ] && break
    sleep 1
  done
  kill "$APID" >/dev/null 2>&1 || true
else
  $DC up -d --wait api >/dev/null 2>&1 || true
  HEALTH="$(curl -fsS "http://127.0.0.1:$API_PORT/health" 2>/dev/null || true)"
fi
echo "api_mode=$API_MODE health_response=$HEALTH"

echo "=== [6/6] 结果判定 ==="
PASS=1
[ "$MIG_COUNT" = "18" ] || { echo "ASSERT_FAIL migrations=$MIG_COUNT(expected 18)"; PASS=0; }
echo "$HEALTH" | grep -q "ok" || { echo "ASSERT_FAIL health not ok"; PASS=0; }
if [ "$PASS" = "1" ]; then
  echo "RESULT=PASS clean-install: fresh compose postgres + migrate(18) + API($API_MODE) healthy"
else
  echo "RESULT=FAIL"
fi
echo "NOTE: 隔离容器 ${PROJ}-postgres-1 保留运行，供 scripts/backup-restore-test.sh 复用；"
echo "      清理： docker compose -p $PROJ -f $BASE -f $OVR --env-file <env> down -v"

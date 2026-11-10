#!/bin/sh
# 本地开发数据库一键初始化（macOS / Linux，原生 PostgreSQL）
#
# 前置：
#   macOS:  brew install postgresql@16 && brew services start postgresql@16
#   Ubuntu: sudo apt install postgresql-16 && sudo systemctl start postgresql
#
# 用法：
#   sh scripts/dev-db.sh
#   PGPORT=5433 sh scripts/dev-db.sh          # 改端口
#   HQ_DB_NAME=feishu_hq_dev sh scripts/dev-db.sh
#
# 说明：使用当前系统用户作为 PostgreSQL 超级用户（Homebrew 默认即如此）。
#       会创建 hq_admin（登录/迁移用户）与 hq_app（NOLOGIN，RLS 受限角色），
#       然后执行全部迁移。重复执行是幂等的。
set -eu

DB_NAME="${HQ_DB_NAME:-feishu_hq}"
ADMIN_USER="${HQ_ADMIN_USER:-hq_admin}"
ADMIN_PASS="${HQ_ADMIN_PASS:-change_me}"
APP_USER="${HQ_APP_USER:-hq_app}"
PORT="${PGPORT:-5432}"
SUPERUSER="${PGSUPERUSER:-$(whoami)}"
HOST="${PGHOST:-127.0.0.1}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql 未安装。macOS: brew install postgresql@16；Ubuntu: apt install postgresql-16" >&2
  exit 1
fi

echo "==> 使用 $SUPERUSER@$HOST:$PORT 初始化（数据库 $DB_NAME）"

psql -h "$HOST" -p "$PORT" -U "$SUPERUSER" -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ADMIN_USER}') THEN
    CREATE ROLE ${ADMIN_USER} LOGIN PASSWORD '${ADMIN_PASS}' SUPERUSER;
  ELSE
    ALTER ROLE ${ADMIN_USER} WITH LOGIN PASSWORD '${ADMIN_PASS}' SUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
    CREATE ROLE ${APP_USER} NOLOGIN;
  END IF;
END
\$\$;
SQL

if [ "$(psql -h "$HOST" -p "$PORT" -U "$SUPERUSER" -d postgres -X -A -t -c "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" != "1" ]; then
  createdb -h "$HOST" -p "$PORT" -U "$SUPERUSER" -O "$ADMIN_USER" -E UTF8 "$DB_NAME"
  echo "==> 已创建数据库 $DB_NAME"
else
  echo "==> 数据库 $DB_NAME 已存在"
fi

export DATABASE_URL="postgresql://${ADMIN_USER}:${ADMIN_PASS}@${HOST}:${PORT}/${DB_NAME}?sslmode=disable"
sh "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/apply-migrations.sh"

echo ""
echo "✓ 本地数据库就绪。把下面这行写入 .env："
echo "DATABASE_URL=${DATABASE_URL}"

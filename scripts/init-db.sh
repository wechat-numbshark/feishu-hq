#!/bin/sh
# 一键初始化 PostgreSQL 数据库
# 用法：DATABASE_URL=postgres://... sh scripts/init-db.sh
# 或：   sh scripts/init-db.sh --local（使用本地 postgres 超级用户）
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-$(dirname "$0")/../database/migrations}"
ADMIN_URL="${DATABASE_URL:-}"
LOCAL_MODE=0

for arg in "$@"; do
  case "$arg" in
    --local) LOCAL_MODE=1 ;;
  esac
done

if [ "$LOCAL_MODE" = "1" ]; then
  # 本地开发：使用 peer auth 或 postgres 超级用户
  HQ_DB="feishu_hq"
  HQ_ADMIN="hq_admin"
  HQ_APP="hq_app"
  HQ_ADMIN_PASS="${HQ_ADMIN_PASS:-$(openssl rand -hex 16)}"
  HQ_APP_PASS="${HQ_APP_PASS:-$(openssl rand -hex 16)}"

  echo "==> 创建数据库和角色..."
  psql -U postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${HQ_ADMIN}') THEN
    CREATE ROLE ${HQ_ADMIN} LOGIN PASSWORD '${HQ_ADMIN_PASS}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${HQ_APP}') THEN
    CREATE ROLE ${HQ_APP} LOGIN PASSWORD '${HQ_APP_PASS}';
  END IF;
END
\$\$;
SQL

  psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='${HQ_DB}'" | grep -q 1 || \
    psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${HQ_DB} OWNER ${HQ_ADMIN} ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'"

  ADMIN_URL="postgres://${HQ_ADMIN}:${HQ_ADMIN_PASS}@127.0.0.1:5432/${HQ_DB}?sslmode=disable"

  echo ""
  echo "==> 数据库已创建。请将以下环境变量保存到 .env："
  echo "POSTGRES_PASSWORD=${HQ_ADMIN_PASS}"
  echo "HQ_APP_PASSWORD=${HQ_APP_PASS}"
  echo "DATABASE_URL=postgres://${HQ_APP}:${HQ_APP_PASS}@127.0.0.1:5432/${HQ_DB}?sslmode=disable"
  echo ""
fi

if [ -z "$ADMIN_URL" ]; then
  echo "错误：请设置 DATABASE_URL 或使用 --local 模式" >&2
  exit 1
fi

echo "==> 创建 hq_app 角色（如不存在）..."
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL' || true
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hq_app') THEN
    CREATE ROLE hq_app NOLOGIN;
  END IF;
END
$$;
SQL

echo "==> 应用迁移文件..."
DATABASE_URL="$ADMIN_URL" sh "$(dirname "$0")/apply-migrations.sh"

echo ""
echo "✓ 数据库初始化完成！"
echo "  迁移路径: $MIGRATIONS_DIR"

#!/bin/sh
# 执行数据库迁移（幂等：已应用的版本会跳过）
#
# 用法：
#   DATABASE_URL=postgresql://hq_admin:change_me@localhost:5432/feishu_hq sh scripts/apply-migrations.sh
#
# 迁移目录解析顺序：
#   1. $MIGRATIONS_DIR
#   2. 容器内 /migrations
#   3. 仓库内 database/migrations（macOS/Linux 本地开发）
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

if [ -n "${MIGRATIONS_DIR:-}" ]; then
  :
elif [ -d /migrations ]; then
  MIGRATIONS_DIR=/migrations
else
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  MIGRATIONS_DIR="$SCRIPT_DIR/../database/migrations"
fi

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

for migration in "$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql; do
  [ -f "$migration" ] || continue
  version="$(basename "$migration")"
  has_table="$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT to_regclass('platform.schema_migrations') IS NOT NULL")"
  if [ "$has_table" = "t" ]; then
    case "$version" in
      *[!A-Za-z0-9_.-]*) echo "invalid migration filename: $version" >&2; exit 1 ;;
    esac
    applied="$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM platform.schema_migrations WHERE version = '$version')")"
    if [ "$applied" = "t" ]; then
      echo "skip $version"
      continue
    fi
  fi

  echo "apply $version"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration"
  sum="$(checksum "$migration")"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -c "INSERT INTO platform.schema_migrations(version, checksum) VALUES ('$version', '$sum')"
done

echo "migrations complete"

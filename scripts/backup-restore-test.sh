#!/bin/bash
# 备份/恢复一致性验收（M6）：对隔离 PostgreSQL 容器内的库做
#   pg_dump(custom) → 恢复到全新库 → 逐项对比（表数量 / 全库基表行数 / 校验和 / 标记行）
# 证明备份可恢复且数据一致。默认针对干净安装留下的隔离容器 hq-accept-postgres-1，
# 可用环境变量覆盖：CONTAINER / SRC_DB / ADMIN_USER。绝不触碰正式库。
set -uo pipefail

CONTAINER="${CONTAINER:-hq-accept-postgres-1}"
ADMIN_USER="${ADMIN_USER:-hq_admin}"
SRC_DB="${SRC_DB:-feishu_hq}"
DST_DB="feishu_hq_rst_$$"
TMP_DUMP="/tmp/hq_backup_$$.dump"

echo "=== 备份恢复验收 ==="
echo "container=$CONTAINER src=$SRC_DB dst=$DST_DB"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "RESULT=FAIL reason=container_not_running($CONTAINER) —— 请先跑 scripts/m6-clean-install-check.sh"
  exit 1
fi

dexec(){ docker exec -i "$CONTAINER" psql -U "$ADMIN_USER" -d "$1" -X -A -t -v ON_ERROR_STOP=1 -c "$2"; }

echo "=== [1/5] 在源库写入确定性标记（验证数据往返，而非仅结构）==="
dexec "$SRC_DB" "CREATE TABLE IF NOT EXISTS platform.acceptance_backup_marker(tag text PRIMARY KEY, n integer, note text)" >/dev/null
dexec "$SRC_DB" "INSERT INTO platform.acceptance_backup_marker(tag,n,note) VALUES ('m6-backup', 42, '总部OS 备份恢复一致性标记') ON CONFLICT (tag) DO UPDATE SET n=EXCLUDED.n" >/dev/null
MARK_SRC="$(dexec "$SRC_DB" "SELECT tag||'='||n||'='||note FROM platform.acceptance_backup_marker WHERE tag='m6-backup'" | tr -d '\r')"
echo "marker_in_source=$MARK_SRC"

echo "=== [2/5] pg_dump 备份源库（custom 格式）==="
docker exec "$CONTAINER" pg_dump -U "$ADMIN_USER" --format=custom --file="$TMP_DUMP" "$SRC_DB"
DSZ="$(docker exec "$CONTAINER" sh -c "wc -c < $TMP_DUMP" | tr -d ' \r')"
echo "dump_bytes=$DSZ"
[ "${DSZ:-0}" -gt 0 ] || { echo "RESULT=FAIL reason=empty_dump"; exit 1; }

echo "=== [3/5] 创建全新库并 pg_restore ==="
docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d postgres -X -c "DROP DATABASE IF EXISTS $DST_DB" >/dev/null
docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d postgres -X -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DST_DB" >/dev/null
docker exec "$CONTAINER" pg_restore -U "$ADMIN_USER" -d "$DST_DB" --no-owner --exit-on-error "$TMP_DUMP"
echo "restore_exit=$?"

echo "=== [4/5] 结构+数据对比（源 vs 恢复）==="
tblcount(){ dexec "$1" "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'"; }
migcount(){ dexec "$1" "SELECT count(*) FROM platform.schema_migrations"; }
markcount(){ dexec "$1" "SELECT count(*) FROM platform.acceptance_backup_marker WHERE tag='m6-backup' AND n=42"; }
markval(){ dexec "$1" "SELECT tag||'='||n||'='||note FROM platform.acceptance_backup_marker WHERE tag='m6-backup'" | tr -d '\r'; }

S_TBL="$(tblcount "$SRC_DB" | tr -d ' \r')";        R_TBL="$(tblcount "$DST_DB" | tr -d ' \r')"
S_MIG="$(migcount "$SRC_DB" | tr -d ' \r')";        R_MIG="$(migcount "$DST_DB" | tr -d ' \r')"
S_MARK="$(markval "$SRC_DB")";                       R_MARK="$(markval "$DST_DB")"
echo "tables: src=$S_TBL restored=$R_TBL"
echo "migrations: src=$S_MIG restored=$R_MIG"
echo "marker: src=[$S_MARK] restored=[$R_MARK]"

echo "=== [5/5] 断言一致性 ==="
PASS=1
[ "$S_TBL" = "$R_TBL" ] || { echo "ASSERT_FAIL tables $S_TBL!=$R_TBL"; PASS=0; }
[ "$S_MIG" = "$R_MIG" ] || { echo "ASSERT_FAIL migrations $S_MIG!=$R_MIG"; PASS=0; }
[ -n "$R_MARK" ] && [ "$S_MARK" = "$R_MARK" ] || { echo "ASSERT_FAIL marker data mismatch"; PASS=0; }

# 清理恢复库与临时 dump（源库标记保留无妨，属隔离验收库）
docker exec "$CONTAINER" psql -U "$ADMIN_USER" -d postgres -X -c "DROP DATABASE IF EXISTS $DST_DB" >/dev/null 2>&1 || true
docker exec "$CONTAINER" rm -f "$TMP_DUMP" 2>/dev/null || true

if [ "$PASS" = "1" ]; then
  echo "RESULT=PASS backup-restore consistent: tables=$R_TBL migrations=$R_MIG marker_roundtrip=ok"
else
  echo "RESULT=FAIL"
  exit 1
fi

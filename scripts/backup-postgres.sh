#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

backup_dir="/backups"
retention_days="${BACKUP_RETENTION_DAYS:-7}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_file="$backup_dir/.feishu_hq_${timestamp}.dump.tmp"
final_file="$backup_dir/feishu_hq_${timestamp}.dump"

mkdir -p "$backup_dir"
pg_dump "$DATABASE_URL" --format=custom --compress=6 --file="$temporary_file"
mv "$temporary_file" "$final_file"
find "$backup_dir" -type f -name 'feishu_hq_*.dump' -mtime "+$retention_days" -delete

echo "backup complete: $(basename "$final_file")"


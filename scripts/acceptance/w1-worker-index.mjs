// Worker 知识索引回归测试（npm run accept:w1）：真实 PG 验证 C3 修复。
// 断言：旧 `UPDATE ... LIMIT` 报错（证明缺陷真实）；新 `WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` 正常且每批上限=50。
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ensureContainer, applyMigrations, ADMIN_DB_URL } from "./lib.mjs";

const OLD_SQL = `UPDATE knowledge.items SET index_status = 'indexed', last_indexed_at = now()
  WHERE index_status = 'pending' AND deleted_at IS NULL AND content IS NOT NULL AND char_length(content) > 50
  LIMIT 50`;
const NEW_SQL = `UPDATE knowledge.items
  SET index_status = 'indexed', last_indexed_at = now()
  WHERE id IN (
    SELECT id FROM knowledge.items
    WHERE index_status = 'pending' AND deleted_at IS NULL
      AND content IS NOT NULL AND char_length(content) > 50
    ORDER BY id
    LIMIT 50 FOR UPDATE SKIP LOCKED
  )`;

let exitCode = 0;
try {
  await ensureContainer({ fresh: true });
  await applyMigrations();
  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();

  const tenantId = randomUUID();
  await admin.query(`INSERT INTO platform.tenants (id, code, name) VALUES ($1,$2,$3)`,
    [tenantId, "c3verify-" + tenantId.slice(0, 8), "C3 验证租户"]);

  const content = "x".repeat(80); // > 50，满足索引条件
  for (let i = 0; i < 60; i++) {
    await admin.query(`INSERT INTO knowledge.items (id, tenant_id, title, content, index_status) VALUES ($1,$2,$3,$4,'pending')`,
      [randomUUID(), tenantId, `K${i}`, content]);
  }

  // 1) 旧 SQL 必须失败（证明缺陷真实存在）
  let oldFailed = false;
  try { await admin.query(OLD_SQL); } catch (e) { oldFailed = /LIMIT|syntax/i.test(String(e.message)); }
  // 统计按测试租户过滤（迁移预置的演示知识不属于本租户，全局计数会污染断言）
  const pendingBefore = (await admin.query(`SELECT count(*)::int c FROM knowledge.items WHERE index_status='pending' AND tenant_id=$1`, [tenantId])).rows[0].c;

  // 2) 新 SQL 必须成功，且本批只处理 50 行
  const upd = await admin.query(NEW_SQL);
  const indexed = (await admin.query(`SELECT count(*)::int c FROM knowledge.items WHERE index_status='indexed' AND tenant_id=$1`, [tenantId])).rows[0].c;
  const pendingAfter = (await admin.query(`SELECT count(*)::int c FROM knowledge.items WHERE index_status='pending' AND tenant_id=$1`, [tenantId])).rows[0].c;

  const ok = oldFailed && upd.rowCount === 50 && indexed === 50 && pendingBefore === 60 && pendingAfter === 10;
  console.log(JSON.stringify({ RESULT: ok ? "PASS" : "FAIL", old_sql_failed: oldFailed,
    pending_before: pendingBefore, batch_updated: upd.rowCount, indexed, pending_after: pendingAfter }));
  if (!ok) exitCode = 1;

  await admin.query(`DELETE FROM knowledge.items WHERE tenant_id=$1`, [tenantId]);
  await admin.query(`DELETE FROM platform.tenants WHERE id=$1`, [tenantId]);
  await admin.end();
} catch (e) {
  console.log(JSON.stringify({ RESULT: "FAIL", error: String(e && e.message || e) }));
  exitCode = 1;
}
process.exit(exitCode);

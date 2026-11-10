BEGIN;

-- ═══════════════════════════════════════════════════════════
-- 0020 · 读回/落库路径 schema 修复（制造业全流程演练暴露的真实缺陷）
--   1) crm.opportunities：/stage 赢单/失单写 won_at/lost_at，但建表从未含此列
--      → 落库触发 SQL 错误并回滚（stage 卡住）。补"成单/丢单时间"。
--   2) strategy.checkins：GET /key-results/:id 按 c.checked_at 排序，
--      但建表仅有 created_at、无 checked_at → 读回 500→400。补"打卡时间"。
--   3) strategy.key_results：GET /key-results/:id LEFT JOIN 于 kr.owner_person_id，
--      但建表无此列 → 读回 500→400。补 KR 负责人（可空）。
--   迁移只追加，均为业务上本就应有、却遗漏的字段。
-- ═══════════════════════════════════════════════════════════

ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS won_at timestamptz;
ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS lost_at timestamptz;

ALTER TABLE strategy.checkins ADD COLUMN IF NOT EXISTS checked_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE strategy.key_results ADD COLUMN IF NOT EXISTS owner_person_id uuid;

COMMIT;

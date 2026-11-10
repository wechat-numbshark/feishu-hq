-- 0028 · 演示数据补充：恒精制造预置一台生产设备（供点检日历/保养/OEE 演示）
BEGIN;
INSERT INTO equipment.assets (id, tenant_id, asset_code, name, vendor, model, work_center, location, status)
VALUES ('d0000001-0000-4000-8000-00000000ca01','d0000001-0000-4000-8000-000000000001','EQ-CNC-01','五轴加工中心 DMU-50','DMG MORI','DMU-50','WC-CNC-01','车间 A','running')
ON CONFLICT (id) DO NOTHING;
COMMIT;

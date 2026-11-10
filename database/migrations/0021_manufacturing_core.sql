-- 0021 制造执行域核心（P0）：零件主数据 / BOM / 工艺路线 / 生产工单 / 工序 / 报工。
-- 迁移只追加。全部租户隔离（RLS + FORCE）、复合外键 (tenant_id, id) 保证跨租户不可引用，
-- 并显式 GRANT hq_app（API 以 SET LOCAL ROLE hq_app 运行）。
BEGIN;

CREATE SCHEMA IF NOT EXISTS mfg;
GRANT USAGE ON SCHEMA mfg TO hq_app;

-- 1. 零件主数据（成品/半成品/原材料统一为 part，用 kind 区分，支撑 BOM 递归）
CREATE TABLE mfg.parts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  part_number varchar(80) NOT NULL,
  name varchar(200) NOT NULL,
  kind varchar(20) NOT NULL DEFAULT 'product' CHECK (kind IN ('product','assembly','raw')),
  uom varchar(20) NOT NULL DEFAULT 'PCS',
  spec text,
  safety_stock numeric(15,4) NOT NULL DEFAULT 0,
  standard_unit_cost_cents bigint NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, part_number)
);

-- 2. BOM 头/行（父项=product_part，子项=child_part，可多层）
CREATE TABLE mfg.boms (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  product_part_id uuid NOT NULL,
  version varchar(20) NOT NULL DEFAULT 'V1.0',
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','released','obsolete')),
  effective_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version_no bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE mfg.bom_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  bom_id uuid NOT NULL,
  child_part_id uuid NOT NULL,
  position_no integer,
  quantity numeric(15,4) NOT NULL CHECK (quantity > 0),
  scrap_rate numeric(6,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES mfg.boms(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, child_part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

-- 3. 工艺路线头/工序
CREATE TABLE mfg.routings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  product_part_id uuid NOT NULL,
  version varchar(20) NOT NULL DEFAULT 'V1.0',
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','released','obsolete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE mfg.routing_ops (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  routing_id uuid NOT NULL,
  seq_no integer NOT NULL,
  operation_no varchar(20) NOT NULL,
  name varchar(200) NOT NULL,
  work_center varchar(80),
  standard_hours numeric(10,2) NOT NULL DEFAULT 0,
  inspect boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, routing_id, seq_no),
  FOREIGN KEY (tenant_id, routing_id) REFERENCES mfg.routings(tenant_id, id) ON DELETE CASCADE
);

-- 4. 生产工单 + 工序明细（快照自工艺路线）+ 报工
CREATE TABLE mfg.work_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  wo_number varchar(40) NOT NULL,
  product_part_id uuid NOT NULL,
  project_id uuid,
  bom_id uuid,
  routing_id uuid,
  planned_qty numeric(15,4) NOT NULL CHECK (planned_qty > 0),
  completed_qty numeric(15,4) NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','released','in_progress','completed','closed','cancelled')),
  priority varchar(10) NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  planned_start date,
  planned_finish date,
  actual_finish timestamptz,
  materialized boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, wo_number),
  FOREIGN KEY (tenant_id, product_part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, bom_id) REFERENCES mfg.boms(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, routing_id) REFERENCES mfg.routings(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE mfg.work_order_ops (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  work_order_id uuid NOT NULL,
  seq_no integer NOT NULL,
  operation_no varchar(20) NOT NULL,
  name varchar(200) NOT NULL,
  work_center varchar(80),
  standard_hours numeric(10,2) NOT NULL DEFAULT 0,
  inspect boolean NOT NULL DEFAULT false,
  qty_reported numeric(15,4) NOT NULL DEFAULT 0,
  qty_good numeric(15,4) NOT NULL DEFAULT 0,
  qty_scrap numeric(15,4) NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, work_order_id, seq_no),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES mfg.work_orders(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE mfg.work_reports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  work_order_id uuid NOT NULL,
  work_order_op_id uuid NOT NULL,
  person_id uuid,
  qty_good numeric(15,4) NOT NULL DEFAULT 0 CHECK (qty_good >= 0),
  qty_scrap numeric(15,4) NOT NULL DEFAULT 0 CHECK (qty_scrap >= 0),
  hours_logged numeric(10,2) NOT NULL DEFAULT 0 CHECK (hours_logged >= 0),
  reported_at timestamptz NOT NULL DEFAULT now(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES mfg.work_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, work_order_op_id) REFERENCES mfg.work_order_ops(tenant_id, id) ON DELETE CASCADE
);

-- RLS + 授权：对 mfg schema 全部表统一处理
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mfg.parts','mfg.boms','mfg.bom_lines','mfg.routings','mfg.routing_ops',
    'mfg.work_orders','mfg.work_order_ops','mfg.work_reports'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO hq_app', t);
  END LOOP;
END $$;

COMMIT;

-- 0023 制造域扩展（P1）：设备域（台账/点检/停机/OEE 基础/保养）、销售订单与发货出库、
-- 工单成本归集（料/工/费）；并为 outbox 生产者补 hq_app 授权（API 以 SET LOCAL ROLE hq_app 写入）。
-- 迁移只追加。全部租户隔离（RLS + FORCE）、复合外键 (tenant_id, id)。
BEGIN;

CREATE SCHEMA IF NOT EXISTS equipment;
CREATE SCHEMA IF NOT EXISTS sales;
GRANT USAGE ON SCHEMA equipment, sales TO hq_app;

-- ── 1. 设备台账（生产设备，区别于 it.assets 的 IT 资产）
CREATE TABLE equipment.assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  asset_code varchar(80) NOT NULL,
  name varchar(200) NOT NULL,
  vendor varchar(200),
  model varchar(120),
  work_center varchar(80),
  location varchar(200),
  commissioned_at date,
  standard_rate_cents_per_hour bigint NOT NULL DEFAULT 0 CHECK (standard_rate_cents_per_hour >= 0),
  status varchar(20) NOT NULL DEFAULT 'idle'
    CHECK (status IN ('running','idle','maintenance','fault','scrapped')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, asset_code)
);

-- ── 2. 点检表头 + 项目；点检执行记录（结果摘要 jsonb）
CREATE TABLE equipment.checklists (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  name varchar(200) NOT NULL,
  equipment_id uuid,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment.assets(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE equipment.checklist_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  checklist_id uuid NOT NULL,
  seq_no integer NOT NULL,
  name varchar(200) NOT NULL,
  standard text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, checklist_id, seq_no),
  FOREIGN KEY (tenant_id, checklist_id) REFERENCES equipment.checklists(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE equipment.inspections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  equipment_id uuid NOT NULL,
  checklist_id uuid,
  inspector_person_id uuid,
  inspected_at timestamptz NOT NULL DEFAULT now(),
  result varchar(10) NOT NULL DEFAULT 'normal' CHECK (result IN ('normal','abnormal')),
  items_result jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment.assets(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, checklist_id) REFERENCES equipment.checklists(tenant_id, id) ON DELETE SET NULL
);

-- ── 3. 停机台账（OEE 的可用率原料）
CREATE TABLE equipment.downtime_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  equipment_id uuid NOT NULL,
  downtime_type varchar(10) NOT NULL DEFAULT 'unplanned' CHECK (downtime_type IN ('planned','unplanned')),
  reason_code varchar(60),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment.assets(tenant_id, id) ON DELETE RESTRICT
);

-- ── 4. 保养计划与保养记录
CREATE TABLE equipment.maintenance_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  equipment_id uuid NOT NULL,
  name varchar(200) NOT NULL,
  cycle_days integer NOT NULL CHECK (cycle_days > 0),
  last_performed_at date,
  next_due_at date,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment.assets(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE equipment.maintenance_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  equipment_id uuid NOT NULL,
  plan_id uuid,
  performed_at date NOT NULL DEFAULT current_date,
  performed_by_person_id uuid,
  cost_cents bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  downtime_minutes integer NOT NULL DEFAULT 0 CHECK (downtime_minutes >= 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment.assets(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, plan_id) REFERENCES equipment.maintenance_plans(tenant_id, id) ON DELETE SET NULL
);

-- ── 5. 销售订单 SO + 行 + 发货出库
CREATE TABLE sales.orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  so_number varchar(40) NOT NULL,
  account_id uuid NOT NULL,
  opportunity_id uuid,
  project_id uuid,
  order_date date NOT NULL DEFAULT current_date,
  requested_delivery_date date,
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','confirmed','in_production','ready_to_ship','partial_shipped','shipped','closed','cancelled')),
  currency char(3) NOT NULL DEFAULT 'CNY',
  total_amount_cents bigint NOT NULL DEFAULT 0 CHECK (total_amount_cents >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, so_number),
  FOREIGN KEY (tenant_id, account_id) REFERENCES crm.accounts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm.opportunities(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, project_id) REFERENCES project.projects(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE sales.order_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  part_id uuid NOT NULL,
  quantity numeric(15,4) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  shipped_quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (shipped_quantity >= 0),
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (shipped_quantity <= quantity),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales.orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE sales.shipments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  shipment_number varchar(40) NOT NULL,
  order_id uuid NOT NULL,
  shipped_at timestamptz NOT NULL DEFAULT now(),
  carrier varchar(120),
  tracking_no varchar(120),
  receiver varchar(120),
  status varchar(20) NOT NULL DEFAULT 'shipped' CHECK (status IN ('shipped','delivered','returned')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, shipment_number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales.orders(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE sales.shipment_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  shipment_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  part_id uuid NOT NULL,
  quantity numeric(15,4) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES sales.shipments(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales.order_lines(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

-- ── 6. 工单成本归集（料/工/费），完工结算时 upsert
CREATE TABLE mfg.work_order_costs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  work_order_id uuid NOT NULL,
  material_cents bigint NOT NULL DEFAULT 0 CHECK (material_cents >= 0),
  labor_cents bigint NOT NULL DEFAULT 0 CHECK (labor_cents >= 0),
  overhead_cents bigint NOT NULL DEFAULT 0 CHECK (overhead_cents >= 0),
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  unit_cost_cents numeric(18,2) NOT NULL DEFAULT 0,
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, work_order_id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES mfg.work_orders(tenant_id, id) ON DELETE CASCADE
);

-- ── 7. outbox 生产者授权：API(withTenant→hq_app) 需写入并发事件
GRANT SELECT, INSERT, UPDATE ON platform.outbox_events TO hq_app;

-- ── RLS + 授权
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'equipment.assets','equipment.checklists','equipment.checklist_items',
    'equipment.inspections','equipment.downtime_events',
    'equipment.maintenance_plans','equipment.maintenance_records',
    'sales.orders','sales.order_lines','sales.shipments','sales.shipment_lines',
    'mfg.work_order_costs'
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

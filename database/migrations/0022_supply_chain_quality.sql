-- 0022 供应链与质量域（P0）：供应商 / 请购(PR) / 采购订单(PO) / 收货 / 供应商发票三单匹配；
-- 库存现存量与收发存流水；质检来料检/过程检/成品检 + 实测值 + 不合格品(NCR)。
-- 迁移只追加。全部租户隔离（RLS + FORCE）、复合外键 (tenant_id, id)、显式 GRANT hq_app。
BEGIN;

CREATE SCHEMA IF NOT EXISTS purchase;
CREATE SCHEMA IF NOT EXISTS stock;
CREATE SCHEMA IF NOT EXISTS qms;
GRANT USAGE ON SCHEMA purchase, stock, qms TO hq_app;

-- ── 1. 供应商
CREATE TABLE purchase.suppliers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  supplier_code varchar(80) NOT NULL,
  name varchar(200) NOT NULL,
  contact_person varchar(80),
  contact_phone varchar(40),
  email varchar(200),
  payment_terms varchar(80),
  lead_time_days integer NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, supplier_code)
);

-- ── 2. 请购单 PR + 行
CREATE TABLE purchase.requisitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  pr_number varchar(40) NOT NULL,
  requester_person_id uuid,
  need_date date,
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected','converted','cancelled')),
  reason text,
  total_amount_cents bigint NOT NULL DEFAULT 0 CHECK (total_amount_cents >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, pr_number)
);

CREATE TABLE purchase.requisition_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  requisition_id uuid NOT NULL,
  part_id uuid NOT NULL,
  quantity numeric(15,4) NOT NULL CHECK (quantity > 0),
  expected_unit_price_cents bigint NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES purchase.requisitions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

-- ── 3. 采购订单 PO + 行
CREATE TABLE purchase.purchase_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  po_number varchar(40) NOT NULL,
  supplier_id uuid NOT NULL,
  requisition_id uuid,
  buyer_person_id uuid,
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','partially_received','received','closed','cancelled')),
  currency char(3) NOT NULL DEFAULT 'CNY',
  total_amount_cents bigint NOT NULL DEFAULT 0 CHECK (total_amount_cents >= 0),
  order_date date NOT NULL DEFAULT current_date,
  expected_delivery_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, po_number),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES purchase.suppliers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES purchase.requisitions(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE purchase.purchase_order_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  part_id uuid NOT NULL,
  quantity numeric(15,4) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  received_quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (received_quantity <= quantity),
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase.purchase_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

-- ── 4. 收货单 + 行（来料检由 qms.inspections.receipt_id 反向关联）
CREATE TABLE purchase.goods_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  receipt_number varchar(40) NOT NULL,
  order_id uuid NOT NULL,
  receiver_person_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  status varchar(20) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','accepted','partial_accepted','rejected')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase.purchase_orders(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE purchase.goods_receipt_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  part_id uuid NOT NULL,
  quantity numeric(15,4) NOT NULL CHECK (quantity > 0),
  accepted_quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (accepted_quantity >= 0),
  rejected_quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (accepted_quantity + rejected_quantity <= quantity),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES purchase.goods_receipts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES purchase.purchase_order_lines(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

-- ── 5. 供应商发票（三单匹配：PO 价 × 收货量 × 发票额；匹配后置应付 finance.invoices payable）
CREATE TABLE purchase.supplier_invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  invoice_number varchar(80) NOT NULL,
  supplier_id uuid NOT NULL,
  order_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  tax_rate numeric(5,4) NOT NULL DEFAULT 0.13,
  invoice_date date NOT NULL DEFAULT current_date,
  match_status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (match_status IN ('pending','matched','mismatched')),
  match_result jsonb,
  finance_invoice_id uuid,
  matched_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, supplier_id, invoice_number),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES purchase.suppliers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase.purchase_orders(tenant_id, id) ON DELETE RESTRICT
);

-- ── 6. 库存：现存量 + 收发存流水
CREATE TABLE stock.onhand (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  part_id uuid NOT NULL,
  warehouse varchar(40) NOT NULL DEFAULT 'MAIN',
  quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  blocked_quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (blocked_quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, part_id, warehouse),
  CHECK (blocked_quantity <= quantity),
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE stock.movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  part_id uuid NOT NULL,
  warehouse varchar(40) NOT NULL DEFAULT 'MAIN',
  direction varchar(3) NOT NULL CHECK (direction IN ('in','out')),
  movement_type varchar(30) NOT NULL
    CHECK (movement_type IN ('purchase_receipt','purchase_return','production_issue','production_receipt','sales_issue','adjustment')),
  quantity numeric(15,4) NOT NULL CHECK (quantity > 0),
  unit_cost_cents bigint NOT NULL DEFAULT 0,
  reference_type varchar(40),
  reference_id uuid,
  person_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX stock_movements_part_idx ON stock.movements (tenant_id, part_id, created_at DESC);

-- ── 7. 质检：检验单 + 实测值 + 不合格品 NCR
CREATE TABLE qms.inspections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  inspection_number varchar(40) NOT NULL,
  inspection_type varchar(20) NOT NULL CHECK (inspection_type IN ('incoming','in_process','final')),
  part_id uuid,
  work_order_id uuid,
  receipt_id uuid,
  total_quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
  sample_quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (sample_quantity >= 0),
  result varchar(10) NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','pass','fail')),
  inspector_person_id uuid,
  inspected_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, inspection_number),
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES mfg.work_orders(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES purchase.goods_receipts(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE qms.inspection_measurements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  inspection_id uuid NOT NULL,
  characteristic varchar(100) NOT NULL,
  standard_value text,
  measured_value text,
  result varchar(5) NOT NULL DEFAULT 'na' CHECK (result IN ('pass','fail','na')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES qms.inspections(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE qms.ncrs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE RESTRICT,
  ncr_number varchar(40) NOT NULL,
  inspection_id uuid,
  work_order_id uuid,
  receipt_id uuid,
  part_id uuid,
  quantity numeric(15,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  description text NOT NULL,
  disposition varchar(30) NOT NULL DEFAULT 'pending'
    CHECK (disposition IN ('pending','use_as_is','rework','scrap','return_to_supplier')),
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  owner_person_id uuid,
  closed_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ncr_number),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES qms.inspections(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES mfg.work_orders(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES purchase.goods_receipts(tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, part_id) REFERENCES mfg.parts(tenant_id, id) ON DELETE RESTRICT
);

-- ── RLS + 授权：purchase/stock/qms 全部表统一处理
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'purchase.suppliers','purchase.requisitions','purchase.requisition_lines',
    'purchase.purchase_orders','purchase.purchase_order_lines',
    'purchase.goods_receipts','purchase.goods_receipt_lines','purchase.supplier_invoices',
    'stock.onhand','stock.movements',
    'qms.inspections','qms.inspection_measurements','qms.ncrs'
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

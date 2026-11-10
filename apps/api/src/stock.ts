// 库存过账的唯一入口：写 stock.movements 流水 + upsert stock.onhand 现存量。
// 出库不足即抛 insufficient_stock:* 回滚整个 withTenant 事务（不允许负库存）。
import type { DbClient } from "./db.ts";

export interface StockMovementInput {
  partId: string;
  warehouse: string;
  direction: "in" | "out";
  movementType: "purchase_receipt" | "purchase_return" | "production_issue" | "production_receipt" | "sales_issue" | "adjustment";
  quantity: string | number;
  unitCostCents: number;
  referenceType?: string;
  referenceId?: string;
  personId?: string | null;
  note?: string | null;
}

export async function applyStockMovement(db: DbClient, input: StockMovementInput): Promise<void> {
  if (input.direction === "out") {
    const { rows } = await db.query(
      `SELECT quantity FROM stock.onhand WHERE tenant_id = platform.current_tenant_id() AND part_id = $1 AND warehouse = $2`,
      [input.partId, input.warehouse]
    );
    const available = Number(rows[0]?.quantity ?? 0);
    if (!rows[0] || available < Number(input.quantity)) {
      const { rows: pr } = await db.query(
        `SELECT part_number FROM mfg.parts WHERE tenant_id = platform.current_tenant_id() AND id = $1`, [input.partId]);
      throw new Error(`insufficient_stock:${pr[0]?.part_number ?? input.partId}(需要 ${input.quantity}，现有 ${available})`);
    }
    await db.query(
      `UPDATE stock.onhand SET quantity = quantity - $3::numeric, updated_at = now()
       WHERE tenant_id = platform.current_tenant_id() AND part_id = $1 AND warehouse = $2`,
      [input.partId, input.warehouse, input.quantity]
    );
  } else {
    await db.query(
      `INSERT INTO stock.onhand (id, tenant_id, part_id, warehouse, quantity)
       VALUES (gen_random_uuid(), platform.current_tenant_id(), $1, $2, $3::numeric)
       ON CONFLICT (tenant_id, part_id, warehouse)
       DO UPDATE SET quantity = stock.onhand.quantity + EXCLUDED.quantity, updated_at = now()`,
      [input.partId, input.warehouse, input.quantity]
    );
  }
  await db.query(
    `INSERT INTO stock.movements
       (id, tenant_id, part_id, warehouse, direction, movement_type, quantity, unit_cost_cents, reference_type, reference_id, person_id, note)
     VALUES (gen_random_uuid(), platform.current_tenant_id(), $1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10)`,
    [input.partId, input.warehouse, input.direction, input.movementType, input.quantity,
     input.unitCostCents, input.referenceType ?? null, input.referenceId ?? null, input.personId ?? null, input.note ?? null]
  );
}

import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";

const people = {
  gm: { key: "gm", company: "mfg" as const, person: "d0000001-0000-4000-8000-00000000aa01", name: "陈志恒", role: "tenant_admin" },
  buyer: { key: "buyer", company: "mfg" as const, person: "d0000001-0000-4000-8000-00000000aa05", name: "李雷", role: "employee" },
  sales: { key: "sales", company: "mfg" as const, person: "d0000001-0000-4000-8000-00000000aa02", name: "刘慧敏", role: "manager" },
};

test("制造工单：创建 → 下达 → 报工 → 完工", async ({ page }) => {
  await loginAs(page, people.buyer);
  const parts = await (await page.request.get("/v1/mfg/parts?limit=50")).json();
  const product = (parts.items || []).find((p: any) => p.kind === "product");
  expect(product).toBeTruthy();

  const created = await page.request.post("/v1/mfg/work-orders", {
    data: { product_part_id: product.id, planned_qty: 5 },
    headers: { origin: BASE },
  });
  expect(created.status()).toBe(201);
  const wo = await created.json();

  expect((await page.request.post(`/v1/mfg/work-orders/${wo.id}/release`, { data: {}, headers: { origin: BASE } })).status()).toBe(200);
  expect((await page.request.post(`/v1/mfg/work-orders/${wo.id}/report`, { data: { qty_good: 5 }, headers: { origin: BASE } })).status()).toBe(201);
  expect((await page.request.post(`/v1/mfg/work-orders/${wo.id}/complete`, { data: {}, headers: { origin: BASE } })).status()).toBe(200);

  const list = await (await page.request.get("/v1/mfg/work-orders?limit=100")).json();
  const final = (list.items || []).find((x: any) => x.id === wo.id);
  expect(final?.status).toBe("completed");
});

test("销售订单：创建 → 确认", async ({ page }) => {
  await loginAs(page, people.sales);
  const [accounts, parts] = await Promise.all([
    page.request.get("/v1/crm/accounts?limit=10").then((r) => r.json()),
    page.request.get("/v1/mfg/parts?limit=50").then((r) => r.json()),
  ]);
  const account = (accounts.items || [])[0];
  const product = (parts.items || []).find((p: any) => p.kind === "product");
  expect(account && product).toBeTruthy();

  const created = await page.request.post("/v1/sales/orders", {
    data: { account_id: account.id, lines: [{ part_id: product.id, quantity: 1, unit_price_cents: 5000 }] },
    headers: { origin: BASE },
  });
  expect(created.status()).toBe(201);
  const order = await created.json();
  expect((await page.request.post(`/v1/sales/orders/${order.id}/confirm`, { data: {}, headers: { origin: BASE } })).status()).toBe(200);
});

test("物料 CSV 导入：模板 → 干跑 → 提交", async ({ page }) => {
  await loginAs(page, people.gm);
  const template = await page.request.get("/v1/import/parts/template");
  expect(template.status()).toBe(200);
  expect(await template.text()).toContain("料号");

  const partNumber = `E2E-PART-${Date.now()}`;
  const csv = `料号,名称,类型,单位,安全库存,规格\n${partNumber},E2E 物料,product,PCS,12,6061`;
  const dry = await page.request.post("/v1/import/parts", { data: { csv, dryRun: true }, headers: { origin: BASE } });
  expect(dry.status()).toBe(200);
  expect((await dry.json()).valid).toBe(1);

  const commit = await page.request.post("/v1/import/parts", { data: { csv, dryRun: false }, headers: { origin: BASE } });
  expect(commit.status()).toBe(201);
  expect((await commit.json()).imported).toBe(1);
});

test("质量检验：创建 → 判定", async ({ page }) => {
  await loginAs(page, people.gm);
  const parts = await (await page.request.get("/v1/mfg/parts?limit=50")).json();
  const product = (parts.items || []).find((p: any) => p.kind === "product");
  const created = await page.request.post("/v1/qms/inspections", {
    data: { inspection_type: "incoming", part_id: product.id, total_quantity: 10, sample_quantity: 2 },
    headers: { origin: BASE },
  });
  expect(created.status()).toBe(201);
  const inspection = await created.json();
  expect((await page.request.post(`/v1/qms/inspections/${inspection.id}/verdict`, { data: { result: "pass" }, headers: { origin: BASE } })).status()).toBe(200);
});

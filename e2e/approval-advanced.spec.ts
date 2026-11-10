import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";

test("审批高级：转交 → 加签 → 多级通过", async ({ page }) => {
  const desc = `E2E高级审批-${Date.now()}`;
  await loginAs(page, { key: "buyer", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa05", name: "李雷", role: "employee" });
  const created = await page.request.post("/v1/finance/expenses", {
    data: { category: "travel", amount_cents: 900000, description: desc },
    headers: { origin: BASE },
  });
  expect(created.status()).toBe(201);
  const expense = await created.json();

  await loginAs(page, { key: "mgr", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa06", name: "周建军", role: "manager" });
  const pending = await (await page.request.get("/v1/approvals/pending")).json();
  const instance = (pending.items || []).find((x: any) => String(x.title).includes(desc));
  expect(instance, JSON.stringify(pending)).toBeTruthy();

  const transfer = await page.request.post(`/v1/approvals/${instance.id}/transfer`, {
    data: { person_id: "d0000001-0000-4000-8000-00000000aa04", reason: "E2E 转交" },
    headers: { origin: BASE },
  });
  expect(transfer.status()).toBe(200);

  await loginAs(page, { key: "aa04", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa04", name: "赵国庆", role: "manager" });
  const addSign = await page.request.post(`/v1/approvals/${instance.id}/add-sign`, {
    data: { person_id: "d0000001-0000-4000-8000-00000000aa02", position: "after", reason: "E2E 加签" },
    headers: { origin: BASE },
  });
  expect(addSign.status()).toBe(200);

  const first = await page.request.post(`/v1/approvals/${instance.id}/decide`, { data: { decision: "approved" }, headers: { origin: BASE } });
  expect(first.status()).toBe(200);

  await loginAs(page, { key: "aa02", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa02", name: "刘慧敏", role: "manager" });
  const second = await page.request.post(`/v1/approvals/${instance.id}/decide`, { data: { decision: "approved" }, headers: { origin: BASE } });
  expect(second.status()).toBe(200);

  await loginAs(page, { key: "fin", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa08", name: "赵敏", role: "finance_manager" });
  const third = await page.request.post(`/v1/approvals/${instance.id}/decide`, { data: { decision: "approved" }, headers: { origin: BASE } });
  expect(third.status()).toBe(200);

  await loginAs(page, { key: "buyer2", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa05", name: "李雷", role: "employee" });
  const list = await (await page.request.get("/v1/finance/expenses?limit=50")).json();
  const final = (list.items || []).find((x: any) => x.id === expense.id);
  expect(final?.status).toBe("approved");
});

import { test, expect } from "@playwright/test";
import { PERSONAS, loginAs, gotoView, collectPageErrors } from "./helpers";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";

test.describe("身份与权限矩阵", () => {
  for (const persona of PERSONAS) {
    test(`${persona.key} 登录并进入工作台`, async ({ page }) => {
      const errors = collectPageErrors(page);
      await loginAs(page, persona);
      await expect(page.locator(".company-switch b")).toBeVisible();
      await gotoView(page, "workbench");
      await expect(page.locator(".module-hero h1")).toContainText("我的工作台");
      await expect(page.locator("body")).not.toHaveClass(/unauthenticated/);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});

test.describe("三条主链", () => {
  test("销售 → 合同 → 项目 → 回款", async ({ page }) => {
    await loginAs(page, PERSONAS[1]);
    const errors = collectPageErrors(page);

    await gotoView(page, "crm");
    await expect(page.locator("body")).toContainText("华驰");

    await gotoView(page, "contracts");
    const detailBtn = page.locator("button[data-contract-id]").first();
    await expect(detailBtn).toBeVisible({ timeout: 15_000 });
    await detailBtn.click();
    await expect(page.locator(".detail-drawer")).toContainText("收款计划");
    await page.locator(".drawer-close").click();

    await gotoView(page, "projects");
    await expect(page.locator("body")).toContainText("华驰");
    await gotoView(page, "finance");
    await page.locator('[data-fin-tab="payments"]').click();
    await page.waitForTimeout(500);
    await expect(page.locator("body")).toContainText("收款");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("招聘 → 入职 → 研发交付", async ({ page }) => {
    await loginAs(page, PERSONAS[5]);
    await gotoView(page, "hr");
    await expect(page.locator("body")).toContainText("人才");
    await gotoView(page, "org");
    await expect(page.locator("body")).toContainText("组织");
    await gotoView(page, "dev");
    await expect(page.locator(".module-hero h1")).toContainText("研发中心");
    await page.locator('[data-dev-tab="iterations"]').click();
    await expect(page.locator(".module-create")).toContainText("新建迭代");
  });

  test("费用 → 经理审批 → 财务审批 → 终态", async ({ page }) => {
    await loginAs(page, PERSONAS[4]);
    const desc = `E2E审批-${Date.now()}`;
    const created = await page.request.post("/v1/finance/expenses", {
      data: { category: "travel", amount_cents: 900000, description: desc },
      headers: { origin: BASE },
    });
    expect(created.status()).toBe(201);
    const expense = await created.json();

    await loginAs(page, {
      key: "mfg-purchase-manager", company: "mfg",
      person: "d0000001-0000-4000-8000-00000000aa06", name: "周建军", role: "manager",
    });
    await gotoView(page, "approvals");
    const managerRow = page.locator("tr[data-approval-id]", { hasText: desc }).first();
    await expect(managerRow).toBeVisible({ timeout: 15_000 });
    await managerRow.getByRole("button", { name: "同意" }).click();
    await page.waitForTimeout(900);

    await loginAs(page, PERSONAS[3]);
    await gotoView(page, "approvals");
    const financeRow = page.locator("tr[data-approval-id]", { hasText: desc }).first();
    if (await financeRow.count()) {
      await financeRow.getByRole("button", { name: "同意" }).click();
      await page.waitForTimeout(900);
    }

    await loginAs(page, PERSONAS[4]);
    const list = await page.request.get("/v1/finance/expenses?limit=50");
    const items = (await list.json()).items || [];
    const final = items.find((x: any) => x.id === expense.id);
    expect(final?.status, JSON.stringify(final)).toBe("approved");
  });
});

test.describe("安全负例", () => {
  test("员工写接口与敏感读被拒绝", async ({ page }) => {
    await loginAs(page, PERSONAS[4]);
    const project = await page.request.post("/v1/projects", {
      data: { name: "e2e-should-fail", customer_name: "e2e" },
      headers: { origin: BASE },
    });
    expect(project.status()).toBe(403);

    const audit = await page.request.get("/v1/audit/events");
    expect(audit.status()).toBe(403);

    const evil = await page.request.post("/v1/projects", {
      data: { name: "e2e-csrf", customer_name: "e2e" },
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status()).toBe(403);

    const plain = await page.request.post("/v1/projects", {
      data: "{}",
      headers: { "content-type": "text/plain", origin: BASE },
    });
    expect(plain.status()).toBe(415);
  });

  test("会话撤销后访问被拒绝", async ({ page }) => {
    await loginAs(page, PERSONAS[0]);
    const before = await page.request.get("/v1/workspace");
    expect(before.status()).toBe(200);
    const out = await page.request.post("/v1/session/logout-all", { data: {}, headers: { origin: BASE } });
    expect(out.status()).toBe(200);
    const after = await page.request.get("/v1/workspace");
    expect(after.status()).toBe(401);
  });
});

test.describe("平台能力与行业页面", () => {
  test("全局搜索、通知、导入模板", async ({ page }) => {
    await loginAs(page, PERSONAS[1]);
    await page.locator(".command-trigger").click();
    await page.locator(".command-palette input").fill("华驰");
    await expect(page.locator(".palette-results button").first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");

    await page.locator(".notification-button").click();
    await expect(page.locator(".notification-menu")).toHaveClass(/open/);

    const template = await page.request.get("/v1/import/employees/template");
    expect(template.status()).toBe(200);
    expect(await template.text()).toContain("姓名");
  });

  test("制造/供应链/质量/设备/销售订单页面可打开", async ({ page }) => {
    await loginAs(page, PERSONAS[1]);
    const errors = collectPageErrors(page);
    await gotoView(page, "manufacturing");
    await expect(page.locator(".module-hero h1")).toContainText("制造执行");
    await page.locator('[data-mfg-tab="parts"]').click();
    await expect(page.locator("body")).toContainText("CNC");

    for (const [view, title] of [
      ["supplychain", "供应链"], ["quality", "质量管理"], ["equipment", "设备管理"], ["sales", "销售订单"],
    ] as const) {
      await gotoView(page, view);
      await expect(page.locator(".module-hero h1")).toContainText(title);
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("移动端 390x844 可打开项目页", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, PERSONAS[1]);
    await gotoView(page, "projects");
    await expect(page.locator(".module-hero h1")).toContainText("项目作战室");
    await expect(page.locator(".mobile-menu")).toBeVisible();
  });
});

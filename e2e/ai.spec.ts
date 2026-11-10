import { test, expect } from "@playwright/test";
import { PERSONAS, loginAs, gotoView } from "./helpers";

test("AI 总部：主对话区可见、回答不落入隐藏侧栏、未配置有明确提示", async ({ page }) => {
  await loginAs(page, PERSONAS[0]);
  await gotoView(page, "ai");
  await expect(page.locator("#ai-main-flow")).toBeVisible();
  await expect(page.locator(".ai-rail")).toBeHidden();
  await expect(page.locator("#ai-status-banner")).toContainText(/已连接|未配置/);

  await page.locator("[data-ai-prompt]").first().click();
  await expect(page.locator("#ai-main-flow .user-message")).toHaveCount(1);
  await expect(page.locator("#ai-main-flow .assistant-message")).toHaveCount(1);
  const text = await page.locator("#ai-main-flow").innerText();
  expect(text).toContain("AI 模型");
});

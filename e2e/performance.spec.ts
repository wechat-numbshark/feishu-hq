import { test, expect } from "@playwright/test";
import { PERSONAS, loginAs, gotoView } from "./helpers";

test("首页性能基线：导航与资源体积", async ({ page }) => {
  await loginAs(page, PERSONAS[1]);
  await gotoView(page, "overview");
  await page.waitForTimeout(500);
  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return {
      domContentLoaded: nav?.domContentLoadedEventEnd ?? 0,
      load: nav?.loadEventEnd ?? 0,
      resources: resources.length,
      transferBytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
    };
  });
  expect(perf.domContentLoaded, JSON.stringify(perf)).toBeLessThan(8000);
  expect(perf.load, JSON.stringify(perf)).toBeLessThan(12000);
  expect(perf.transferBytes, JSON.stringify(perf)).toBeLessThan(5 * 1024 * 1024);
});

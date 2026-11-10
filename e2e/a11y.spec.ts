import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PERSONAS, loginAs, gotoView } from "./helpers";

const VIEWS = [
  ["overview", "经营总览"],
  ["workbench", "我的工作台"],
  ["projects", "项目作战室"],
  ["crm", "客户与销售"],
  ["approvals", "审批中心"],
] as const;

test.describe("可访问性基线（WCAG 2.2 A/AA 严重项）", () => {
  for (const [view, title] of VIEWS) {
    test(`${title} 无 critical 可访问性问题`, async ({ page }) => {
      await loginAs(page, PERSONAS[1]);
      await gotoView(page, view);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const critical = results.violations.filter((v) => v.impact === "critical");
      const summary = critical.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n");
      expect(critical, summary).toEqual([]);
    });
  }
});

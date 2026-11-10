import { expect, type Page } from "@playwright/test";

export interface Persona {
  key: string;
  company: "standard" | "mfg" | "sw";
  person?: string;
  name: string;
  role: string;
}

export const PERSONAS: Persona[] = [
  { key: "standard-admin", company: "standard", name: "体验管理员", role: "tenant_admin" },
  { key: "mfg-gm", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa01", name: "陈志恒", role: "tenant_admin" },
  { key: "mfg-sales", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa02", name: "刘慧敏", role: "manager" },
  { key: "mfg-finance", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa08", name: "赵敏", role: "finance_manager" },
  { key: "mfg-buyer", company: "mfg", person: "d0000001-0000-4000-8000-00000000aa05", name: "李雷", role: "employee" },
  { key: "sw-hrd", company: "sw", person: "d0000002-0000-4000-8000-00000000bb03", name: "罗幻", role: "hr_manager" },
];

export async function loginAs(page: Page, persona: Persona): Promise<void> {
  await page.context().clearCookies();
  const res = await page.request.post("/v1/session/demo", {
    data: persona.person ? { company: persona.company, person: persona.person } : { company: persona.company },
    headers: { origin: (process.env.E2E_BASE_URL || "http://127.0.0.1:3000") },
  });
  expect(res.status(), `demo login ${persona.key}`).toBe(201);
  await page.goto("/");
  await expect(page.locator("body")).toHaveClass(/authenticated/, { timeout: 15_000 });
}

export async function gotoView(page: Page, view: string): Promise<void> {
  // 前端用 replaceState 切视图，不监听 hashchange；直接调用 renderView 才可靠。
  await page.evaluate((v) => (window as unknown as { renderView: (view: string) => void }).renderView(v), view);
  await page.waitForTimeout(900);
}

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

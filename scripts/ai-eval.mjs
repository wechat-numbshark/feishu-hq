// AI 黄金问题评测：node scripts/ai-eval.mjs [--base=http://...] [--company=standard] [--limit=10] [--json]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const [k, ...v] = a.slice(2).split("="); return [k, v.join("=") || true];
}));
const base = String(args.base || process.env.AI_EVAL_BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
const company = String(args.company || "standard");
const limit = Number(args.limit || 0);
const root = process.cwd();
const cases = JSON.parse(await readFile(path.join(root, "evals/ai-golden.json"), "utf8")).slice(0, limit || undefined);

const login = await fetch(`${base}/v1/session/demo`, {
  method: "POST", headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ company }),
});
if (!login.ok) { console.error("login failed", login.status, await login.text()); process.exit(2); }
const cookie = login.headers.get("set-cookie").split(";")[0];

const results = [];
for (const c of cases) {
  const started = Date.now();
  let status = 0, body = {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 70_000);
    const res = await fetch(`${base}/v1/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ message: c.question, context_module: c.category === "cross" ? "overview" : c.category }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch (error) {
    body = { error: String(error) };
  }
  const latency = Date.now() - started;
  const answer = String(body.message || "");
  const tools = Array.isArray(body.tools_used) ? body.tools_used : [];
  const citations = Array.isArray(body.citations) ? body.citations : [];
  const missingTools = (c.expect_tools || []).filter(t => !tools.includes(t));
  // 同义词组：命中任意一个即可（例如 不能/无权/无法）。
  const missingKeywords = (c.expect_keywords || []).length && !c.expect_keywords.some(k => answer.includes(k))
    ? c.expect_keywords : [];
  const forbidden = (c.forbid || []).filter(k => answer.includes(k));
  const citationOk = !c.expect_citation || citations.length > 0;
  const passed = status === 200 && missingTools.length === 0 && missingKeywords.length === 0 && forbidden.length === 0 && citationOk;
  results.push({ id: c.id, category: c.category, passed, status, latency_ms: latency, tools, missingTools, missingKeywords, forbidden, citations: citations.length, error: body.error || null, answer: answer.slice(0, 180) });
  console.log(`${passed ? "PASS" : "FAIL"}  ${c.id.padEnd(22)} ${String(latency).padStart(6)}ms  tools=[${tools.join(",")}]${missingTools.length ? ` missing=${missingTools.join(",")}` : ""}${missingKeywords.length ? ` kw=${missingKeywords.join(",")}` : ""}${forbidden.length ? ` forbid=${forbidden.join(",")}` : ""}${!citationOk ? " no-citation" : ""}${status !== 200 ? ` status=${status}` : ""}`);
  if (!passed) console.log(`      ${answer.replace(/\n/g, " ").slice(0, 160)}`);
}

const passed = results.filter(r => r.passed).length;
const summary = {
  base, company, at: new Date().toISOString(), total: results.length, passed,
  pass_rate: results.length ? Math.round(passed / results.length * 1000) / 10 : 0,
  avg_latency_ms: results.length ? Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length) : 0,
  results,
};
await writeFile(path.join(root, "evals/last-run.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`\nAI-EVAL ${passed}/${results.length} (${summary.pass_rate}%) avg=${summary.avg_latency_ms}ms`);
if (args.json) console.log(JSON.stringify(summary, null, 2));
process.exit(summary.pass_rate >= Number(args.threshold || 80) ? 0 : 1);

// ──────────────────────────────────────────────────────────────
// 运行时配置（集中读取环境变量，避免散落的 process.env）
// ──────────────────────────────────────────────────────────────
const nodeEnv = process.env.NODE_ENV ?? "development";

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const config = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",

  // 演示模式：生产默认关闭，必须显式 DEMO_MODE=true 才开启。
  demoMode: bool("DEMO_MODE", nodeEnv !== "production"),

  // 反向代理：只有显式信任时才读取 X-Forwarded-For。
  trustProxy: bool("TRUST_PROXY", false),

  // 站点公开地址（CORS / 飞书卡片链接 / Origin 校验）
  appBaseUrl: (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),

  // 生产 CORS 白名单；为空表示只允许同源（不反射任意 Origin）。
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // 会话有效期：demo 2 小时，正式 12 小时。
  sessionTtlMs: 12 * 60 * 60 * 1000,
  demoSessionTtlMs: 2 * 60 * 60 * 1000,

  // Cookie Secure：生产默认 true；仅 HTTP 试用环境显式设 COOKIE_SECURE=false。
  cookieSecure: bool("COOKIE_SECURE", nodeEnv === "production"),

  // 请求体上限（Webhook 单独 1MB，常规 API 2MB）。
  maxBodyBytes: 2 * 1024 * 1024,
  maxWebhookBytes: 1 * 1024 * 1024,
} as const;

export function assertProductionConfig(): void {
  if (!config.isProduction) return;
  if (config.demoMode) {
    console.warn(JSON.stringify({ level: "warn", message: "DEMO_MODE is enabled in production" }));
  }
  if (!config.cookieSecure) {
    console.warn(JSON.stringify({ level: "warn", message: "COOKIE_SECURE=false: only acceptable for HTTP trial, use HTTPS in production" }));
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production");
  }
}

import pg from "pg";
import type { SessionIdentity } from "./session.ts";

const { Pool } = pg;
// PostgreSQL DATE (OID 1082) 默认被解析成 JS Date，跨时区 JSON 序列化会少一天。
// 统一返回 YYYY-MM-DD 字符串，前端/导出/接口语义稳定。
pg.types.setTypeParser(1082, (value: string) => value);
const connectionString = process.env.DATABASE_URL;
export const pool = connectionString ? new Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 }) : null;

export type DbClient = pg.PoolClient;

export async function withTenant<T>(identity: SessionIdentity, fn: (client: DbClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("database_not_configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [identity.tenantId]);
    await client.query("SET LOCAL ROLE hq_app");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function page(query: Record<string, string | undefined>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  return { limit, offset };
}

export function uuid(): string {
  return crypto.randomUUID();
}

// ──────────────────────────────────────────────────────────────
// 服务端会话存储：签发时落库，请求时校验，登出/角色变更时撤销。
// 会话 Cookie 仍是 HMAC 签名；sid 只是"可撤销的引用"。
// ──────────────────────────────────────────────────────────────
import type { IncomingMessage } from "node:http";
import { pool } from "./db.ts";
import type { SessionIdentity } from "./session.ts";

export interface SessionRecord {
  id: string;
  tenantId: string;
  personId: string;
  expiresAt: number;
}

export async function registerSession(
  record: SessionRecord,
  request?: IncomingMessage
): Promise<void> {
  if (!pool) return; // 本地无库的 stub 模式：跳过持久化
  await pool.query(
    `INSERT INTO platform.sessions (id, tenant_id, person_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000))`,
    [
      record.id,
      record.tenantId,
      record.personId,
      request?.headers["user-agent"]?.toString().slice(0, 300) ?? null,
      request?.socket.remoteAddress ?? null,
      record.expiresAt,
    ]
  );
}

export async function isSessionActive(identity: SessionIdentity): Promise<boolean> {
  if (!pool) return true;
  if (!identity.sid) return false; // 旧版 Cookie 无 sid，强制重新登录
  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM platform.sessions
       WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [identity.sid, identity.tenantId]
    );
    return (rowCount ?? 0) > 0;
  } catch (error) {
    // 迁移未应用时不让全站挂掉，但记录告警；生产应按迁移执行。
    console.error(JSON.stringify({
      level: "error", message: "session_check_failed",
      detail: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
}

export async function revokeSession(identity: SessionIdentity): Promise<void> {
  if (!pool || !identity.sid) return;
  await pool.query(
    `UPDATE platform.sessions SET revoked_at = now()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [identity.sid, identity.tenantId]
  );
}

export async function revokeAllSessions(tenantId: string, personId: string): Promise<number> {
  if (!pool) return 0;
  const { rowCount } = await pool.query(
    `UPDATE platform.sessions SET revoked_at = now()
     WHERE tenant_id = $1 AND person_id = $2 AND revoked_at IS NULL`,
    [tenantId, personId]
  );
  return rowCount ?? 0;
}

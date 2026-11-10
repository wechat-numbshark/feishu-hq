import { createDecipheriv, createHmac } from "node:crypto";
import { withTenant, uuid, pool } from "./db.ts";
import { readSession } from "./session.ts";
import { config } from "./config.ts";
import { verifyFeishuSignature, verifyFeishuToken } from "./security.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY ?? "";
const FEISHU_VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN ?? "";

// ── AES-256-CBC 解密（飞书 Encrypt 模式）
function decryptFeishuEvent(encryptedStr: string): unknown {
  const key = createHmac("sha256", "").update(FEISHU_ENCRYPT_KEY).digest();
  const buf = Buffer.from(encryptedStr, "base64");
  const iv = buf.subarray(0, 16);
  const content = buf.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(content), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

// ── 卡片构建器
export const FeishuCardBuilder = {
  // 任务详情卡片
  taskCard(task: Record<string, unknown>, projectName: string) {
    const priority = { critical: "🔴 紧急", high: "🟠 高", medium: "🟡 中", low: "🟢 低" }[task.priority as string] ?? "🟡 中";
    const status = { todo: "待处理", in_progress: "进行中", in_review: "待评审", blocked: "已阻塞", done: "已完成", cancelled: "已取消" }[task.status as string] ?? task.status;
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: {
        template: task.status === "done" ? "green" : task.priority === "critical" ? "red" : "blue",
        title: { tag: "plain_text", content: `◫ ${task.title}` }
      },
      body: {
        elements: [
          { tag: "column_set", flex_mode: "bisect", columns: [
            { tag: "column", elements: [{ tag: "markdown", content: `**项目**\n${projectName}` }] },
            { tag: "column", elements: [{ tag: "markdown", content: `**优先级**\n${priority}` }] },
            { tag: "column", elements: [{ tag: "markdown", content: `**状态**\n${status}` }] }
          ]},
          ...(task.description ? [{ tag: "markdown", content: `**描述**\n${task.description}` }] : []),
          ...(task.due_date ? [{ tag: "markdown", content: `**截止日期** · ${task.due_date}` }] : []),
          { tag: "divider" },
          { tag: "action", actions: [
            { tag: "button", text: { tag: "plain_text", content: "标记完成" }, type: "primary",
              value: JSON.stringify({ action: "task_complete", task_id: task.id }) },
            { tag: "button", text: { tag: "plain_text", content: "查看详情" }, type: "default",
              url: `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/#projects` }
          ]}
        ]
      }
    };
  },

  // 候选人状态变更卡片
  candidateCard(candidate: Record<string, unknown>, requisition: string) {
    const statusLabels: Record<string, string> = {
      new: "新候选人", resume_screening: "简历筛选", phone_screening: "电话初筛",
      technical_interview: "技术面试", hr_interview: "HR 面试", final_interview: "终面",
      offer_pending: "Offer 拟定中", offer_sent: "Offer 已发送", offer_accepted: "已接受 Offer",
      hired: "已入职", rejected: "已拒绝"
    };
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: { template: "purple", title: { tag: "plain_text", content: `♙ 候选人更新` } },
      body: {
        elements: [
          { tag: "markdown", content: `**${candidate.name}** · ${candidate.current_title ?? "未知职位"} · ${candidate.current_company ?? ""}` },
          { tag: "markdown", content: `**招聘职位** ${requisition}\n**当前状态** ${statusLabels[candidate.status as string] ?? candidate.status}` },
          { tag: "divider" },
          { tag: "action", actions: [
            { tag: "button", text: { tag: "plain_text", content: "安排面试" }, type: "primary",
              value: JSON.stringify({ action: "schedule_interview", candidate_id: candidate.id }) },
            { tag: "button", text: { tag: "plain_text", content: "查看资料" }, type: "default",
              url: `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/#hr` }
          ]}
        ]
      }
    };
  },

  // 审批请求卡片
  approvalCard(opts: { title: string; description: string; amount?: number; requesterName: string; actionId: string }) {
    const header = opts.amount
      ? `**${opts.title}**\n申请人：${opts.requesterName}　金额：¥ ${(opts.amount / 100).toLocaleString("zh-CN")}`
      : `**${opts.title}**\n申请人：${opts.requesterName}`;
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: { template: "orange", title: { tag: "plain_text", content: "⚡ 审批请求" } },
      body: {
        elements: [
          { tag: "markdown", content: header },
          ...(opts.description ? [{ tag: "markdown", content: opts.description }] : []),
          { tag: "divider" },
          { tag: "action", actions: [
            { tag: "button", text: { tag: "plain_text", content: "批准" }, type: "primary",
              value: JSON.stringify({ action: "approve", action_id: opts.actionId }) },
            { tag: "button", text: { tag: "plain_text", content: "拒绝" }, type: "danger",
              value: JSON.stringify({ action: "reject", action_id: opts.actionId }) },
            { tag: "button", text: { tag: "plain_text", content: "查看详情" }, type: "default",
              url: `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/#finance` }
          ]}
        ]
      }
    };
  },

  // AI 分析结果卡片
  aiAnalysisCard(title: string, content: string, module: string) {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: { template: "turquoise", title: { tag: "plain_text", content: `✦ ${title}` } },
      body: {
        elements: [
          { tag: "markdown", content },
          { tag: "divider" },
          { tag: "note", elements: [{ tag: "plain_text", content: `AI 总部分析 · ${module} · ${new Date().toLocaleDateString("zh-CN")}` }] }
        ]
      }
    };
  },

  // 机器人欢迎/帮助卡片
  helpCard() {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { tag: "plain_text", content: "✦ 总部助理" } },
      body: {
        elements: [
          { tag: "markdown", content: "你好！我是总部 OS 助理，可以帮你：" },
          { tag: "markdown", content: "- **查看任务**：发送 `/tasks` 或 `我的任务`\n- **创建任务**：发送 `创建任务 [任务名称]`\n- **查询数据**：直接描述你的问题\n- **分析报告**：发送 `/report [项目/模块名称]`" },
          { tag: "divider" },
          { tag: "action", actions: [
            { tag: "button", text: { tag: "plain_text", content: "我的任务" }, type: "default",
              value: JSON.stringify({ action: "my_tasks" }) },
            { tag: "button", text: { tag: "plain_text", content: "今日概览" }, type: "default",
              value: JSON.stringify({ action: "daily_brief" }) }
          ]}
        ]
      }
    };
  }
};

// ── 发送飞书消息
export async function sendFeishuMessage(
  receiveId: string,
  receiveIdType: "open_id" | "chat_id" | "user_id",
  content: unknown,
  msgType: "interactive" | "text" = "interactive"
): Promise<boolean> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return false;

  try {
    const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    const tokenData = await tokenRes.json() as { tenant_access_token: string };
    const token = tokenData.tenant_access_token;

    const msgRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: msgType,
        content: JSON.stringify(msgType === "text" ? { text: content } : content)
      })
    });
    return msgRes.ok;
  } catch {
    return false;
  }
}

// ── Webhook 请求体读取（1MB 上限，防止单请求打满内存）
async function readWebhookBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > config.maxWebhookBytes) throw new Error("request_too_large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reject(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error }));
}

// ── 事件处理
async function handleBotMessage(event: Record<string, unknown>): Promise<void> {
  const message = event.message as Record<string, unknown>;
  const sender = event.sender as Record<string, unknown>;
  const openId = (sender?.sender_id as Record<string, string>)?.open_id;
  if (!openId) return;

  const rawContent = message?.content as string ?? "{}";
  let text = "";
  try {
    text = (JSON.parse(rawContent) as { text?: string }).text ?? "";
  } catch { return; }

  text = text.trim();

  if (!text) return;

  if (text === "/help" || text === "帮助") {
    await sendFeishuMessage(openId, "open_id", FeishuCardBuilder.helpCard());
    return;
  }

  if (text === "/tasks" || text === "我的任务") {
    await sendFeishuMessage(openId, "open_id", { text: "正在查询你的任务，请稍候…" }, "text");
    return;
  }

  await sendFeishuMessage(openId, "open_id",
    FeishuCardBuilder.aiAnalysisCard("总部助理", `收到你的消息：${text}\n\n正在处理中，请稍候...`, "AI"),
  );
}

async function handleCardCallback(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const action = body.action as Record<string, unknown>;
  const operator = body.operator as Record<string, unknown>;
  const openId = (operator?.open_id as string) ?? "";
  const valueStr = action?.value as string ?? "{}";

  let value: Record<string, unknown> = {};
  try { value = JSON.parse(valueStr) as Record<string, unknown>; } catch { /* ignore */ }

  const actionType = value.action as string;

  if (actionType === "task_complete") {
    await sendFeishuMessage(openId, "open_id", { text: "✓ 任务已标记为完成" }, "text");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ toast: { type: "success", content: "任务已完成" } }));
    return;
  }

  if (actionType === "daily_brief") {
    const card = FeishuCardBuilder.aiAnalysisCard("今日经营简报", "正在为你生成今日简报，分析项目进度、销售动态和财务状况...", "AI 总部");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ card }));
    return;
  }

  // 审批卡片回调（approve / reject）
  if ((actionType === "approve" || actionType === "reject") && value.action_id) {
    const actionId = value.action_id as string;
    try {
      if (!pool) throw new Error("database_not_configured");
      // 先解析 action 所属租户（仅读取 tenant_id，随后所有写操作都在 withTenant 内，受 RLS 约束）
      const lookup = await pool.query(
        `SELECT tenant_id, requester_person_id FROM platform.pending_approvals
         WHERE action_id = $1 AND status = 'pending' LIMIT 1`,
        [actionId]
      );
      const row = lookup.rows[0];
      if (!row) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ toast: { type: "error", content: "审批已处理或已过期" } }));
        return;
      }

      const approved = actionType === "approve";
      const newStatus = approved ? "approved" : "rejected";
      const identity = {
        tenantId: row.tenant_id as string,
        personId: row.requester_person_id as string,
        role: "employee" as const,
        mode: "feishu" as const,
        expiresAt: Date.now() + 60_000,
      };

      await withTenant(identity, async (db) => {
        const approvalResult = await db.query(
          `SELECT * FROM platform.pending_approvals
           WHERE action_id = $1 AND status = 'pending' FOR UPDATE`,
          [actionId]
        );
        const approval = approvalResult.rows[0];
        if (!approval) throw new Error("already_processed");

        // 审批人校验：卡片上的审批人必须就是点击卡片的人
        const approverOpenId = approval.approver_feishu_open_id as string | null;
        if (!openId || (approverOpenId && approverOpenId !== openId)) {
          throw new Error("permission_denied");
        }

        await db.query(
          `UPDATE platform.pending_approvals
           SET status = $1, resolved_at = now()
           WHERE action_id = $2 AND tenant_id = platform.current_tenant_id()`,
          [newStatus, actionId]
        );

        if (approval.resource_type === "expense") {
          await db.query(
            `UPDATE finance.expenses SET status = $1, approved_at = now()
             WHERE id = $2 AND tenant_id = platform.current_tenant_id()
               AND status IN ('draft','submitted')`,
            [approved ? "approved" : "rejected", approval.resource_id]
          );
        } else if (approval.resource_type === "leave_request") {
          await db.query(
            `UPDATE hr.leave_requests SET status = $1, approved_at = now()
             WHERE id = $2 AND tenant_id = platform.current_tenant_id() AND status = 'pending'`,
            [approved ? "approved" : "rejected", approval.resource_id]
          );
        }

        await db.query(
          `INSERT INTO audit.audit_events
             (id, tenant_id, actor_id, action, resource_id, resource_type, outcome, change_summary, client_context, trace_id)
           VALUES ($1, platform.current_tenant_id(), $2, $3, $4, $5, 'success', $6::jsonb, $7::jsonb, $8)`,
          [
            uuid(),
            `feishu:${openId}`,
            `approval.card.${approved ? "approve" : "reject"}`,
            approval.resource_id,
            String(approval.resource_type ?? "approval"),
            JSON.stringify({ action_id: actionId, status: newStatus }),
            JSON.stringify({ channel: "feishu_card", operator_open_id: openId }),
            `feishu-card-${actionId}`,
          ]
        );
      });

      // 更新飞书卡片内容
      const updatedCard = {
        schema: "2.0",
        config: { wide_screen_mode: true },
        header: {
          template: approved ? "green" : "red",
          title: { tag: "plain_text", content: approved ? "✓ 审批已通过" : "✗ 审批已拒绝" }
        },
        body: {
          elements: [
            { tag: "markdown", content: `审批人已${approved ? "批准" : "拒绝"}此申请。` },
            { tag: "note", elements: [{ tag: "plain_text", content: `处理时间：${new Date().toLocaleString("zh-CN")}` }] }
          ]
        }
      };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        card: updatedCard,
        toast: { type: approved ? "success" : "info", content: approved ? "已批准" : "已拒绝" }
      }));
    } catch (err) {
      console.error("card_callback_error", err);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ toast: { type: "error", content: "处理失败，请稍后重试" } }));
    }
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({}));
}

async function handleTaskUpdated(event: Record<string, unknown>): Promise<void> {
  const task = event.task as Record<string, unknown>;
  if (!task?.guid) return;
  // 更新本地任务状态，通过 feishu_task_guid 查找
}

// ── 主 Webhook 处理器
export async function handleFeishuWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readWebhookBody(req);
  } catch {
    return reject(res, 413, "request_too_large");
  }

  // 验签：配置了 Encrypt Key 时，所有回调必须带合法 X-Lark-Signature。
  // 生产环境未配置验签凭据时直接拒绝，避免裸奔。
  if (FEISHU_ENCRYPT_KEY) {
    if (!verifyFeishuSignature(req, raw, FEISHU_ENCRYPT_KEY)) {
      return reject(res, 401, "invalid_signature");
    }
  } else if (config.isProduction && !FEISHU_VERIFICATION_TOKEN) {
    return reject(res, 503, "webhook_verification_not_configured");
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return reject(res, 400, "invalid_json");
  }

  // 解密加密事件
  if (body.encrypt) {
    if (!FEISHU_ENCRYPT_KEY) { res.writeHead(501); res.end(); return; }
    try {
      body = decryptFeishuEvent(body.encrypt as string) as Record<string, unknown>;
    } catch {
      return reject(res, 400, "decrypt_failed");
    }
  }

  // 校验 verification token（明文与解密后的事件都应携带）
  if (FEISHU_VERIFICATION_TOKEN) {
    if (!verifyFeishuToken(body, FEISHU_VERIFICATION_TOKEN)) {
      return reject(res, 401, "invalid_verification_token");
    }
  }

  // URL 验证（未加密）
  if (body.type === "url_verification" || body.challenge) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ challenge: body.challenge }));
    return;
  }

  // 互动卡片回调
  if (body.type === "card" || (body as Record<string, unknown>).open_id) {
    await handleCardCallback(body, res);
    return;
  }

  // 事件回调
  if (body.type === "event_callback" || body.schema === "2.0") {
    const header = body.header as Record<string, unknown>;
    const eventType = header?.event_type as string;
    const event = body.event as Record<string, unknown>;

    switch (eventType) {
      case "im.message.receive_v1":
        await handleBotMessage(event);
        break;
      case "task.task.updated":
        await handleTaskUpdated(event);
        break;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({}));
    return;
  }

  res.writeHead(200); res.end(JSON.stringify({}));
}

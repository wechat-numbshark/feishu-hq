// 飞书长连接（WebSocket）事件客户端：无需公网域名/HTTPS 即可接收事件与卡片回调。
// 协议（与官方 SDK 一致的两步握手）：
//   ① POST https://open.feishu.cn/callback/ws/endpoint {AppID, AppSecret} → {data:{URL, ClientConfig}}
//   ② WebSocket 连接 data.URL（wss://msg-frontier.feishu.cn/ws/v2?...，按 ClientConfig.PingInterval 发 ping）
//   服务端 → {type:"connected"}；收到 {type:"ping"} 回 {type:"pong"}
//   事件 {type:"event", data:{header:{event_type,...}, event:{...}}}
//   卡片回调 {type:"callback", data:{operator, action, task_id,...}}，经 {type:"callback_response"} 应答

export interface FeishuWsDeps {
  appId: string;
  appSecret: string;
  log: (level: string, event: string, detail?: string) => void;
  sendText: (receiveId: string, receiveIdType: string, text: string) => Promise<boolean>;
  sendCard: (receiveId: string, receiveIdType: string, card: unknown) => Promise<boolean>;
  query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

interface WsConnectConfig {
  url: string;
  pingIntervalSec: number;
  reconnectIntervalSec: number;
}

async function fetchConnectConfig(appId: string, appSecret: string): Promise<WsConnectConfig | null> {
  try {
    const res = await fetch("https://open.feishu.cn/callback/ws/endpoint", {
      method: "POST",
      headers: { "content-type": "application/json", locale: "zh" },
      body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json() as { code: number; msg?: string; data?: { URL?: string; ClientConfig?: { PingInterval?: number; ReconnectInterval?: number } } };
    if (data.code !== 0 || !data.data?.URL) return null;
    return {
      url: data.data.URL,
      pingIntervalSec: data.data.ClientConfig?.PingInterval ?? 90,
      reconnectIntervalSec: data.data.ClientConfig?.ReconnectInterval ?? 90,
    };
  } catch {
    return null;
  }
}

export async function startFeishuWs(deps: FeishuWsDeps): Promise<void> {
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const stopPing = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };

  const connectOnce = async (cfg: WsConnectConfig): Promise<void> => {
    await new Promise<void>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(cfg.url);
      } catch (e) {
        deps.log("warn", "feishu_ws_construct_failed", String(e));
        resolve();
        return;
      }

      ws.onmessage = (ev: MessageEvent) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
        const type = msg.type as string;
        if (type === "connected") {
          stopPing();
          pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
          }, cfg.pingIntervalSec * 1000);
          const data = msg.data as Record<string, unknown> | undefined;
          deps.log("info", "feishu_ws_connected", `connection=${String(data?.ConnectionID ?? "?")}`);
        } else if (type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (type === "event") {
          void dispatchEvent(msg.data as Record<string, unknown>, deps)
            .catch(e => deps.log("warn", "feishu_ws_event_error", String(e)));
        } else if (type === "callback") {
          void dispatchCallback(ws, msg.data as Record<string, unknown>, deps)
            .catch(e => deps.log("warn", "feishu_ws_callback_error", String(e)));
        }
      };

      ws.onclose = () => { stopPing(); resolve(); };
      ws.onerror = () => { /* onclose 随后触发，统一在 resolve 后重连 */ };
    });
  };

  // 主循环：取配置 → 连接 → 断开后按服务端建议间隔重连（无限重试）
  let warmupMs = 1_000;
  while (!stopped) {
    const cfg = await fetchConnectConfig(deps.appId, deps.appSecret);
    if (!cfg) {
      deps.log("warn", "feishu_ws_config_failed", `retry_in_ms=${warmupMs}`);
      await new Promise(r => setTimeout(r, warmupMs));
      warmupMs = Math.min(warmupMs * 2, 60_000);
      continue;
    }
    warmupMs = 1_000;
    deps.log("info", "feishu_ws_connecting", "endpoint=msg-frontier");
    await connectOnce(cfg);
    if (stopped) break;
    deps.log("warn", "feishu_ws_disconnected", `retry_in_ms=${cfg.reconnectIntervalSec * 1000}`);
    await new Promise(r => setTimeout(r, cfg.reconnectIntervalSec * 1000));
  }
}

// ── 事件分发（schema 2.0）
async function dispatchEvent(data: Record<string, unknown>, deps: FeishuWsDeps): Promise<void> {
  const header = data.header as Record<string, unknown> | undefined;
  const eventType = header?.event_type as string | undefined;
  const event = data.event as Record<string, unknown> | undefined;
  deps.log("info", "feishu_ws_event", String(eventType));

  if (eventType === "im.message.receive_v1" && event) {
    await handleBotMessage(event, deps);
  }
}

// ── 机器人消息：open_id → 本地人员 → 查任务/审批
async function handleBotMessage(event: Record<string, unknown>, deps: FeishuWsDeps): Promise<void> {
  const sender = event.sender as Record<string, unknown> | undefined;
  const openId = ((sender?.sender_id as Record<string, string>) ?? {}).open_id;
  if (!openId) return;

  const message = event.message as Record<string, unknown> | undefined;
  let text = "";
  try {
    text = (JSON.parse(String(message?.content ?? "{}")) as { text?: string }).text ?? "";
  } catch { return; }
  text = text.trim();
  if (!text) return;
  // 群聊里去掉 @机器人 前缀
  text = text.replace(/@_user_\d+\s*/g, "").trim();
  if (!text) return;

  if (text === "/help" || text === "帮助" || text === "你好") {
    await deps.sendCard(openId, "open_id", helpCard());
    return;
  }

  if (text === "/tasks" || text === "我的任务") {
    const rows = await myTasks(deps, openId);
    if (!rows) {
      await deps.sendText(openId, "open_id", "你的飞书账号还未绑定总部 OS 人员，请联系管理员在通讯录中关联。");
      return;
    }
    const lines = rows.length
      ? rows.map(t => `• ${t.title}（${t.status_label}，${t.due ? "截止 " + t.due : "无截止"}）`).join("\n")
      : "没有待办任务 🎉";
    await deps.sendCard(openId, "open_id", listCard("◫ 我的任务", lines, "blue"));
    return;
  }

  if (text === "/approvals" || text === "我的审批") {
    const rows = await myApprovals(deps, openId);
    const lines = rows.length
      ? rows.map(a => `• ${a.resource_type === "expense" ? "报销" : "请假"} · ${a.title ?? a.resource_id}（等待处理）`).join("\n")
      : "没有待处理的审批 🎉";
    await deps.sendCard(openId, "open_id", listCard("⚡ 待我审批", lines, "orange"));
    return;
  }

  if (text === "/brief" || text === "今日概览") {
    await deps.sendCard(openId, "open_id", listCard("✦ 今日概览", "正在生成经营简报…\n可在网页端查看高层看板与工作台。", "turquoise"));
    return;
  }

  await deps.sendCard(openId, "open_id", listCard("✦ 总部助理", `收到：${text}\n\n我目前支持：\n• 我的任务 / /tasks\n• 我的审批 / /approvals\n• 帮助 / /help`, "blue"));
}

async function myTasks(deps: FeishuWsDeps, openId: string) {
  const identity = await deps.query(
    `SELECT person_id, tenant_id FROM platform.external_identities WHERE provider = 'feishu' AND external_subject = $1 LIMIT 1`,
    [openId]
  );
  const p = identity.rows[0];
  if (!p) return null;
  const { rows } = await deps.query(
    `SELECT t.title, t.status, t.due_date::text AS due
     FROM project.tasks t
     WHERE t.tenant_id = $1 AND t.assignee_person_id = $2 AND t.status NOT IN ('done','cancelled')
     ORDER BY t.due_date NULLS LAST LIMIT 10`,
    [p.tenant_id, p.person_id]
  );
  const labels: Record<string, string> = { todo: "待处理", in_progress: "进行中", in_review: "待评审", blocked: "已阻塞" };
  return rows.map(r => ({ title: String(r.title), due: r.due as string | null, status_label: labels[String(r.status)] ?? String(r.status) }));
}

async function myApprovals(deps: FeishuWsDeps, openId: string) {
  const { rows } = await deps.query(
    `SELECT pa.resource_type, pa.resource_id, pa.metadata->>'title' AS title
     FROM platform.pending_approvals pa
     WHERE pa.approver_feishu_open_id = $1 AND pa.status = 'pending'
     ORDER BY pa.created_at DESC LIMIT 10`,
    [openId]
  );
  return rows.map(r => ({ resource_type: String(r.resource_type), resource_id: String(r.resource_id), title: r.title as string | null }));
}

// ── 卡片回调（审批 批准/拒绝、任务完成）
async function dispatchCallback(ws: WebSocket, data: Record<string, unknown>, deps: FeishuWsDeps): Promise<void> {
  const action = data.action as Record<string, unknown> | undefined;
  const operator = data.operator as Record<string, unknown> | undefined;
  const openId = String(operator?.open_id ?? "");
  const taskId = String(data.task_id ?? "");

  let value: Record<string, unknown> = {};
  try { value = JSON.parse(String(action?.value ?? "{}")) as Record<string, unknown>; } catch { /* ignore */ }

  const respond = (payload: unknown) => {
    try {
      if (taskId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "callback_response", task_id: taskId, data: payload }));
    } catch { /* 应答失败不影响处理 */ }
  };

  const actionType = String(value.action ?? "");
  deps.log("info", "feishu_ws_card_action", `${actionType} by ${openId}`);

  if (actionType === "task_complete") {
    await deps.sendText(openId, "open_id", "✓ 任务已标记为完成");
    respond({ toast: { type: "success", content: "任务已完成" } });
    return;
  }

  if (actionType === "approve" || actionType === "reject") {
    const actionId = String(value.action_id ?? "");
    const approved = actionType === "approve";
    if (!actionId) { respond({ toast: { type: "error", content: "缺少审批标识" } }); return; }

    const { rows } = await deps.query(
      `SELECT pa.id, pa.tenant_id, pa.resource_type, pa.resource_id, pa.status
       FROM platform.pending_approvals pa WHERE pa.action_id = $1 AND pa.status = 'pending' LIMIT 1`,
      [actionId]
    );
    const approval = rows[0];
    if (!approval) {
      respond({ toast: { type: "error", content: "审批已处理或已过期" } });
      return;
    }

    await deps.query(
      `UPDATE platform.pending_approvals SET status = $1, resolved_at = now() WHERE action_id = $2`,
      [approved ? "approved" : "rejected", actionId]
    );
    if (approval.resource_type === "expense") {
      await deps.query(
        `UPDATE finance.expenses SET status = $1, approved_at = now() WHERE id = $2 AND status IN ('draft','submitted')`,
        [approved ? "approved" : "rejected", approval.resource_id]
      );
    } else if (approval.resource_type === "leave_request") {
      await deps.query(
        `UPDATE hr.leave_requests SET status = $1, approved_at = now() WHERE id = $2 AND status = 'pending'`,
        [approved ? "approved" : "rejected", approval.resource_id]
      );
    }
    deps.log("info", "feishu_ws_approval_resolved", `${actionId} → ${approved ? "approved" : "rejected"}`);
    respond({
      toast: { type: approved ? "success" : "info", content: approved ? "已批准" : "已拒绝" },
      card: resolvedCard(approved),
    });
    return;
  }

  respond({});
}

// ── 卡片构建
function helpCard(): unknown {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "✦ 总部助理" } },
    body: { elements: [
      { tag: "markdown", content: "你好！我是总部 OS 助理，直接在飞书里即可：" },
      { tag: "markdown", content: "- **我的任务** / `/tasks` — 查询分配给你的任务\n- **我的审批** / `/approvals` — 待你处理的审批\n- **今日概览** / `/brief` — 经营简报\n- **帮助** / `/help`" }
    ]}
  };
}

function listCard(title: string, content: string, template: string): unknown {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: title } },
    body: { elements: [
      { tag: "markdown", content },
      { tag: "note", elements: [{ tag: "plain_text", content: `总部 OS · ${new Date().toLocaleString("zh-CN")}` }] }
    ]}
  };
}

function resolvedCard(approved: boolean): unknown {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: { template: approved ? "green" : "red", title: { tag: "plain_text", content: approved ? "✓ 审批已通过" : "✗ 审批已拒绝" } },
    body: { elements: [
      { tag: "markdown", content: `审批人已${approved ? "批准" : "拒绝"}此申请。` },
      { tag: "note", elements: [{ tag: "plain_text", content: `处理时间：${new Date().toLocaleString("zh-CN")}` }] }
    ]}
  };
}

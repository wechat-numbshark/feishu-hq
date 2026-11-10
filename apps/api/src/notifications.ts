/**
 * 通知服务
 * 负责：① 查找人员飞书 open_id → ② 发送飞书消息/卡片
 * 所有通知失败不影响主流程（silent fallback）
 */
import { sendFeishuMessage, FeishuCardBuilder } from "./feishu-webhook.ts";
import { uuid } from "./db.ts";

const APP_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";

// ── 查询人员飞书 open_id
export async function getPersonFeishuOpenId(db: any, personId: string): Promise<string | null> {
  if (!personId) return null;
  try {
    const { rows } = await db.query(
      `SELECT feishu_open_id FROM platform.people WHERE id = $1 AND feishu_open_id IS NOT NULL`,
      [personId]
    );
    return rows[0]?.feishu_open_id ?? null;
  } catch { return null; }
}

// ── 创建待审批记录 + 发送审批卡片
export async function createApprovalRequest(db: any, opts: {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  requesterPersonId: string;
  approverPersonId: string;
  cardTitle: string;
  cardDescription: string;
  amountCents?: number;
  requesterName: string;
}): Promise<string | null> {
  try {
    const actionId = `${opts.resourceType}-${opts.resourceId}-${Date.now()}`;
    const approverOpenId = await getPersonFeishuOpenId(db, opts.approverPersonId);

    await db.query(
      `INSERT INTO platform.pending_approvals
         (id, tenant_id, action_id, resource_type, resource_id, requester_person_id, approver_feishu_open_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, action_id) DO NOTHING`,
      [uuid(), opts.tenantId, actionId, opts.resourceType, opts.resourceId,
       opts.requesterPersonId, approverOpenId]
    );

    if (approverOpenId) {
      const card = FeishuCardBuilder.approvalCard({
        title: opts.cardTitle,
        description: opts.cardDescription,
        amount: opts.amountCents,
        requesterName: opts.requesterName,
        actionId
      });
      await sendFeishuMessage(approverOpenId, "open_id", card);
    }
    return actionId;
  } catch { return null; }
}

// ── 任务分配通知
export async function notifyTaskAssigned(db: any, task: any, projectName: string, assigneePersonId: string) {
  const openId = await getPersonFeishuOpenId(db, assigneePersonId);
  if (!openId) return;
  const card = FeishuCardBuilder.taskCard(task, projectName);
  await sendFeishuMessage(openId, "open_id", card).catch(() => {});
}

// ── 候选人状态变更通知（通知 HR 负责人）
export async function notifyCandidateStatusChanged(db: any, candidate: any, requisitionTitle: string, responsiblePersonId: string) {
  const openId = await getPersonFeishuOpenId(db, responsiblePersonId);
  if (!openId) return;
  const card = FeishuCardBuilder.candidateCard(candidate, requisitionTitle);
  await sendFeishuMessage(openId, "open_id", card).catch(() => {});
}

// ── IT 工单通知
export async function notifyTicketAssigned(db: any, ticket: any, assigneePersonId: string) {
  const openId = await getPersonFeishuOpenId(db, assigneePersonId);
  if (!openId) return;
  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: ticket.priority === "critical" ? "red" : ticket.priority === "high" ? "orange" : "blue",
      title: { tag: "plain_text", content: `🔧 IT 工单 - ${ticket.title}` }
    },
    body: {
      elements: [
        { tag: "column_set", flex_mode: "bisect", columns: [
          { tag: "column", elements: [{ tag: "markdown", content: `**优先级**\n${ticket.priority}` }] },
          { tag: "column", elements: [{ tag: "markdown", content: `**分类**\n${ticket.category ?? "-"}` }] }
        ]},
        ...(ticket.description ? [{ tag: "markdown", content: `**描述**\n${ticket.description}` }] : []),
        { tag: "divider" },
        { tag: "action", actions: [
          { tag: "button", text: { tag: "plain_text", content: "查看工单" }, type: "primary",
            url: `${APP_URL}/#it` }
        ]}
      ]
    }
  };
  await sendFeishuMessage(openId, "open_id", card).catch(() => {});
}

// ── OKR 周期提醒
export async function notifyCheckinReminder(db: any, keyResult: any, ownerPersonId: string) {
  const openId = await getPersonFeishuOpenId(db, ownerPersonId);
  if (!openId) return;
  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: { template: "purple", title: { tag: "plain_text", content: "📊 OKR 进度打卡提醒" } },
    body: {
      elements: [
        { tag: "markdown", content: `**关键结果** ${keyResult.title}` },
        { tag: "markdown", content: `当前进度 **${keyResult.progress ?? 0}%** · 目标值 ${keyResult.target_value ?? "-"} ${keyResult.unit ?? ""}` },
        { tag: "divider" },
        { tag: "action", actions: [
          { tag: "button", text: { tag: "plain_text", content: "提交进度" }, type: "primary",
            url: `${APP_URL}/#strategy` }
        ]}
      ]
    }
  };
  await sendFeishuMessage(openId, "open_id", card).catch(() => {});
}

// ── 项目风险告警
export async function notifyProjectRisk(db: any, risk: any, projectName: string, ownerPersonId: string) {
  const openId = await getPersonFeishuOpenId(db, ownerPersonId);
  if (!openId) return;
  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: { template: "red", title: { tag: "plain_text", content: "⚠️ 项目风险提醒" } },
    body: {
      elements: [
        { tag: "markdown", content: `**${projectName}**` },
        { tag: "markdown", content: `**风险** ${risk.title}\n概率：${risk.probability} · 影响：${risk.impact}` },
        ...(risk.mitigation_plan ? [{ tag: "markdown", content: `**缓解措施** ${risk.mitigation_plan}` }] : []),
        { tag: "divider" },
        { tag: "action", actions: [
          { tag: "button", text: { tag: "plain_text", content: "查看项目" }, type: "primary",
            url: `${APP_URL}/#projects` }
        ]}
      ]
    }
  };
  await sendFeishuMessage(openId, "open_id", card).catch(() => {});
}

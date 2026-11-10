/**
 * Settings Registry - 设置注册表
 * 定义每个设置的元数据：类型、默认值、取值范围、单位、消费者、是否需审批、生效策略
 */
export type SettingType = "integer" | "number" | "boolean" | "string" | "array";

export interface SettingDefinition {
  namespace: string;
  key: string;
  type: SettingType;
  defaultValue: unknown;
  min?: number;
  max?: number;
  unit?: string;
  description: string;
  consumer: string;               // 如 "finance.expense.approval"
  requiresApproval?: boolean;     // 修改是否需审批
  effective: "immediate" | "scheduled"; // 生效方式
}

// 当前已知的设置定义（按 UI 实际保存的键）
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // 财务
  {
    namespace: "finance",
    key: "approval_threshold_cents",
    type: "integer",
    defaultValue: 500000,
    min: 0,
    unit: "cents",
    description: "报销单审批阈值（分），超过此金额需要额外审批",
    consumer: "finance.expense.approval",
    effective: "immediate",
  },
  {
    namespace: "finance",
    key: "expense_deadline_day",
    type: "integer",
    defaultValue: 25,
    min: 1,
    max: 28,
    unit: "day",
    description: "报销提交截止日（每月几号）",
    consumer: "finance.expense.submission",
    effective: "immediate",
  },
  {
    namespace: "finance",
    key: "invoice_expiry_warn_days",
    type: "integer",
    defaultValue: 7,
    min: 1,
    unit: "days",
    description: "发票到期提醒提前天数",
    consumer: "finance.invoice.expiry",
    effective: "immediate",
  },
  // CRM
  {
    namespace: "crm",
    key: "default_win_probability",
    type: "integer",
    defaultValue: 60,
    min: 0,
    max: 100,
    unit: "percent",
    description: "赢单概率默认值（%）",
    consumer: "crm.opportunity.defaults",
    effective: "immediate",
  },
  {
    namespace: "crm",
    key: "stale_opportunity_days",
    type: "integer",
    defaultValue: 30,
    min: 1,
    unit: "days",
    description: "商机提醒天数（超期未更新）",
    consumer: "crm.opportunity.stale",
    effective: "immediate",
  },
  {
    namespace: "crm",
    key: "pipeline_stages",
    type: "array",
    defaultValue: ["qualification", "proposal", "negotiation", "contract"],
    description: "销售漏斗阶段",
    consumer: "crm.pipeline",
    effective: "immediate",
  },
  // IT
  {
    namespace: "it",
    key: "helpdesk_email",
    type: "string",
    defaultValue: "",
    description: "IT 帮助台邮箱",
    consumer: "it.helpdesk",
    effective: "immediate",
  },
  {
    namespace: "it",
    key: "sla_high_hours",
    type: "integer",
    defaultValue: 4,
    min: 1,
    unit: "hours",
    description: "高优先级工单 SLA 响应时限（小时）",
    consumer: "it.ticket.sla",
    effective: "immediate",
  },
  {
    namespace: "it",
    key: "sla_medium_hours",
    type: "integer",
    defaultValue: 24,
    min: 1,
    unit: "hours",
    description: "中优先级工单 SLA 响应时限（小时）",
    consumer: "it.ticket.sla",
    effective: "immediate",
  },
  {
    namespace: "it",
    key: "license_expiry_warn_days",
    type: "integer",
    defaultValue: 30,
    min: 1,
    unit: "days",
    description: "许可证到期提醒提前天数",
    consumer: "it.license.expiry",
    effective: "immediate",
  },
];

export function getSettingDefinition(namespace: string, key: string): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find(d => d.namespace === namespace && d.key === key);
}

export function listSettingDefinitions(namespace: string): readonly SettingDefinition[] {
  return SETTING_DEFINITIONS.filter(d => d.namespace === namespace);
}

export function validateSettingValue(def: SettingDefinition, value: unknown): string | null {
  switch (def.type) {
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "must_be_integer";
      if (def.min !== undefined && value < def.min) return `below_min_${def.min}`;
      if (def.max !== undefined && value > def.max) return `above_max_${def.max}`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must_be_number";
      if (def.min !== undefined && value < def.min) return `below_min_${def.min}`;
      if (def.max !== undefined && value > def.max) return `above_max_${def.max}`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return "must_be_boolean";
      break;
    case "string":
      if (typeof value !== "string") return "must_be_string";
      break;
    case "array":
      if (!Array.isArray(value)) return "must_be_array";
      break;
  }
  return null;
}

export function normalizeSettingValue(def: SettingDefinition, raw: unknown): unknown {
  const err = validateSettingValue(def, raw);
  if (err) throw new Error(`invalid_setting_value:${def.namespace}.${def.key}:${err}`);
  return raw;
}

export function resolveSettingValue(def: SettingDefinition, storedRaw: unknown): unknown {
  if (storedRaw === undefined || storedRaw === null) return def.defaultValue;
  const err = validateSettingValue(def, storedRaw);
  if (err) return def.defaultValue; // 回退默认值
  return storedRaw;
}

export function getSettingsSchema(namespace: string): Record<string, Omit<SettingDefinition, "namespace">> {
  const schema: Record<string, Omit<SettingDefinition, "namespace">> = {};
  for (const def of listSettingDefinitions(namespace)) {
    const { namespace: _ns, ...rest } = def;
    schema[def.key] = rest;
  }
  return schema;
}

// 结构化 db 类型，避免引入 db.ts 造成循环依赖。
export interface SettingQueryClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * 统一的设置读取入口：查询 platform.tenant_settings 并按注册表定义解析，
 * 存储缺失/非法时回退默认值。所有模块消费者都应经由此函数读取，
 * 以保证「每项设置都有真实消费者」。
 */
export async function readSetting(
  db: SettingQueryClient,
  namespace: string,
  key: string
): Promise<unknown> {
  const def = getSettingDefinition(namespace, key);
  if (!def) return undefined;
  const { rows } = await db.query(
    `SELECT value FROM platform.tenant_settings
     WHERE tenant_id = platform.current_tenant_id() AND namespace = $1 AND key = $2`,
    [namespace, key]
  );
  return resolveSettingValue(def, rows[0]?.value);
}

/** 读取某命名空间下全部已定义设置（解析后，含默认回退）。 */
export async function readSettings(
  db: SettingQueryClient,
  namespace: string
): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `SELECT key, value FROM platform.tenant_settings
     WHERE tenant_id = platform.current_tenant_id() AND namespace = $1`,
    [namespace]
  );
  const stored: Record<string, unknown> = {};
  for (const r of rows) stored[String(r.key)] = r.value;
  const out: Record<string, unknown> = {};
  for (const def of listSettingDefinitions(namespace)) {
    out[def.key] = resolveSettingValue(def, stored[def.key]);
  }
  return out;
}
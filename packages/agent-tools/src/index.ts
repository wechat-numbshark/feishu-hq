export type AgentRiskLevel = "L0" | "L1" | "L2" | "L3";

export interface AgentToolDefinition {
  name: string;
  description: string;
  action: string;
  riskLevel: AgentRiskLevel;
  inputSchema: Record<string, unknown>;
  requiredDataDomains: string[];
}

export interface AgentExecutionContext {
  tenantId: string;
  subjectId: string;
  delegatedBySubjectId: string;
  conversationId: string;
  traceId: string;
  approvalInstanceId?: string;
}

export function requiresConfirmation(level: AgentRiskLevel): boolean {
  return level === "L2" || level === "L3";
}

export function requiresApproval(level: AgentRiskLevel): boolean {
  return level === "L3";
}


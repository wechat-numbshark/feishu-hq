export interface ToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

export function appendAssistantToolCallRound(messages: ChatMessage[], content: string, calls: ToolCall[]): void {
  messages.push({
    role: "assistant", content,
    ...(calls.length ? { tool_calls: calls.map(call => ({ ...call, type: "function" as const })) } : {}),
  });
}

// Validate each contiguous assistant/tool round before sending it to a model.
export function findToolProtocolIssues(messages: ChatMessage[]): string[] {
  const issues: string[] = [];
  const pending = new Map<string, string>();
  const flush = () => {
    for (const [id, name] of pending) issues.push(`Missing tool result: ${name} (${id})`);
    pending.clear();
  };
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) {
        issues.push(`Unexpected tool result: ${message.tool_call_id ?? "missing ID"}`);
      }
    } else {
      flush();
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) {
          if (pending.has(call.id)) issues.push(`Duplicate tool call: ${call.id}`);
          pending.set(call.id, call.function.name);
        }
      }
    }
  }
  flush();
  return issues;
}

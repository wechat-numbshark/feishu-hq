import test from "node:test";
import assert from "node:assert/strict";
import { appendAssistantToolCallRound, findToolProtocolIssues, type ChatMessage } from "../src/ai-protocol.ts";

test("assistant 工具调用轮次与 tool 结果一一对应时协议合规", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "看看项目" },
  ];
  appendAssistantToolCallRound(messages, "", [
    { id: "call_1", function: { name: "query_projects", arguments: "{}" } },
    { id: "call_2", function: { name: "query_crm", arguments: "{\"limit\":5}" } },
  ]);
  messages.push(
    { role: "tool", content: "[]", tool_call_id: "call_1", name: "query_projects" },
    { role: "tool", content: "[]", tool_call_id: "call_2", name: "query_crm" },
  );
  assert.deepEqual(findToolProtocolIssues(messages), []);
});

test("没有 tool_calls 的 assistant 消息后面跟 tool 消息会被判定违规", () => {
  const messages: ChatMessage[] = [
    { role: "assistant", content: "" },
    { role: "tool", content: "[]", tool_call_id: "call_1", name: "query_projects" },
  ];
  const issues = findToolProtocolIssues(messages);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /call_1/);
});

test("assistant 请求了工具但没有 tool 结果会被判定违规", () => {
  const issues = findToolProtocolIssues([
    { role: "assistant", content: "", tool_calls: [
      { id: "call_9", type: "function", function: { name: "query_hr", arguments: "{}" } },
    ] },
  ]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /query_hr/);
});

test("纯文本 assistant 回复不携带 tool_calls 字段", () => {
  const messages: ChatMessage[] = [];
  appendAssistantToolCallRound(messages, "好的", []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].content, "好的");
  assert.equal("tool_calls" in messages[0], false);
});

test("带工具调用的 assistant 消息保留原始调用参数与顺序", () => {
  const messages: ChatMessage[] = [];
  const calls = [
    { id: "b", function: { name: "query_crm", arguments: "{\"limit\":3}" } },
    { id: "a", function: { name: "query_projects", arguments: "{}" } },
  ];
  appendAssistantToolCallRound(messages, "查一下", calls);
  assert.deepEqual(messages[0].tool_calls?.map(c => c.id), ["b", "a"]);
  assert.equal(messages[0].tool_calls?.[0].function.arguments, "{\"limit\":3}");
});

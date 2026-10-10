export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface CompatibleMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  /** Replay output items verbatim, including encrypted reasoning and call IDs. */
  response_items?: Record<string, unknown>[];
}

export function responsesInput(messages: CompatibleMessage[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (message.response_items) return message.response_items;
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
    const items: Record<string, unknown>[] = message.content ? [{ role: message.role, content: message.content }] : [];
    for (const call of message.tool_calls ?? []) {
      items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    return items;
  });
}

export function parseResponsesMessage(body: {
  status?: string; error?: unknown; output?: Record<string, unknown>[];
}): CompatibleMessage {
  if (body.error || (body.status && body.status !== "completed") || !Array.isArray(body.output)) {
    throw new Error("Responses API did not complete the request. Check the model and provider limits.");
  }
  const calls: ToolCall[] = [];
  const text: string[] = [];
  for (const item of body.output) {
    if (!item || typeof item !== "object") throw new Error("Invalid Responses API output.");
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || typeof item.arguments !== "string") throw new Error("Invalid Responses API function call.");
      calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === "message") {
      if (!Array.isArray(item.content)) throw new Error("Invalid Responses API message.");
      for (const block of item.content) {
        if (block.type === "refusal") throw new Error("The provider declined this build.");
        if (block.type === "output_text" && typeof block.text === "string") text.push(block.text);
      }
    }
  }
  return { role: "assistant", content: text.join(""), tool_calls: calls, response_items: body.output };
}

/** Surface only known error categories/parameter names, never raw provider prose. */
export async function apiFailure(response: Response, protocol: string): Promise<Error> {
  let hint = "Check the model, API protocol, key and provider limits.";
  try {
    const body = await response.json();
    const error = body?.error;
    if (typeof error?.message === "string" && /responses/i.test(error.message) && /tool|support|require/i.test(error.message)) {
      hint = "This model requires Responses for tool calling. Select Responses in Settings.";
    } else if (["tools", "tool_choice", "messages", "input", "store", "include"].includes(error?.param)) {
      hint = `The provider rejected the ${error.param} parameter. Check the API protocol and model capabilities.`;
    }
  } catch { /* gateways may return HTML or plain text */ }
  return new Error(`OpenAI-compatible API returned HTTP ${response.status} via ${protocol}. ${hint}`);
}

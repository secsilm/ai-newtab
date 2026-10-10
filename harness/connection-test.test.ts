import { expect, test } from "bun:test";
import { testOpenAIConnection } from "@homepage/agent-core";

const input = { baseUrl: "https://gateway.example/v1/chat/completions/", apiKey: "test-key" };
function transport(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url, init) => handler(String(url), init!)) as typeof fetch;
}

test("tests connection without a model and retrieves all paginated model IDs", async () => {
  const urls: string[] = [];
  const result = await testOpenAIConnection(input, transport((url, init) => {
    urls.push(url);
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(init.redirect).toBe("error");
    expect(init.body).toBeUndefined();
    return Response.json(urls.length === 1
      ? { data: [{ id: "z/model" }, { id: "a/model" }], has_more: true, last_id: "a/model" }
      : { data: [{ id: "a/model" }, { id: "b/model" }], has_more: false });
  }));
  expect(result.ok).toBe(true);
  expect(result.models).toEqual(["a/model", "b/model", "z/model"]);
  expect(urls).toEqual(["https://gateway.example/v1/models", "https://gateway.example/v1/models?after=a%2Fmodel"]);
});

test("authentication failures never appear as success or leak a provider response", async () => {
  const result = await testOpenAIConnection(input, transport(() => new Response("secret echo", { status: 401 })));
  expect(result.ok).toBe(false);
  expect(result.message).toContain("HTTP 401");
  expect(result.message).not.toContain("secret echo");
});

test("providers without model listing can test a manually entered model", async () => {
  let calls = 0;
  const result = await testOpenAIConnection({ ...input, model: "custom/model" }, transport((url, init) => {
    if (++calls === 1) return new Response("", { status: 404 });
    expect(url).toBe("https://gateway.example/v1/chat/completions");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("custom/model");
    expect(body.tools[0].function.name).toBe("connectionCheck");
    expect(body.messages).toHaveLength(1);
    return Response.json({ choices: [{ message: { tool_calls: [{ id: "check", function: { name: "connectionCheck", arguments: "{}" } }] } }] });
  }));
  expect(result.ok).toBe(true);
  expect(result.models).toEqual([]);
  expect(result.message).toContain("tool calling succeeded");
});

test("missing model list without a manual model does not fake a successful test", async () => {
  const result = await testOpenAIConnection(input, transport(() => new Response("", { status: 405 })));
  expect(result.ok).toBe(false);
  expect(result.message).toContain("Enter a model ID manually");
});

test("empty lists keep manual entry available", async () => {
  const result = await testOpenAIConnection(input, transport(() => Response.json({ data: [] })));
  expect(result.ok).toBe(true);
  expect(result.models).toEqual([]);
  expect(result.message).toContain("empty");
});

test("malformed, incomplete or looping lists are not shown as complete", async () => {
  for (const body of [
    {}, { data: [{ name: "bad-model" }] }, { error: "failed", data: [] },
    { data: [], has_more: true }, { data: [{ id: "same" }], has_more: true },
  ]) {
    const result = await testOpenAIConnection(input, transport(() => Response.json(body)));
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
  }
});

test("model request errors, network failures and timeouts are safe to display", async () => {
  let calls = 0;
  const failed = await testOpenAIConnection({ ...input, model: "unknown" }, transport(() =>
    ++calls === 1 ? new Response("", { status: 501 }) : new Response("secret", { status: 403 })));
  expect(failed.ok).toBe(false);
  expect(failed.message).toContain("HTTP 403");
  const network = await testOpenAIConnection(input, transport(() => { throw new Error("secret network exception"); }));
  expect(network.ok).toBe(false);
  expect(network.message).not.toContain("secret");
});

test("invalid URL/key never sends requests", async () => {
  for (const settings of [{ ...input, baseUrl: "relative" }, { ...input, apiKey: " " }]) {
    let called = false;
    expect((await testOpenAIConnection(settings, transport(() => {
      called = true;
      return Response.json({ data: [] });
    }))).ok).toBe(false);
    expect(called).toBe(false);
  }
});

test("selected GPT-6 model tests Responses tool calling and retains the full list", async () => {
  let calls = 0;
  const result = await testOpenAIConnection({ ...input, model: "gpt-6.1-sol" }, transport((url, init) => {
    if (++calls === 1) return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
    expect(url).toBe("https://gateway.example/v1/responses");
    const body = JSON.parse(String(init.body));
    expect(body.store).toBe(false);
    expect(body.tools[0].name).toBe("connectionCheck");
    return Response.json({ status: "completed", output: [{ type: "function_call", call_id: "call_check", name: "connectionCheck", arguments: "{}" }] });
  }));
  expect(result.ok).toBe(true);
  expect(result.models).toEqual(["gpt-6.1-sol"]);
  expect(result.message).toContain("Responses tool calling succeeded");
});

test("a working model list does not mask generation/tool incompatibility", async () => {
  let calls = 0;
  const result = await testOpenAIConnection({ ...input, model: "custom/model" }, transport(() =>
    ++calls === 1 ? Response.json({ data: [{ id: "custom/model" }] }) : Response.json({ choices: [{ message: { content: "OK" } }] })));
  expect(result.ok).toBe(false);
  expect(result.models).toEqual(["custom/model"]);
  expect(result.message).toContain("no test tool call");
});

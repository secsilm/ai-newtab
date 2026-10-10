import { describe, expect, test } from "bun:test";
import {
  DEFAULT_API_SETTINGS, DEFAULT_MODEL, OPENAI_CHECKPOINT_KEY, OUTPUT_PATH, STORAGE_KEYS,
  getApiConfiguration, hasApiConfiguration, normalizeOpenAIBaseUrl, runOpenAIHomepageBuild,
  type BrowserBridge, type KVStore, type OpenAIRunOptions,
} from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";
import { transform } from "sucrase";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const CODE = `import React from 'react';
export default function PersonalizedHomepage() {
  return <main><a href="https://example.com/story">A real headline</a></main>;
}`;
const PAGE = '<a href="https://example.com/story">A real headline</a>';
const bridge: BrowserBridge = {
  async getHistory() { return { sites: fixtureHistory(), totalSitesSeen: 12 }; },
  async getPageHtml({ urls }) {
    return { pages: [{ url: urls[0], title: "Example", html: PAGE }], failed: [{ url: "https://offline.example", reason: "timeout" }] };
  },
};
class MemoryStore implements KVStore {
  data = new Map<string, unknown>();
  checkpoints: any[] = [];
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
    if (key === OPENAI_CHECKPOINT_KEY) this.checkpoints.push(structuredClone(value));
  }
  async remove(key: string) { this.data.delete(key); }
}
function call(id: string, name: string, args: unknown) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function reply(content: string | null, calls?: unknown[], extra: object = {}) {
  return Response.json({ choices: [{ finish_reason: calls?.length ? "tool_calls" : "stop", message: { role: "assistant", content, tool_calls: calls, ...extra } }] });
}
function options(fetcher: (body: any, init: RequestInit, url: string) => Response | Promise<Response>, store = new MemoryStore()): OpenAIRunOptions {
  return {
    apiKey: "provider-key-without-sk-prefix", baseUrl: "https://gateway.example/custom/v1/", model: "vendor/model",
    bridge, store,
    fetch: (async (url, init) => fetcher(JSON.parse(String(init!.body)), init!, String(url))) as typeof fetch,
  };
}

describe("API configuration", () => {
  test("keeps legacy Anthropic settings and defaults", () => {
    expect(getApiConfiguration({ ...DEFAULT_API_SETTINGS, apiKey: "legacy-key" })).toEqual({ provider: "anthropic", apiKey: "legacy-key", model: DEFAULT_MODEL });
    expect(hasApiConfiguration(DEFAULT_API_SETTINGS)).toBe(false);
  });
  test("accepts arbitrary compatible keys and custom model IDs", () => {
    expect(getApiConfiguration({ ...DEFAULT_API_SETTINGS, provider: "openai-compatible", openaiApiKey: " key ", openaiBaseUrl: "http://localhost:1234/v1/chat/completions/", openaiModel: " model/custom " })).toEqual({ provider: "openai-compatible", apiKey: "key", baseUrl: "http://localhost:1234/v1", model: "model/custom" });
    expect(hasApiConfiguration({ ...DEFAULT_API_SETTINGS, provider: "openai-compatible", apiKey: "anthropic-only" })).toBe(false);
  });
  test("normalizes endpoints without inventing a version path", () => {
    expect(normalizeOpenAIBaseUrl("https://gateway.example/api/v2/")).toBe("https://gateway.example/api/v2");
    expect(normalizeOpenAIBaseUrl("https://gateway.example")).toBe("https://gateway.example");
    for (const url of ["relative/v1", "ftp://example.com/v1", "https://key@example.com/v1", "https://example.com/v1?key=x", "https://example.com/v1#x"]) {
      expect(() => normalizeOpenAIBaseUrl(url)).toThrow();
    }
  });
});

describe("OpenAI-compatible build", () => {
  test("runs history, scrape, local analysis and write; the result renders", async () => {
    const store = new MemoryStore();
    let step = 0;
    const result = await runOpenAIHomepageBuild(options((body, init, url) => {
      expect(url).toBe("https://gateway.example/custom/v1/chat/completions");
      expect((init.headers as any).Authorization).toBe("Bearer provider-key-without-sk-prefix");
      expect(init.redirect).toBe("error");
      expect(body.model).toBe("vendor/model");
      expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream", "tools"]);
      if (step++ === 0) return reply("Reading history", [call("history", "getHistory", {})], { reasoning_content: "provider-specific reasoning" });
      const toolResult = JSON.parse(body.messages.at(-1).content);
      if (step === 2) {
        expect(toolResult.totalSitesSeen).toBe(12);
        expect(body.messages.find((m: any) => m.role === "assistant").reasoning_content).toBe("provider-specific reasoning");
        return reply(null, [call("scrape", "getPageHtml", { urls: ["https://example.com"] })]);
      }
      if (step === 3) {
        expect(toolResult.failed[0].reason).toBe("timeout");
        return reply(null, [
          call("read", "read", { path: toolResult.pages[0].mountPath, limit: 20 }),
          call("grep", "grep", { pattern: "headline" }),
          call("glob", "glob", { pattern: "/mnt/session/uploads/pages/*.html" }),
        ]);
      }
      expect(body.messages.filter((m: any) => m.role === "tool").slice(-3).map((m: any) => m.tool_call_id)).toEqual(["read", "grep", "glob"]);
      expect(toolResult.paths).toHaveLength(1);
      expect(JSON.parse(body.messages.at(-3).content).nextOffset).toBe(20);
      expect(JSON.parse(body.messages.at(-2).content).matches[0].snippet).toContain("A real headline");
      return reply(null, [call("write", "write", { path: OUTPUT_PATH, content: CODE })]);
    }, store));
    expect(result.source).toBe("local-output");
    expect(result.code).toBe(CODE);
    expect(step).toBe(4);
    expect(store.data.size).toBe(0);
    const compiled = transform(result.code, { transforms: ["typescript", "jsx", "imports"] }).code;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name !== "react") throw new Error("Unexpected import");
      return React;
    }, module, module.exports);
    expect(renderToStaticMarkup(React.createElement(module.exports.default))).toContain("A real headline");
  });

  test("resumes unanswered tools with saved pages and no duplicate history query", async () => {
    const store = new MemoryStore();
    let count = 0;
    await runOpenAIHomepageBuild(options(() => count++ === 0
      ? reply(null, [call("a", "getHistory", {}), call("b", "getPageHtml", { urls: ["https://example.com"] })])
      : reply(null, [call("write", "write", { path: OUTPUT_PATH, content: CODE })]), store));
    const checkpoint = store.checkpoints.find((c) => c.messages.at(-1).tool_call_id === "a");
    const resumedStore = new MemoryStore();
    await resumedStore.set(OPENAI_CHECKPOINT_KEY, checkpoint);
    await resumedStore.set(STORAGE_KEYS.activeSessionId, checkpoint.sessionId);
    let historyCalls = 0;
    let scrapeCalls = 0;
    const opts = options((body) => {
      expect(body.messages.filter((m: any) => m.tool_call_id === "a")).toHaveLength(1);
      const pages = JSON.parse(body.messages.at(-1).content).pages;
      expect(pages).toHaveLength(1);
      return reply(null, [call("write", "write", { path: OUTPUT_PATH, content: CODE })]);
    }, resumedStore);
    opts.resumeSessionId = checkpoint.sessionId;
    opts.bridge = {
      async getHistory(args) { historyCalls++; return bridge.getHistory(args); },
      async getPageHtml(args) { scrapeCalls++; return bridge.getPageHtml(args); },
    };
    expect((await runOpenAIHomepageBuild(opts)).code).toBe(CODE);
    expect(historyCalls).toBe(0);
    expect(scrapeCalls).toBe(1);
    expect(resumedStore.data.size).toBe(0);
  });

  test("tool errors become correlated results, with no filesystem or shell access", async () => {
    let step = 0;
    const result = await runOpenAIHomepageBuild(options((body) => {
      if (step++ === 0) return reply(null, [
        call("unknown", "bash", { command: "anything" }),
        call("read", "read", { path: "/etc/passwd" }),
        call("proto", "read", { path: "__proto__" }),
        call("write", "write", { path: "/etc/passwd", content: CODE }),
        call("history", "getHistory", { daysToAnalyze: 999 }),
        call("url", "getPageHtml", { urls: ["file:///etc/passwd"] }),
        { id: "json", type: "function", function: { name: "getHistory", arguments: "not-json" } },
      ]);
      const results = body.messages.filter((m: any) => m.role === "tool");
      expect(results).toHaveLength(7);
      expect(results.every((m: any) => JSON.parse(m.content).error)).toBe(true);
      return reply(null, [call("ok", "write", { path: OUTPUT_PATH, content: CODE })]);
    }));
    expect(result.code).toBe(CODE);
  });

  test("handles inline deliverables from providers", async () => {
    const result = await runOpenAIHomepageBuild(options(() => reply("```tsx\n" + CODE + "\n```")));
    expect(result.source).toBe("message-fence");
    expect(result.code).toBe(CODE);
  });

  test("cleans local sensitive state on API errors without exposing response bodies", async () => {
    const store = new MemoryStore();
    await expect(runOpenAIHomepageBuild(options(() => new Response("secret-api-key", { status: 401 }), store))).rejects.toThrow("HTTP 401");
    expect(store.data.size).toBe(0);
  });

  test("cancellation aborts the transport and removes the checkpoint", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    const opts = options((_body, init) => {
      controller.abort();
      init.signal!.throwIfAborted();
      return reply(null);
    }, store);
    opts.signal = controller.signal;
    await expect(runOpenAIHomepageBuild(opts)).rejects.toThrow();
    expect(store.data.size).toBe(0);
  });

  test("rejects malformed, truncated and non-deliverable completions", async () => {
    for (const response of [
      Response.json({ error: { message: "secret" } }),
      Response.json({ choices: [] }),
      Response.json({ choices: [{ finish_reason: "length", message: { content: "```tsx\n" + CODE + "\n```" } }] }),
      reply("I cannot write code"),
      reply(null, [call("duplicate", "getHistory", {}), call("duplicate", "getHistory", {})]),
    ]) {
      const store = new MemoryStore();
      await expect(runOpenAIHomepageBuild(options(() => response, store))).rejects.toThrow();
      expect(store.data.size).toBe(0);
    }
  });

  test("limits looping providers", async () => {
    const store = new MemoryStore();
    let requests = 0;
    await expect(runOpenAIHomepageBuild(options(() => reply(null, [call(String(++requests), "glob", {})]), store))).rejects.toThrow("40 model turns");
    expect(requests).toBe(40);
    expect(store.data.size).toBe(0);
  });
});

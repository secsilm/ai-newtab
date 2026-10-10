import { normalizeOpenAIBaseUrl, resolveOpenAIApiFormat, type OpenAIApiFormat } from "./api-config";
import { apiFailure, parseResponsesMessage, responsesInput, type CompatibleMessage as Message } from "./openai-protocol";
import { buildHistoryDigest, slugifyUrl } from "./history-digest";
import { HOMEPAGE_SYSTEM_PROMPT, OUTPUT_PATH, buildKickoffMessage } from "./prompt";
import { DEFAULTS, GET_HISTORY_SCHEMA, GET_PAGE_HTML_SCHEMA, type ToolInputSchema } from "./schemas";
import { STORAGE_KEYS } from "./setup";
import type { BrowserBridge, HomepageBuildResult, KVStore, RunCallbacks } from "./types";

export const OPENAI_CHECKPOINT_KEY = "openaiBuildCheckpoint";
const MAX_TURNS = 40;
const MAX_CONTEXT_CHARS = 2_000_000;
const MAX_FILE_CHARS = 2_000_000;
const MAX_TOOL_CHARS = 16_000;
const CODE_FENCE = /```(?:tsx|jsx|ts|js|typescript|javascript)?\s*\n([\s\S]*?)```/;

interface Checkpoint {
  sessionId: string;
  baseUrl: string;
  model: string;
  apiFormat?: Exclude<OpenAIApiFormat, "auto">;
  messages: Message[];
  files: Record<string, string>;
  turns: number;
  scrapedUrls: string[];
}

function tool(name: string, description: string, parameters: ToolInputSchema) {
  return { type: "function", function: { name, description, parameters } };
}
function schema(properties: Record<string, unknown>, required: string[]): ToolInputSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
const string = { type: "string" };
const TOOLS = [
  tool("getHistory", "Get a ranked digest of browsing history. Call once, first.", GET_HISTORY_SCHEMA),
  tool("getPageHtml", "Load up to 8 pages in the user's browser; return local mountPaths for read/grep.", GET_PAGE_HTML_SCHEMA),
  tool("read", "Read a mounted file, paginated by character offset. Use the returned nextOffset for more.", schema({
    path: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: MAX_TOOL_CHARS },
  }, ["path"])),
  tool("grep", "Search for a literal, case-insensitive string in mounted HTML. Returns matching snippets, capped at 16000 characters.", schema({
    pattern: string, path: string,
  }, ["pattern"])),
  tool("glob", "List mounted file paths matching a wildcard pattern (* and ?).", schema({ pattern: string }, [])),
  tool("write", `Write the complete React component to ${OUTPUT_PATH}. Only this output path is writable.`, schema({
    path: string, content: string,
  }, ["path", "content"])),
];

export interface OpenAIRunOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiFormat?: OpenAIApiFormat;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  resumeSessionId?: string;
  now?: Date;
  /** Injected transport for offline tests; production uses native fetch. */
  fetch?: typeof fetch;
}

/** Compatible APIs + host-side tools; no cloud filesystem or code execution. */
export async function runOpenAIHomepageBuild(opts: OpenAIRunOptions): Promise<HomepageBuildResult> {
  const baseUrl = normalizeOpenAIBaseUrl(opts.baseUrl);
  const apiFormat = resolveOpenAIApiFormat(opts.model, opts.apiFormat);
  if (!opts.apiKey.trim() || !opts.model.trim()) throw new Error("API key and model ID are required.");
  const { callbacks, signal, store } = opts;
  callbacks?.onPhase?.("setup");
  let state: Checkpoint;
  if (opts.resumeSessionId) {
    const cached = await store.get<Checkpoint>(OPENAI_CHECKPOINT_KEY);
    if (!cached || cached.sessionId !== opts.resumeSessionId) {
      throw new Error("Interrupted compatible build has no checkpoint. Start a new build.");
    }
    if (cached.baseUrl !== baseUrl || cached.model !== opts.model || (cached.apiFormat && cached.apiFormat !== apiFormat)) {
      throw new Error("Resume with the same Base URL, model and API protocol used by the interrupted build.");
    }
    state = cached;
  } else {
    callbacks?.onPhase?.("session-create");
    state = {
      sessionId: `openai-${crypto.randomUUID()}`, baseUrl, model: opts.model, apiFormat,
      messages: [
        { role: "system", content: HOMEPAGE_SYSTEM_PROMPT + "\n\nYour files are stored locally by the host. Use only the provided tools; no shell is available. The read tool uses character offsets, and grep searches literal strings." },
        { role: "user", content: buildKickoffMessage({ now: opts.now ?? new Date(), userSystemPrompt: opts.userSystemPrompt }) },
      ],
      files: Object.create(null), turns: 0, scrapedUrls: [],
    };
  }
  const persist = () => store.set(OPENAI_CHECKPOINT_KEY, state);
  const checkAbort = () => signal?.throwIfAborted();

  try {
    await persist();
    await store.set(STORAGE_KEYS.activeSessionId, state.sessionId);
    callbacks?.onLog?.(`provider=openai-compatible protocol=${apiFormat} model=${state.model}`);
    while (true) {
      checkAbort();
      // A saved assistant tool-call message may have only some results. Finish
      // unanswered calls before asking the model again (including after a kill).
      const assistant = [...state.messages].reverse().find((m) => m.role === "assistant");
      if (assistant?.tool_calls?.length) {
        const answered = new Set(state.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
        for (const call of assistant.tool_calls) {
          if (answered.has(call.id)) continue;
          checkAbort();
          callbacks?.onLog?.(`tool:${call.function.name}`);
          let result: unknown;
          try {
            const args: unknown = JSON.parse(call.function.arguments);
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
            result = await dispatch(call.function.name, args as Record<string, unknown>, state, opts);
          } catch (err) {
            checkAbort();
            result = { error: err instanceof Error ? err.message : String(err) };
          }
          checkAbort();
          state.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          await persist();
        }
      }

      const output = Object.hasOwn(state.files, OUTPUT_PATH) ? state.files[OUTPUT_PATH] : undefined;
      if (output?.trim()) {
        callbacks?.onPhase?.("done");
        return { code: stripFence(output), sessionId: state.sessionId, source: "local-output" };
      }
      if (assistant && !assistant.tool_calls?.length) {
        const fenced = assistant.content?.match(CODE_FENCE)?.[1];
        if (fenced?.includes("PersonalizedHomepage")) {
          callbacks?.onPhase?.("done");
          return { code: fenced.trim(), sessionId: state.sessionId, source: "message-fence" };
        }
        throw new Error("Model produced no homepage. Choose a model that supports function calling and try again.");
      }
      if (state.turns >= MAX_TURNS) throw new Error(`Build exceeded ${MAX_TURNS} model turns.`);
      if (JSON.stringify(state.messages).length > MAX_CONTEXT_CHARS) throw new Error("Build context exceeded the local size limit.");

      callbacks?.onPhase?.("thinking");
      // No vendor-specific sampling/token/reasoning parameters: compatible
      // providers differ in which of these they accept. JSON works without SSE.
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
        : AbortSignal.timeout(180_000);
      const payload = apiFormat === "responses"
        ? { model: state.model, input: responsesInput(state.messages), tools: TOOLS.map(({ function: fn }) => ({ type: "function", ...fn, strict: false })), stream: false, store: false }
        : { model: state.model, messages: state.messages, tools: TOOLS, stream: false };
      const response = await (opts.fetch ?? fetch)(`${baseUrl}/${apiFormat === "responses" ? "responses" : "chat/completions"}`, {
        method: "POST", redirect: "error", signal: requestSignal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey.trim()}` },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw await apiFailure(response, apiFormat);
      }
      const body = await response.json() as {
        choices?: Array<{ finish_reason?: string; message?: Message & { refusal?: string } }>;
        error?: unknown;
        status?: string;
        output?: Record<string, unknown>[];
      };
      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("Model output was truncated. Choose a model/provider with a larger output limit.");
      if (choice?.finish_reason === "content_filter" || choice?.message?.refusal) throw new Error("The provider declined this build.");
      const message = apiFormat === "responses" ? parseResponsesMessage(body) : choice?.message;
      if (body.error || !message || (message.content != null && typeof message.content !== "string")) {
        throw new Error("Invalid Chat Completions response from the provider.");
      }
      const calls = message.tool_calls;
      if (calls != null && (!Array.isArray(calls) || calls.length > 32 || calls.some((c) =>
        !c || c.type !== "function" || typeof c.id !== "string" || !c.id ||
        typeof c.function?.name !== "string" || typeof c.function?.arguments !== "string"))) {
        throw new Error("Invalid function calls in the provider response.");
      }
      if (calls && new Set(calls.map((c) => c.id)).size !== calls.length) throw new Error("Duplicate tool call IDs in provider response.");
      const saved: Message = { role: "assistant", content: message.content ?? null };
      if (calls?.length) saved.tool_calls = calls;
      if (typeof message.reasoning_content === "string") saved.reasoning_content = message.reasoning_content;
      if (message.response_items) saved.response_items = message.response_items;
      state.messages.push(saved);
      state.turns++;
      await persist();
      if (saved.content) callbacks?.onText?.(saved.content);
    }
  } finally {
    // This finally runs on success, failure and explicit cancel. A process kill
    // leaves the last checkpoint for the next worker to resume.
    callbacks?.onPhase?.("cleanup");
    await store.remove(OPENAI_CHECKPOINT_KEY);
    await store.remove(STORAGE_KEYS.activeSessionId);
  }
}

function stripFence(text: string) { return (text.match(CODE_FENCE)?.[1] ?? text).trim(); }
function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  return value;
}
function integer(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
function readFile(state: Checkpoint, path: string): string {
  if (!Object.hasOwn(state.files, path)) throw new Error("File not found. Use a returned mountPath or glob.");
  return state.files[path];
}

async function dispatch(name: string, args: Record<string, unknown>, state: Checkpoint, opts: OpenAIRunOptions): Promise<unknown> {
  const phase = opts.callbacks?.onPhase;
  switch (name) {
    case "getHistory": {
      const daysToAnalyze = integer(args, "daysToAnalyze", DEFAULTS.daysToAnalyze, 1, 90);
      const maxResults = integer(args, "maxResults", DEFAULTS.maxResults, 1, 50);
      phase?.("history", `${daysToAnalyze}d`);
      const { sites, totalSitesSeen } = await opts.bridge.getHistory({ daysToAnalyze, maxResults });
      return buildHistoryDigest(sites, { daysToAnalyze, maxResults, totalSitesSeen });
    }
    case "getPageHtml": {
      const urls = args.urls;
      if (!Array.isArray(urls) || !urls.length || urls.length > 8 || urls.some((u) => typeof u !== "string")) throw new Error("urls must contain 1 to 8 HTTP(S) URLs.");
      for (const url of urls) {
        if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("Only HTTP(S) pages can be scraped.");
      }
      const nextUrls = [...new Set([...state.scrapedUrls, ...urls])];
      if (nextUrls.length > 8) throw new Error("At most 8 distinct pages may be scraped per build.");
      const loadDelayMs = integer(args, "loadDelayMs", DEFAULTS.loadDelayMs, 0, 30_000);
      phase?.("scraping", `${urls.length} pages`);
      const result = await opts.bridge.getPageHtml({ urls, loadDelayMs });
      state.scrapedUrls = nextUrls;
      const failed = [...result.failed];
      const pages = [];
      for (const page of result.pages) {
        const fileSize = Object.values(state.files).reduce((n, text) => n + text.length, 0);
        if (fileSize + page.html.length > MAX_FILE_CHARS) {
          failed.push({ url: page.url, reason: "Page exceeds the local file size limit." });
          continue;
        }
        const mountPath = `/mnt/session/uploads/pages/${Object.keys(state.files).length}-${slugifyUrl(page.url)}.html`;
        state.files[mountPath] = page.html;
        pages.push({ url: page.url, title: page.title, mountPath, bytes: new TextEncoder().encode(page.html).length });
      }
      return { pages, failed };
    }
    case "read": {
      phase?.("analyzing", "read");
      const content = readFile(state, textArg(args, "path"));
      const offset = integer(args, "offset", 0, 0, content.length);
      const limit = integer(args, "limit", MAX_TOOL_CHARS, 1, MAX_TOOL_CHARS);
      return { content: content.slice(offset, offset + limit), nextOffset: offset + limit < content.length ? offset + limit : null };
    }
    case "grep": {
      phase?.("analyzing", "grep");
      const pattern = textArg(args, "pattern").toLowerCase();
      const paths = args.path === undefined ? Object.keys(state.files) : [textArg(args, "path")];
      const matches = [];
      let chars = 0;
      for (const path of paths) {
        const content = readFile(state, path);
        const lower = content.toLowerCase();
        let offset = lower.indexOf(pattern);
        while (offset !== -1) {
          const snippet = content.slice(Math.max(0, offset - 200), offset + pattern.length + 400);
          chars += snippet.length;
          if (chars > MAX_TOOL_CHARS) return { matches, truncated: true };
          matches.push({ path, offset, snippet });
          offset = lower.indexOf(pattern, offset + pattern.length);
        }
      }
      return { matches, truncated: false };
    }
    case "glob": {
      phase?.("analyzing", "glob");
      const pattern = args.pattern === undefined ? "*" : textArg(args, "pattern");
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      return { paths: Object.keys(state.files).filter((p) => new RegExp(`^${escaped}$`).test(p)) };
    }
    case "write": {
      phase?.("writing");
      if (textArg(args, "path") !== OUTPUT_PATH) throw new Error(`Only ${OUTPUT_PATH} is writable.`);
      const content = stripFence(textArg(args, "content"));
      if (content.length > 120_000 || !content.includes("PersonalizedHomepage") || !/export\s+default\b/.test(content)) throw new Error("Write a complete default-exported PersonalizedHomepage component (under 120000 characters).");
      state.files[OUTPUT_PATH] = content;
      return { path: OUTPUT_PATH, written: true };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

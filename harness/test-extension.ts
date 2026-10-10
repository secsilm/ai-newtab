/**
 * Loads the built extension into a real (headless) Chrome and verifies the half
 * of the system the Bun harness can't reach:
 *
 *   1. the MV3 service worker registers,
 *   2. the new-tab override renders (the API-key screen on a fresh profile),
 *   3. the worker answers `subscribe` on the build port with a snapshot,
 *   4. `startBuild` with no API key fails cleanly with an error message,
 *   5. `chrome.history` is readable, so the `history` permission is real.
 *
 * Only an isolated local mock API is called. Chrome 136+ ignores `--load-extension`, so the
 * extension is loaded over CDP's Extensions domain instead.
 *
 * Run: pnpm build && pnpm extension:test
 * Set CHROME_PATH if Chrome isn't at the default macOS location.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXT = join(import.meta.dir, "../apps/extension/.output/chrome-mv3");
const PORT = 9333;

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error(`No build at ${EXT}. Run: pnpm build`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "hp-ext-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MOCK_CODE = `import React from 'react';
export default function PersonalizedHomepage() {
  return <main><a href="https://example.com/story">Mock headline</a></main>;
}`;
const requests: any[] = [];
const modelRequests: string[] = [];
const responseRequests: any[] = [];
let mockError = "";
let forceApiFailure = false;
const mockApi = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/responses") {
      if (forceApiFailure) return new Response("", { status: 503 });
      const body: any = await request.json();
      if (body.model !== "gpt-6.1-sol" || body.store !== false || request.headers.get("Authorization") !== "Bearer test-compatible-key") mockError = "Wrong Responses configuration";
      let name = "connectionCheck";
      let args: object = {};
      if (body.tools[0].name !== "connectionCheck") {
        responseRequests.push(body);
        name = responseRequests.length === 1 ? "getHistory" : "write";
        if (name === "write") {
          if (body.input.at(-1).call_id !== "call_getHistory" || !body.input.some((i: any) => i.encrypted_content === "test-reasoning")) mockError = "Responses lost reasoning or tool correlation";
          args = { path: "/mnt/session/outputs/homepage.tsx", content: MOCK_CODE };
        }
      }
      return Response.json({ status: "completed", output: [
        { type: "reasoning", id: `rs_${name}`, summary: [], encrypted_content: "test-reasoning" },
        { type: "function_call", id: `fc_${name}`, call_id: `call_${name}`, name, arguments: JSON.stringify(args), status: "completed" },
      ] });
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") {
      modelRequests.push(request.url);
      if (request.headers.get("Authorization") !== "Bearer test-compatible-key") return new Response("", { status: 401 });
      return Response.json(new URL(request.url).searchParams.has("after")
        ? { data: [{ id: "test/custom-model" }], has_more: false }
        : { data: [{ id: "test/other-model" }], has_more: true, last_id: "test/other-model" });
    }
    if (new URL(request.url).pathname === "/news") {
      return new Response('<html><head><title>Local news</title></head><body><a href="https://example.com/story">Mock headline</a></body></html>', { headers: { "Content-Type": "text/html" } });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body: any = await request.json();
    requests.push(body);
    if (body.model !== "test/custom-model" || request.headers.get("Authorization") !== "Bearer test-compatible-key") mockError = "Wrong model or credential";
    let name: string;
    let args: object;
    switch (requests.length) {
      case 1: name = "getHistory"; args = {}; break;
      case 2: name = "getPageHtml"; args = { urls: [`http://127.0.0.1:${mockApi.port}/news`], loadDelayMs: 0 }; break;
      case 3: {
        const result = JSON.parse(body.messages.at(-1).content);
        if (!result.pages?.length) {
          mockError = `Scrape failed: ${JSON.stringify(result)}`;
          return new Response("scrape failed", { status: 500 });
        }
        name = "read"; args = { path: result.pages[0].mountPath }; break;
      }
      default: {
        const result = JSON.parse(body.messages.at(-1).content);
        if (!result.content?.includes("Mock headline")) mockError = "Local read did not return scraped content";
        name = "write"; args = { path: "/mnt/session/outputs/homepage.tsx", content: MOCK_CODE }; break;
      }
    }
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
      { id: `call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ] } }] });
  },
});

let failures = 0;
const check = (label: string, pass: boolean, extra?: string) => {
  console.log(`${pass ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging", // required for the CDP Extensions domain
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function getJson(path: string) {
  return (await fetch(`http://127.0.0.1:${PORT}${path}`)).json() as Promise<any>;
}

/** Minimal CDP client over a target's websocket. */
async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiters = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)!(msg);
      waiters.delete(msg.id);
    }
  };
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((res) => {
      const n = ++id;
      waiters.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return {
    send,
    close: () => ws.close(),
    async evaluate<T>(expression: string): Promise<T> {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const ex = r.result?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
      return r.result?.result?.value as T;
    },
  };
}

try {
  let version: any;
  for (let i = 0; i < 80; i++) {
    try {
      version = await getJson("/json/version");
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error("Chrome devtools endpoint never came up");
  console.log(`   ${version.Browser}\n`);

  // ---- load the unpacked extension ----------------------------------------
  const browser = await cdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const extId: string | undefined = loaded.result?.id;
  if (!extId) throw new Error(`loadUnpacked failed: ${JSON.stringify(loaded)}`);
  console.log(`   extension id: ${extId}\n`);

  // ---- 1. service worker ---------------------------------------------------
  let sw: any;
  for (let i = 0; i < 40 && !sw; i++) {
    const targets: any[] = await getJson("/json/list");
    sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!sw) await sleep(250);
  }
  check("MV3 service worker registered", Boolean(sw), sw?.url.split("/").pop());

  // ---- 2. new-tab override renders ----------------------------------------
  const targets: any[] = await getJson("/json/list");
  const blank = targets.find((t) => t.type === "page");
  if (!blank) throw new Error("no page target to navigate");

  const page = await cdp(blank.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  const nav = await page.send("Page.navigate", { url: `chrome-extension://${extId}/newtab.html` });
  if (nav.result?.errorText) throw new Error(`navigate failed: ${nav.result.errorText}`);

  let href = "";
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      href = await page.evaluate<string>("location.href");
      const ready = await page.evaluate<string>("document.readyState");
      if (href.startsWith("chrome-extension://") && ready === "complete") break;
    } catch {
      /* navigation in flight */
    }
  }
  check("new-tab override loads", href.startsWith("chrome-extension://"), href);

  await sleep(2500); // let React mount
  const bodyText = await page.evaluate<string>("document.body.innerText");
  check(
    "renders the API-key setup screen",
    /Connect your AI provider/i.test(bodyText),
    bodyText.split("\n").filter(Boolean)[0]?.slice(0, 50),
  );

  // Open a build port, send one message, and collect replies for a moment.
  const talk = (msg: object, waitMs: number) =>
    page.evaluate<string>(`
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "homepage-agent" });
        const replies = [];
        port.onMessage.addListener((m) => replies.push(m));
        port.postMessage(${JSON.stringify(msg)});
        setTimeout(() => { port.disconnect(); resolve(JSON.stringify(replies)); }, ${waitMs});
      })
    `).then((raw) => JSON.parse(raw) as any[]);

  // ---- 3. subscribe → snapshot ---------------------------------------------
  const subscribed = await talk({ kind: "subscribe" }, 1500);
  const snapshot = subscribed.find((m) => m.kind === "snapshot");
  check(
    "worker answers subscribe with a build snapshot",
    Boolean(snapshot) && snapshot.state.running === false,
    JSON.stringify(subscribed[0])?.slice(0, 80),
  );

  // ---- 4. startBuild without a key fails cleanly ----------------------------
  const started = await talk({ kind: "startBuild" }, 3000);
  const error = started.find((m) => m.kind === "error");
  check("startBuild with no API key reports an error", /API key/i.test(error?.message ?? ""), error?.message);

  // ---- 5. chrome.history is readable ---------------------------------------
  const domains = await page.evaluate<string[]>(`
    (async () => {
      const seed = [
        "https://news.ycombinator.com/",
        "https://news.ycombinator.com/item?id=1",
        "https://lobste.rs/",
        "https://arstechnica.com/",
      ];
      for (const url of seed) await chrome.history.addUrl({ url });
      await new Promise((r) => setTimeout(r, 500));
      const items = await chrome.history.search({ text: "", startTime: 0, maxResults: 100 });
      return [...new Set(items.map((i) => new URL(i.url).hostname))];
    })()
  `);
  check(
    "chrome.history is readable (seeded domains returned)",
    domains.includes("news.ycombinator.com"),
    domains.join(", "),
  );

  // ---- 6. legacy installs default to Anthropic; Settings works before a build
  await page.evaluate(`chrome.storage.local.set({ apiKey: "test-legacy-key", model: "retired-model", autoRebuild: false })`);
  await page.send("Page.reload");
  await sleep(1000);
  check("legacy API key still opens the first-build screen", /Build your homepage/.test(await page.evaluate<string>("document.body.innerText")));
  const clickButton = async (text: string) => {
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
      button.click();
    })()`);
    await sleep(100);
  };
  await clickButton("⚙️ Settings");
  check("Settings offers legacy Claude model and key", await page.evaluate<boolean>(`document.querySelector('input[type=password]').value === 'test-legacy-key' && [...document.querySelectorAll('select')].some((s) => s.value === 'claude-sonnet-5-5')`));
  await page.evaluate(`(() => {
    const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'openai-compatible'));
    select.value = 'openai-compatible'; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(100);
  await page.evaluate(`(() => {
    const set = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(document.querySelector('input[type=url]'), 'http://127.0.0.1:${mockApi.port}/v1/chat/completions/');
    set(document.querySelector('input[type=password]'), 'test-compatible-key');
  })()`);
  await clickButton("Test connection");
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate<boolean>(`!!document.querySelector('select[aria-label="Available models"]')`)) break;
    await sleep(100);
  }
  check("connection test works before entering a model and loads the complete list", await page.evaluate<boolean>(`document.querySelector('[role=status]')?.textContent.includes('Loaded 2 models') && document.querySelector('select[aria-label="Available models"]')?.options.length === 3`) && modelRequests.length === 2 && requests.length === 0);
  await page.evaluate(`(() => {
    const input = document.querySelector('input[type=password]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'wrong-key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  check("changing credentials clears the previous model list", await page.evaluate<boolean>(`!document.querySelector('select[aria-label="Available models"]') && !document.querySelector('[role=status]')`));
  await clickButton("Test connection");
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate<boolean>(`!!document.querySelector('[role=status]')`)) break;
    await sleep(100);
  }
  check("invalid credentials display a failed connection test", await page.evaluate<boolean>(`document.querySelector('[role=status]')?.textContent.includes('HTTP 401') && !document.querySelector('select[aria-label="Available models"]')`));
  await page.evaluate(`(() => {
    const input = document.querySelector('input[type=password]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'test-compatible-key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  await clickButton("Test connection");
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate<boolean>(`!!document.querySelector('select[aria-label="Available models"]')`)) break;
    await sleep(100);
  }
  await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Available models"]');
    if (!select) throw new Error('Model list not loaded');
    select.value = 'test/custom-model'; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(100);
  check("existing settings default to automatic output language", await page.evaluate<boolean>(`document.querySelector('select[aria-label="Output language"]').value === 'auto'`));
  await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Output language"]');
    select.value = 'zh-CN'; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(100);
  await clickButton("Save & rebuild");

  let stored: any;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    stored = await page.evaluate("chrome.storage.local.get(null)");
    if (stored.homepageData?.code || stored.buildSnapshot?.phase === "error") break;
  }
  check("compatible settings are saved and URL normalized", stored.apiProvider === "openai-compatible" && stored.openaiBaseUrl === `http://127.0.0.1:${mockApi.port}/v1` && stored.openaiModel === "test/custom-model");
  check("switching provider preserves the Anthropic credential", stored.apiKey === "test-legacy-key");
  check("selected output language is saved and sent to the model", stored.outputLanguage === "zh-CN" && requests[0]?.messages.some((m: any) => m.role === "user" && m.content.includes("Simplified Chinese")));
  check("worker completes history, browser scrape, local read and homepage write", stored.homepageData?.code === MOCK_CODE && requests.length === 4 && !mockError, mockError || stored.buildSnapshot?.error || `${requests.length} local API requests`);
  // Cleanup may follow the done broadcast by a few storage operations.
  await sleep(300);
  stored = await page.evaluate("chrome.storage.local.get(null)");
  check("completed compatible build removes conversation, pages and pinned configuration", !stored.openaiBuildCheckpoint && !stored.activeSessionId && !stored.activeBuildConfig);

  // ---- 7. an interrupted build keeps its original provider/key/model --------
  requests.length = 0;
  const resumeId = "openai-resume-integration";
  await page.evaluate(`chrome.storage.local.set(${JSON.stringify({
    apiProvider: "anthropic", apiKey: null,
    openaiApiKey: "changed-key", openaiModel: "changed-model",
    activeSessionId: resumeId,
    activeBuildConfig: { provider: "openai-compatible", apiKey: "test-compatible-key", baseUrl: `http://127.0.0.1:${mockApi.port}/v1`, model: "test/custom-model" },
    openaiBuildCheckpoint: {
      sessionId: resumeId, baseUrl: `http://127.0.0.1:${mockApi.port}/v1`, model: "test/custom-model", turns: 0,
      files: {}, scrapedUrls: [], messages: [{ role: "system", content: "Build a homepage with the provided tools." }, { role: "user", content: "Build today's homepage." }],
    },
  })})`);
  const resumed = await page.evaluate<any[]>(`new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'homepage-agent' });
    const replies = [];
    port.onMessage.addListener((m) => replies.push(m));
    port.postMessage({ kind: 'startBuild', resume: true });
    port.postMessage({ kind: 'startBuild', resume: true });
    setTimeout(() => { port.disconnect(); resolve(replies); }, 7000);
  })`);
  check("resume uses pinned compatible provider despite changed Settings", resumed.some((m) => m.kind === "done") && !resumed.some((m) => m.kind === "error") && !mockError, mockError || resumed.find((m) => m.kind === "error")?.message);
  check("duplicate start messages run only one build", requests.length === 4, `${requests.length} local requests`);

  // ---- 8. automatic rebuild uses compatible credentials without an Anthropic key
  requests.length = 0;
  await page.evaluate(`chrome.storage.local.set(${JSON.stringify({
    apiProvider: "openai-compatible", openaiApiKey: "test-compatible-key", openaiModel: "test/custom-model",
    autoRebuild: true, homepageData: { code: MOCK_CODE, timestamp: "2000-01-01T00:00:00Z" },
  })})`);
  await page.evaluate(`chrome.alarms.create('homepage-heartbeat', { when: Date.now() + 100, periodInMinutes: 1 })`);
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    stored = await page.evaluate("chrome.storage.local.get(null)");
    if (stored.lastAutoBuildAttempt && stored.buildSnapshot?.phase === "done") break;
  }
  check("heartbeat rebuilds using only compatible credentials", Boolean(stored.lastAutoBuildAttempt) && stored.homepageData?.timestamp !== "2000-01-01T00:00:00Z" && requests.length === 4 && !mockError, mockError || `${requests.length} local API requests`);
  check("automatic rebuild uses the saved output language", requests[0]?.messages.some((m: any) => m.role === "user" && m.content.includes("Simplified Chinese")));
  await page.evaluate("chrome.storage.local.set({ autoRebuild: false })");

  await clickButton("⚙️ Settings");
  check("saved compatible model is shown when reopening Settings", await page.evaluate<boolean>(`document.querySelector('input[placeholder="Exact model ID from your provider"]').value === 'test/custom-model'`));
  check("saved output language is shown when reopening Settings", await page.evaluate<boolean>(`document.querySelector('select[aria-label="Output language"]').value === 'zh-CN'`));
  await page.evaluate(`(() => {
    const input = document.querySelector('input[placeholder="Exact model ID from your provider"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'gpt-6.1-sol');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  check("GPT-6 model selects Responses automatically", await page.evaluate<boolean>(`[...document.querySelectorAll('select')].some((s) => s.value === 'auto' && s.options[0].text.includes('Responses'))`));
  await clickButton("Test connection");
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate<boolean>(`!!document.querySelector('[role=status]')`)) break;
    await sleep(100);
  }
  check("selected model tests Responses tool calling", await page.evaluate<boolean>(`document.querySelector('[role=status]')?.textContent.includes('Responses tool calling succeeded')`));
  await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Available models"]');
    select.value = 'test/custom-model'; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(100);
  check("changing the model clears tool-test success and retains the model list", await page.evaluate<boolean>(`document.querySelector('[role=status]')?.textContent.includes('Model selection changed') && document.querySelector('select[aria-label="Available models"]')?.options.length === 3`));
  await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Available models"]');
    select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(100);
  await page.evaluate(`(() => {
    const input = document.querySelector('input[placeholder="Exact model ID from your provider"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'gpt-6.1-sol');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  const screenshot = process.env.EXTENSION_SCREENSHOT_PATH;
  if (screenshot) {
    const captured = await page.send("Page.captureScreenshot", { format: "png" });
    if (captured.result?.data) await Bun.write(screenshot, Buffer.from(captured.result.data, "base64"));
  }
  await clickButton("Save & rebuild");
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    stored = await page.evaluate("chrome.storage.local.get(null)");
    if (responseRequests.length === 2 && !stored.activeSessionId && stored.buildSnapshot?.phase === "done") break;
  }
  check("GPT-6 Responses build completes with reasoning and tool results preserved", responseRequests.length === 2 && !mockError && stored.openaiModel === "gpt-6.1-sol" && stored.homepageData?.code === MOCK_CODE, mockError);

  // Host controls and errors must occupy their own space above arbitrary generated content.
  for (const width of [1280, 320]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    check(`homepage controls do not cover content at ${width}px`, await page.evaluate<boolean>(`(() => {
      const controls = document.querySelector('header[aria-label="Homepage controls"]').getBoundingClientRect();
      const preview = document.querySelector('.homepage-preview').getBoundingClientRect();
      const layout = document.querySelector('.homepage-preview .sp-layout').getBoundingClientRect();
      return controls.bottom <= preview.top && preview.height > 0 && layout.top >= preview.top && layout.bottom <= innerHeight + 1
        && document.documentElement.scrollWidth <= innerWidth;
    })()`));
  }
  forceApiFailure = true;
  await clickButton("↻ Rebuild");
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate<boolean>(`!!document.querySelector('button[title="Dismiss"]')`)) break;
    await sleep(100);
  }
  check("failed-build message does not cover the toolbar or homepage", await page.evaluate<boolean>(`(() => {
    const controls = document.querySelector('header[aria-label="Homepage controls"]').getBoundingClientRect();
    const error = document.querySelector('button[title="Dismiss"]').parentElement.getBoundingClientRect();
    const preview = document.querySelector('.homepage-preview').getBoundingClientRect();
    return controls.bottom <= error.top && error.bottom <= preview.top && preview.bottom <= innerHeight + 1
      && document.documentElement.scrollWidth <= innerWidth;
  })()`));

  page.close();
  browser.close();
} catch (err) {
  console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
  failures++;
} finally {
  mockApi.stop(true);
  chrome.kill("SIGKILL");
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}

console.log(
  `\n${failures === 0 ? "\x1b[32mEXTENSION VERIFIED\x1b[0m" : `\x1b[31m${failures} check(s) failed\x1b[0m`}`,
);
process.exit(failures === 0 ? 0 : 1);

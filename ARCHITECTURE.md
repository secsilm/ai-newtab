# Architecture

There is no application server. The default Anthropic path involves the following
parties; the OpenAI-compatible path is described below.

| | Runs where | Does what |
|---|---|---|
| **Extension** (service worker) | Your browser | Hosts the build: holds the SSE stream, executes `getHistory` / `getPageHtml`, uploads page HTML, persists the homepage |
| **Extension** (new-tab page(s)) | Your browser | Thin view: subscribes to the worker over a port, renders live progress and the finished homepage |
| **Orchestration layer** | Anthropic | Runs the agent loop, persists the session event log, emits `agent.custom_tool_use` |
| **Session sandbox** | Anthropic | Runs `read` / `grep` / `glob` / `write` over the mounted pages |

The agent loop runs **in the service worker** (`apps/extension/lib/build-manager.ts`), so a build
survives closing the tab, shows up in every open tab, and can run headless on a
`chrome.alarms` schedule. The two custom tools execute in the extension too, because they
need `chrome.history` and `chrome.tabs`. Anthropic never executes them — it emits an event
and waits for a `user.custom_tool_result` on the same authenticated stream. There is no
inbound connection and no public endpoint.

```
service worker        Anthropic loop        sandbox
    │                       │                  │
    ├─ sessions.create ────▶│                  │
    ├─ events.stream ──────▶│  (open first)    │
    ├─ user.message ───────▶│                  │
    │◀─ custom_tool_use ────┤  getHistory      │
    ├─ chrome.history ──────┤                  │
    ├─ custom_tool_result ─▶│                  │
    │◀─ custom_tool_use ────┤  getPageHtml     │
    ├─ tabs + scripting     │                  │
    ├─ files.upload ───────────────────────────▶
    ├─ resources.add ──────────────────────────▶  mounts /mnt/session/uploads/pages/*.html
    ├─ custom_tool_result ─▶│                  │
    │                       ├─ grep / read ───▶│
    │◀─ agent.message ──────┤                  │
    │◀─ status_idle ────────┤  end_turn        │
    ├─ files.list(scope_id) ───────────────────▶  /mnt/session/outputs/homepage.tsx
    └─ sessions.delete ────▶│                  │
```

### Keeping the worker alive

An MV3 service worker is torn down after ~30s idle, and a build spends most of its
wall clock waiting on the model. Three things keep it alive or bring it back:

- **During a turn**, the in-flight session fetch plus a 20s self-ping
  (`runtime.getPlatformInfo`) reset the idle timer.
- **A 1-minute alarm heartbeat** calls `BuildManager.tick()`. If an
  `activeSessionId` is in storage, the worker reattaches: the orchestrator replays
  the session's event log, re-answers any tool call left hanging, and finishes.
- **The same heartbeat** drives scheduled rebuilds (`lib/auto-rebuild.ts`), so the
  first new tab of the day already shows a fresh homepage.

### Tabs are views

Each new tab connects on a port (`lib/protocol.ts`), receives a snapshot of the
build state, then streams phase/text/log deltas. Every open tab shows the same live
run. A throttled snapshot is also mirrored to storage so a tab opened while the
worker is asleep paints instantly.

The finished component renders inside a Sandpack iframe
(`entrypoints/newtab/components/HomepagePreview.tsx`): it is model-written code, so
it runs sandboxed, not in the extension's own page.

## Layout

### OpenAI-compatible provider

The Anthropic managed-session path remains the default. `api-config.ts` validates
and normalizes a provider configuration, and `api-runner.ts` routes builds to
either the existing orchestrator or `openai-orchestrator.ts`.

Compatible builds send non-streaming JSON requests to a configured API root plus
`/chat/completions` or `/responses`, with function schemas for the browser tools and
local `read`, `grep`, `glob`, `write`. No vendor-specific sampling, output-token or
reasoning settings are sent. Assistant tool calls are saved before execution;
each correlated tool result and virtual file change is then checkpointed together.
On resume, only unanswered calls are executed. A browser scrape interrupted before
its result was saved may be repeated. Provider `reasoning_content` is preserved
when returned so compatible reasoning endpoints can continue tool turns.
Responses builds use flat function schemas with `strict: false` and `store: false`.
They replay all output items, including encrypted reasoning, and correlate tool
results with `call_id`. The protocol is pinned in the local checkpoint. Auto picks
Responses for GPT-6 model IDs; Settings can override this for gateway aliases.
The connection test lists models and, when a model is selected, makes a synthetic
function call under the same protocol. It sends no history and times out at 60 seconds.

The virtual filesystem is a plain local data structure with no shell or OS access.
Reads are capped and paginated; grep is a literal case-insensitive search. Only
`/mnt/session/outputs/homepage.tsx` may be written. Limits bound the run to 40 model
turns, 8 distinct scraped URLs, 2 million stored file characters and 2 million
conversation characters; each HTTP request has a 3-minute timeout. HTTP errors
report status without copying potentially sensitive gateway response bodies.

Settings persist provider-specific keys/model selections separately, defaulting
existing installations to Anthropic. BuildManager pins the active configuration
in local storage so changing Settings cannot route an interrupted conversation to
a different provider. Its single-flight lock is acquired before asynchronous
settings reads. The same keepalive, heartbeat, progress protocol and automatic
rebuild schedule serve both providers.

```
packages/agent-core/      host-agnostic agent loop — imports no chrome.*, browser.*, or node:*
  orchestrator.ts         runHomepageBuild: session lifecycle, event loop, tool dispatch, cleanup
  openai-orchestrator.ts  local tool loop and checkpoints for compatible APIs
  openai-protocol.ts      Responses input/output and safe protocol error hints
  api-config.ts          provider configuration, URL normalization and validation
  api-runner.ts          routes a configured build to the appropriate provider
  setup.ts                ensureAgent / ensureEnvironment (created once, cached by ID)
  prompt.ts               system prompt + per-build kickoff message
  schemas.ts              custom tool input schemas and defaults
  history-digest.ts       narrows raw history to fit a tool result
  types.ts                BrowserBridge, KVStore, RunPhase, …

apps/extension/           MV3 extension (WXT + React)
  entrypoints/
    background.ts         service worker: hosts BuildManager, alarm heartbeat
    scraper.content.ts    injected into scraped tabs: scroll, return HTML
    newtab/               the new-tab UI (thin client onto the worker)
  lib/
    build-manager.ts      single-flight build host, broadcast, keepalive, reattach
    browser-bridge.ts     BrowserBridge over chrome.history / chrome.tabs
    history.ts            getHistory: group and rank chrome.history by domain
    scraper.ts            getPageHtml: load URLs in a background window, sanitize HTML
    protocol.ts           page ↔ worker messages and the five UI build steps
    auto-rebuild.ts       when to rebuild on a schedule
    storage.ts            every chrome.storage key, settings, saved homepage
    transpile.ts          TSX → JS for the preview

harness/                  Bun scripts: drive agent-core with a fixture/fetch bridge, test the extension
```

## Verification

| Command | Proves |
|---|---|
| `pnpm test` | History digest plus compatible tool calls, output rendering, resume, errors, cancellation and cleanup |
| `pnpm agent:run` | Full build against the real API: tools, mounting, sandbox grep/read, deliverable, cleanup |
| `pnpm agent:verify` | The deliverable transforms, evaluates and server-renders |
| `pnpm agent:resume-test` | A build killed with a tool call pending can be reattached and finished |
| `pnpm agent:retention <sessionId>` | The session and every uploaded page body are actually deleted |
| `pnpm extension:test` | In headless Chrome: worker registers, new tab renders, port protocol answers, `chrome.history` reads |

`agent:run` can use `ANTHROPIC_API_KEY` or `API_PROVIDER=openai-compatible` with
`OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`. The resume/retention scripts
are Anthropic-specific. Real builds spend API credits. The
harness's bridge uses fixture history and a plain `fetch`, so it can't see
logged-in pages — that's the whole reason `getPageHtml` runs in your browser.

## Gotchas worth knowing

**`mount_path` is always re-rooted under `/mnt/session/uploads/`.** A leading `/` is
stripped, not honored — both at session-create time and via `resources.add()`:

| requested | resolved |
|---|---|
| `/workspace/pages/x.html` | `/mnt/session/uploads/workspace/pages/x.html` |
| `/mnt/session/uploads/x.html` | `/mnt/session/uploads/x.html` |
| *(omitted)* | `/mnt/session/uploads/<file_id>` |

Always report `resource.mount_path` from the response back to the model, never the
path you asked for, or it greps a file that isn't there.

**The result event field is `custom_tool_use_id`**, not `tool_use_id`. (`tool_use_id`
belongs to `user.tool_confirmation` and `user.tool_result`.)

**Never leave an `agent.custom_tool_use` unanswered.** Every path out of the handler
must send a result — a thrown error becomes a result with `is_error: true`, never a
reason to skip the send. An unanswered tool call idles the session forever.

**Don't break on `session.status_idle` alone.** The session idles every time it waits
for a tool result. Break only on `status_terminated`, or on `status_idle` where
`stop_reason.type !== "requires_action"`. And run the terminal check for *every* event,
including deduped ones — `continue`-ing on a duplicate can skip the terminal event that
arrived in the history fetch.

**`event_start` / `event_delta` stream events carry no `id`.** Skip them before dedupe.

**`files.upload()` takes no `purpose`.** Just `{ file }`.

## Privacy

Both providers receive browsing digests and page excerpts. Compatible builds
keep the conversation, scraped HTML and active configuration (including the key)
in `chrome.storage.local` while in flight, including across an unexpected worker
kill. The conversation/files/configuration are removed on completion, failure or
explicit cancellation. Compatible APIs have no universal session-deletion endpoint;
their server-side request retention is governed by the selected provider. Saving
settings or switching providers preserves each provider's saved credential.

The session event log persists every domain, title and scraped page body server-side
until deleted, and uploaded files persist independently. `runHomepageBuild` deletes
both in a `finally`. Confirm retention/ZDR eligibility against current docs before
distributing this.

The API key lives in `chrome.storage.local`, readable by anyone with access to the
browser profile. Fine for a tool you run yourself; **do not ship this to the Web Store**
without moving the key behind a proxy.

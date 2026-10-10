# AI Homepage

**A new tab that reads the internet for you.**

AI Homepage replaces Chrome's new-tab page with one that's written for you. An
agent looks at what you've actually been browsing, opens the pages you follow
(signed in as you), and writes a fresh homepage from what it finds there. It
rebuilds itself in the background, so each new tab is up to date.

![An example homepage in a morning-newspaper style](docs/preview.png)
<sub>Illustration. Your homepage is built from your own browsing, so its stories will be different.</sub>

A morning newspaper is just one look. You can describe any look and the next build
follows it: a quiet one-column digest, a dense dashboard, a green-on-black
terminal, a zine.

> **Privacy, up front.** To build your homepage, the extension sends a summary of
> your browsing history (top domains, visit counts, a few page titles) and the
> cleaned-up HTML of up to 8 pages to your selected API provider, using your own API key.
> Those pages are loaded in your signed-in browser, so they can include private
> content. Anthropic sessions and uploads are deleted when each build ends.
> OpenAI-compatible builds clear their local conversation and page checkpoint on
> completion, failure or cancellation; server retention depends on your provider.
> Your API keys stay in the extension's local storage. More detail in
> [ARCHITECTURE.md](./ARCHITECTURE.md#privacy).

---

## Install

You need Chrome (or another Chromium browser), [Node.js](https://nodejs.org) 20+,
and an [Anthropic API key](https://console.anthropic.com) or an OpenAI-compatible
API endpoint and key with a model that supports function calling.

```bash
git clone https://github.com/ThariqS/ai-newtab.git
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

(If you already have [pnpm](https://pnpm.io), plain `pnpm install && pnpm build` works too.)

Then load it into Chrome:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `apps/extension/.output/chrome-mv3`.

If Chrome asks whether to keep the changed new-tab page, choose **Keep it**.

## Your first homepage

1. Open a new tab and choose your API provider. For Anthropic, paste your key.
   For **OpenAI-compatible**, enter the Base URL, API key and exact model ID.
   Click **Save connection**.
2. Click **Build today's homepage**.
3. Watch it work. The progress view walks through each step: preparing the
   agent, reading your history, opening pages in your browser, analyzing them,
   and writing your homepage.

The first build takes a few minutes. You can close the tab while it runs, since
the build lives in the extension's background worker and appears in any new tab
you open.

## Make it yours

Click **⚙️ Settings** on the new tab.

**Output language.** Choose Simplified Chinese, Traditional Chinese, English or
another listed language for homepage headings, summaries and navigation text,
as well as the final build summary. **Auto** keeps the existing source-language
behavior. The selection is saved locally and applies to manual and automatic
rebuilds for both providers. It takes priority over conflicting language requests
in standing instructions. Existing interrupted builds keep their original language;
start a new build to apply a changed language. For CLI builds, set
`HOMEPAGE_OUTPUT_LANGUAGE` in `.env` (for example `zh-CN`).

**Instructions.** Anything you write here goes into every build and takes priority
over the agent's own defaults. This box sets both the content and the look:

| You write | You get |
| --- | --- |
| *"A morning newspaper. Serif type, a big masthead, a lead story, a column of briefs."* | A broadsheet front page |
| *"One calm column. No images. Five things worth reading, with one line on why."* | A quiet reading list |
| *"Dense dashboard: GitHub PRs and issues first, then Hacker News, then everything else."* | A work cockpit |
| *"Green-on-black terminal, monospace, like a 1980s BBS."* | Exactly that |
| *"Skip sports and politics. Always show the weather and my next three calendar events."* | Your rules, every day |

Click **Save & rebuild** to apply them right away.

**API connection.** Switch providers or update your key in Settings. Each provider's
key and model selection are saved separately. **Save & rebuild** applies the
connection and instructions together. Settings are also available before the first
build, including after a failed build.

For **OpenAI-compatible**, use your provider's API root including its version path
(for example `https://api.example.com/v1`) or the complete `/chat/completions` URL.
Enter the exact model ID offered by that provider; there is no fixed model list.
After filling in Base URL and API key, click **Test connection** to check access
and load the provider's model list into a dropdown. Paginated lists are fetched
in full when the provider uses `has_more`/`after` pagination. You can also select
**Enter a model ID manually**. If the provider does
not support model listing, enter a model ID and test again: the extension sends
a short synthetic tool request. No browsing data is sent by the test. Once a model
is selected, testing also verifies function calling using the chosen protocol,
even when model listing succeeds. Tests time out after 60 seconds.
Local HTTP endpoints such as `http://localhost:1234/v1` work too. For a local API
without authentication, enter a placeholder key such as `local`.

**API protocol.** Auto uses Responses (`POST /responses`) for GPT-6 model IDs,
including `gpt-6.1-sol`, and Chat Completions (`POST /chat/completions`) for other
models. You can explicitly choose either protocol for provider-specific aliases.
GPT-6.1 Sol requires Responses for tool calling, as described in the
[official model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
The endpoint must support JSON responses and function calling under that protocol.
Reading history, scraping pages, analyzing
files and writing the homepage all run through the same browser tools. Compatible
builds are bounded to 40 model turns and 8 distinct pages. Individual API requests
time out after 3 minutes; errors appear in the build view.

**Model (Anthropic).** Choose which Claude model writes your page:

- **Claude Sonnet 5.5** (default): the best balance of quality and cost.
- **Claude Haiku 5.5**: the fastest and cheapest.
- **Claude Opus 5.5**: the most careful editor, and the most expensive.

Connection changes apply to the next build. An interrupted build resumes with the
provider, endpoint, model and key it started with.

**Rebuild automatically.** On by default. Once your homepage is older than the
interval you pick (6, 12, 24 or 48 hours), the extension rebuilds it quietly in the
background. It only starts after you've built once by hand, and it won't retry a
failed build until the next interval, so it never loops.

**↻ Rebuild** in the top-right corner rebuilds right away.

## Good to know

- **Cost.** Builds are billed by your selected provider: a managed session for
  Anthropic, or multiple model requests for compatible APIs. Cost
  depends on the model and how much it reads. Turn off automatic rebuilds to
  build only when you ask.
- **What it can see.** It ranks the sites in your history and opens up to 8 of
  them per build. It skips search engines, webmail, banking and logged-out
  marketing pages. Anything it can't open is reported, not hidden.
- **Links are real.** Every link on the page comes from a page the agent actually
  read. It's told never to invent a URL.
- **Interrupted builds.** If Chrome closes mid-build, the new tab offers
  **Resume interrupted build** next time.
- **Updating.** After pulling new code, run `npx pnpm@10.11.1 build` again, then
  click the reload icon on the extension in `chrome://extensions`.

## How it works

1. **`getHistory`**: the agent gets a ranked summary of your most-visited domains.
2. **`getPageHtml`**: it picks up to 8 pages, which the extension opens in a
   background window, cleans up, and mounts into the agent's sandbox as files.
3. **`grep` / `read`**: the agent pulls headlines, posts and links out of those
   files inside its sandbox.
4. **`write`**: it writes one React component, which the new tab renders.

The extension's background worker drives a
[Claude Managed Agents](https://docs.claude.com) session directly, with no server
in between. The two custom tools run in the extension because they need
`chrome.history` and `chrome.tabs`. Everything else happens in the agent's
sandbox, where shell access is off: scraped pages are untrusted input.

With an OpenAI-compatible API, the worker drives the function-calling loop itself.
It stores scraped pages in a restricted virtual filesystem and supplies local
`read`, `grep`, `glob` and `write` tools. It checkpoints the conversation and files
after each tool result so a worker restart can continue unanswered calls. Only the
homepage output path is writable; no shell or access to your computer's files is
available to the model. The wire format follows the official
[Chat Completions function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the event flow, the layout, and
the gotchas worth knowing.

## Development

```
packages/agent-core   the agent loop: host-agnostic, no chrome.* or node:*
apps/extension        the MV3 extension (WXT + React)
harness               Bun scripts that run agent-core outside Chrome, and test the built extension
```

```bash
pnpm dev                 # WXT with hot reload
pnpm typecheck           # all packages
pnpm test                # unit tests (no API calls; needs Bun)
pnpm extension:test      # headless Chrome with a local mock API (no external API calls)

cp .env.example .env     # configure your provider, then:
pnpm agent:run           # a full build against the real API, with fixture history
pnpm agent:verify        # check the output actually renders
```

For compatible harness runs, set `API_PROVIDER=openai-compatible`, `OPENAI_API_KEY`,
`OPENAI_BASE_URL` and `OPENAI_MODEL` in `.env`. `pnpm test` includes offline compatible
tool-loop, resume, cancellation, cleanup and rendered-output tests. `extension:test`
uses a local mock endpoint in an isolated Chrome profile. The managed-agent
`agent:resume-test` and `agent:retention` scripts remain Anthropic-specific.

## Status

Early and experimental. It's a tool you run yourself with your own key. Don't
publish it to a store as-is: anyone with access to the browser profile can read
the stored API key.

## License

MIT

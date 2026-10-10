import { BuildManager } from "@/lib/build-manager";
import { AGENT_PORT } from "@/lib/protocol";
import { testOpenAIConnection } from "@homepage/agent-core";

/**
 * The service worker is the build host. It owns the agent loop (BuildManager),
 * drives the selected provider's agent loop, runs the browser tools in-process, and
 * drives the scheduled rebuild from an alarm.
 *
 * New-tab pages are thin views that connect on AGENT_PORT. Closing every tab
 * doesn't stop a build: the worker keeps itself warm during an active turn, and
 * the alarm heartbeat reattaches to an interrupted session after an unexpected
 * kill.
 */
const HEARTBEAT_ALARM = "homepage-heartbeat";

export default defineBackground(() => {
  const manager = new BuildManager();

  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.kind !== "testApiConnection" || sender.id !== browser.runtime.id) return;
    if (typeof message.baseUrl !== "string" || typeof message.apiKey !== "string" ||
      (message.model !== undefined && typeof message.model !== "string")) {
      return Promise.resolve({ ok: false, models: [], message: "Invalid connection settings." });
    }
    return testOpenAIConnection({ baseUrl: message.baseUrl, apiKey: message.apiKey, model: message.model });
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === AGENT_PORT) manager.attach(port);
  });

  // ~1 min is the chrome.alarms floor — fine for a recovery net and the
  // scheduled rebuild check.
  browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) void manager.tick();
  });

  browser.runtime.onStartup.addListener(() => void manager.tick());
  browser.runtime.onInstalled.addListener(() => void manager.tick());

  // On every wake, reattach to an interrupted build (or consider a scheduled
  // rebuild) immediately rather than waiting for the first alarm.
  void manager.tick();
});

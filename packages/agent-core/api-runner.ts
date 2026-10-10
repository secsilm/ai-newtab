import type { ApiConfiguration } from "./api-config";
import { runHomepageBuild, type RunOptions } from "./orchestrator";
import { runOpenAIHomepageBuild } from "./openai-orchestrator";

export async function runConfiguredHomepageBuild(
  options: Omit<RunOptions, "client" | "model"> & { configuration: ApiConfiguration },
) {
  const { configuration, ...common } = options;
  if (configuration.provider === "openai-compatible") {
    return runOpenAIHomepageBuild({ ...common, ...configuration });
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return runHomepageBuild({
    ...common,
    model: configuration.model,
    client: new Anthropic({ apiKey: configuration.apiKey, dangerouslyAllowBrowser: true }),
  });
}

import { readConfigFile } from ".";

export interface ProviderOverrides {
  MAX_CONTEXT_TOKENS?: number;
  MAX_OUTPUT_TOKENS?: number;
  AUTOCOMPACT_PCT?: number;
  noServer?: boolean;
  env?: Record<string, string>;
  claudeCodeSettings?: Record<string, any>;
}

/**
 * Resolve the provider specified by Router.default and return its overrides.
 * Returns undefined if no Router.default or provider is found.
 */
export function resolveRouterProvider(config: any): (ProviderOverrides & { name: string }) | undefined {
  const routerDefault = config.Router?.default as string | undefined;
  if (!routerDefault || !config.Providers?.length) {
    return undefined;
  }

  const providerName = routerDefault.includes(",")
    ? routerDefault.split(",")[0]
    : routerDefault;

  const provider = config.Providers.find(
    (p: any) => p.name.toLowerCase() === providerName.toLowerCase()
  );

  if (!provider) {
    return undefined;
  }

  return {
    name: provider.name,
    MAX_CONTEXT_TOKENS: provider.MAX_CONTEXT_TOKENS,
    MAX_OUTPUT_TOKENS: provider.MAX_OUTPUT_TOKENS,
    AUTOCOMPACT_PCT: provider.AUTOCOMPACT_PCT,
    noServer: provider.noServer,
    env: provider.env,
    claudeCodeSettings: provider.claudeCodeSettings,
  };
}

const DEFAULT_MAX_CONTEXT_TOKENS = 202752;
const DEFAULT_AUTOCOMPACT_PCT = 90;

/**
 * Get environment variables for Claude Code integration.
 * When the current provider has noServer=true, its env takes full control.
 * Otherwise, routes through the local router server.
 *
 * Lookup order for MAX_CONTEXT_TOKENS / MAX_OUTPUT_TOKENS / AUTOCOMPACT_PCT:
 *   provider field > config.Defaults > hardcoded default
 */
export const createEnvVariables = async (): Promise<Record<string, string | undefined>> => {
  const config = await readConfigFile();
  const provider = resolveRouterProvider(config);
  const defaults = config.Defaults || {};

  // noServer mode: provider's env is the source of truth
  if (provider?.noServer && provider.env) {
    return provider.env as Record<string, string | undefined>;
  }

  const port = config.PORT || 3456;
  const apiKey = config.APIKEY || "test";

  const maxContextTokens = provider?.MAX_CONTEXT_TOKENS ?? defaults.MAX_CONTEXT_TOKENS ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const maxOutputTokens = provider?.MAX_OUTPUT_TOKENS ?? defaults.MAX_OUTPUT_TOKENS;
  const autocompactPct = provider?.AUTOCOMPACT_PCT ?? defaults.AUTOCOMPACT_PCT ?? DEFAULT_AUTOCOMPACT_PCT;

  return {
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    NO_PROXY: "127.0.0.1",
    DISABLE_TELEMETRY: "true",
    DISABLE_COST_WARNINGS: "true",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    API_TIMEOUT_MS: String(config.API_TIMEOUT_MS ?? 600000),
    CLAUDE_CODE_USE_BEDROCK: undefined,
    // Clear model overrides so Claude Code doesn't use stale shell env vars
    ANTHROPIC_MODEL: undefined,
    ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
    ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(maxContextTokens),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(autocompactPct),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: maxOutputTokens ? String(maxOutputTokens) : undefined,
  };
}

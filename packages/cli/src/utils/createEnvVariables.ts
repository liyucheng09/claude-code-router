import { readConfigFile } from ".";

/**
 * Get environment variables for Agent SDK/Claude Code integration
 * This function is shared between `ccr env` and `ccr code` commands
 */
export const createEnvVariables = async (): Promise<Record<string, string | undefined>> => {
  const config = await readConfigFile();
  const port = config.PORT || 3456;
  const apiKey = config.APIKEY || "test";

  return {
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    NO_PROXY: "127.0.0.1",
    DISABLE_TELEMETRY: "true",
    DISABLE_COST_WARNINGS: "true",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    API_TIMEOUT_MS: String(config.API_TIMEOUT_MS ?? 600000),
    // Reset CLAUDE_CODE_USE_BEDROCK when running with ccr
    CLAUDE_CODE_USE_BEDROCK: undefined,
    // Tell Claude Code the actual context size for auto-compact decisions
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.MAX_CONTEXT_TOKENS ?? 202752),
    // Auto compact triggers at 80% by default to leave headroom for the compact request itself
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(config.AUTOCOMPACT_PCT ?? 90),
  };
}

import { spawn, type StdioOptions } from "child_process";
import {getSettingsPath, readConfigFile} from ".";
import {
  decrementReferenceCount,
  incrementReferenceCount,
  closeService,
} from "./processCheck";
import { quote } from 'shell-quote';
import minimist from "minimist";
import { createEnvVariables, resolveRouterProvider } from "./createEnvVariables";

export interface PresetConfig {
  noServer?: boolean;
  claudeCodeSettings?: {
    env?: Record<string, any>;
    statusLine?: any;
    [key: string]: any;
  };
  provider?: string;
  router?: Record<string, any>;
  StatusLine?: any;
  [key: string]: any;
}

export async function executeCodeCommand(
  args: string[] = [],
  presetConfig?: PresetConfig | null,
  envOverrides?: Record<string, string>,
  presetName?: string
) {
  const config = await readConfigFile();
  const provider = resolveRouterProvider(config);
  const env = await createEnvVariables();

  // Apply environment variable overrides (from preset's provider configuration)
  if (envOverrides) {
    Object.assign(env, envOverrides);
  }

  // Build settingsFlag
  let settingsFlag: ClaudeSettingsFlag = {
    env: env as ClaudeSettingsFlag['env']
  };

  // Add statusLine configuration
  const statusLineConfig = presetConfig?.StatusLine || config?.StatusLine;

  if (statusLineConfig?.enabled) {
    const statuslineCommand = presetName
      ? `ccr statusline ${presetName}`
      : "ccr statusline";

    settingsFlag.statusLine = {
      type: "command",
      command: statuslineCommand,
      padding: 0,
    }
  }

  // Merge claudeCodeSettings: preset > provider > global
  const providerSettings = provider?.noServer ? provider.claudeCodeSettings : undefined;
  const settingsSource = presetConfig?.claudeCodeSettings || providerSettings;

  if (settingsSource) {
    settingsFlag = {
      ...settingsFlag,
      ...settingsSource,
      env: {
        ...settingsFlag.env,
        ...settingsSource.env,
      } as ClaudeSettingsFlag['env']
    };
  }

  // Non-interactive mode for automation environments
  if (config.NON_INTERACTIVE_MODE) {
    settingsFlag.env = {
      ...settingsFlag.env,
      CI: "true",
      FORCE_COLOR: "0",
      NODE_NO_READLINE: "1",
      TERM: "dumb"
    }
  }

  const settingsFile = await getSettingsPath(`${JSON.stringify(settingsFlag)}`)

  args.push('--settings', settingsFile);

  // Increment reference count when command starts
  incrementReferenceCount();

  // Execute claude command
  const claudePath = config?.CLAUDE_PATH || process.env.CLAUDE_PATH || "claude";

  const joinedArgs = args.length > 0 ? quote(args) : "";

  const stdioConfig: StdioOptions = config.NON_INTERACTIVE_MODE
    ? ["pipe", "inherit", "inherit"]
    : "inherit";

  const argsObj = minimist(args)
  const argsArr = []
  for (const [argsObjKey, argsObjValue] of Object.entries(argsObj)) {
    if (argsObjKey !== '_' && argsObj[argsObjKey]) {
      const prefix = argsObjKey.length === 1 ? '-' : '--';
      if (argsObjValue === true) {
        argsArr.push(`${prefix}${argsObjKey}`);
      } else {
        argsArr.push(`${prefix}${argsObjKey} ${JSON.stringify(argsObjValue)}`);
      }
    }
  }
  const claudeProcess = spawn(
    claudePath,
    argsArr,
    {
      env: {
        ...process.env,
      },
      stdio: stdioConfig,
      shell: true,
    }
  );

  // Close stdin for non-interactive mode
  if (config.NON_INTERACTIVE_MODE) {
    claudeProcess.stdin?.end();
  }

  claudeProcess.on("error", (error) => {
    console.error("Failed to start claude command:", error.message);
    console.log(
      "Make sure Claude Code is installed: npm install -g @anthropic-ai/claude-code"
    );
    decrementReferenceCount();
    process.exit(1);
  });

  claudeProcess.on("close", (code) => {
    decrementReferenceCount();
    closeService();
    process.exit(code || 0);
  });
}

/**
 * Execute `happy claude` with router environment variables passed via --claude-env.
 */
export async function executeHappyCommand(
  args: string[] = [],
  envOverrides?: Record<string, string>,
) {
  const env = await createEnvVariables();

  // Apply environment variable overrides (from preset's provider configuration)
  if (envOverrides) {
    Object.assign(env, envOverrides);
  }

  // Build --claude-env flags from the env vars that ccr would normally set
  const claudeEnvFlags: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      claudeEnvFlags.push('--claude-env', `${key}=${value}`);
    }
  }

  // Increment reference count when command starts
  incrementReferenceCount();

  const happyArgs = ['claude', ...claudeEnvFlags, ...args];

  // Build a clean env: apply ccr vars and explicitly unset vars that ccr wants removed
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.CLAUDE_CODE_USE_BEDROCK;

  const happyProcess = spawn('happy', happyArgs, {
    stdio: 'inherit',
    env: cleanEnv,
  });

  happyProcess.on("error", (error) => {
    console.error("Failed to start happy command:", error.message);
    console.log(
      "Make sure Happy CLI is installed: npm install -g happy"
    );
    decrementReferenceCount();
    process.exit(1);
  });

  happyProcess.on("close", (code) => {
    decrementReferenceCount();
    closeService();
    process.exit(code || 0);
  });
}

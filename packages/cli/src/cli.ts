#!/usr/bin/env node
import { run, restartService } from "./utils";
import { showStatus } from "./utils/status";
import { executeCodeCommand, executeHappyCommand, PresetConfig } from "./utils/codeCommand";
import {
  cleanupPidFile,
  isServiceRunning,
  getServiceInfo,
} from "./utils/processCheck";
import { runModelSelector } from "./utils/modelSelector";
import { activateCommand } from "./utils/activateCommand";
import { readConfigFile } from "./utils";
import { resolveRouterProvider } from "./utils/createEnvVariables";
import { version } from "../package.json";
import { spawn, exec } from "child_process";
import {getPresetDir, loadConfigFromManifest, PID_FILE, readPresetFile, REFERENCE_COUNT_FILE} from "@CCR/shared";
import fs, { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseStatusLineData, StatusLineInput } from "./utils/statusline";
import {handlePresetCommand} from "./utils/preset";
import { handleInstallCommand } from "./utils/installCommand";


const command = process.argv[2];

// Define all known commands
const KNOWN_COMMANDS = [
  "start",
  "stop",
  "restart",
  "status",
  "statusline",
  "code",
  "happy",
  "model",
  "preset",
  "install",
  "activate",
  "env",
  "ui",
  "-v",
  "version",
  "-h",
  "help",
];

const HELP_TEXT = `
Usage: ccr [command] [provider-name | preset-name]

Commands:
  start         Start server
  stop          Stop server
  restart       Restart server
  status        Show server status
  statusline    Integrated statusline
  code          Execute claude command (uses Router.default)
  happy         Execute happy claude (optionally with provider name)
  model         Interactive model selection and configuration
  preset        Manage presets (export, install, list, delete)
  install       Install preset from GitHub marketplace
  activate      Output environment variables for shell integration
  ui            Open the web UI in browser
  -v, version   Show version information
  -h, help      Show help information

Providers:
  Use a provider name as shortcut to launch Claude Code with that provider.
  Providers with noServer=true connect directly without the router server.

Presets:
  Any preset directory in ~/.claude-code-router/presets/

Examples:
  ccr start
  ccr code "Write a Hello World"        # Uses Router.default
  ccr glm5 "Analyze this"               # Shortcut: use glm5 provider
  ccr opus46-200k "Refactor code"       # Shortcut: use opus46-200k (direct)
  ccr happy                             # Use happy with Router.default
  ccr happy glm5                         # Use happy with glm5 provider
  ccr my-preset "Write a Hello World"   # Use preset configuration
  ccr model                             # Switch default model
  eval "$(ccr activate)"                # Set environment variables globally
  ccr ui
`;

async function waitForService(
  timeout = 10000,
  initialDelay = 1000
): Promise<boolean> {
  // Wait for an initial period to let the service initialize
  await new Promise((resolve) => setTimeout(resolve, initialDelay));

  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const isRunning = isServiceRunning()
    if (isRunning) {
      // Wait for an additional short period to ensure service is fully ready
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function main() {
  const isRunning = isServiceRunning()

  // If command is not a known command, check if it's a provider shortcut or preset
  if (command && !KNOWN_COMMANDS.includes(command)) {
    const config = await readConfigFile();

    // First: check if command matches a provider name
    const provider = config.Providers?.find(
      (p: any) => p.name.toLowerCase() === command.toLowerCase()
    );

    if (provider) {
      const codeArgs = process.argv.slice(3);
      const isNoServer = provider.noServer === true;
      let envOverrides: Record<string, string> = {};
      let presetConfig: PresetConfig = {};

      if (isNoServer) {
        envOverrides = { ...provider.env };
        presetConfig = {
          noServer: true,
          claudeCodeSettings: provider.claudeCodeSettings,
        };
      } else {
        // Router mode: same as ccr code, just use the root path
        // The router server will route based on Router.default
        const defaults = config.Defaults || {};
        if (provider.MAX_CONTEXT_TOKENS) {
          envOverrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(provider.MAX_CONTEXT_TOKENS);
        } else if (defaults.MAX_CONTEXT_TOKENS) {
          envOverrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(defaults.MAX_CONTEXT_TOKENS);
        }
        if (provider.AUTOCOMPACT_PCT) {
          envOverrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(provider.AUTOCOMPACT_PCT);
        } else if (defaults.AUTOCOMPACT_PCT) {
          envOverrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(defaults.AUTOCOMPACT_PCT);
        }
        if (provider.MAX_OUTPUT_TOKENS) {
          envOverrides.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(provider.MAX_OUTPUT_TOKENS);
        } else if (defaults.MAX_OUTPUT_TOKENS) {
          envOverrides.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(defaults.MAX_OUTPUT_TOKENS);
        }
      }

      if (!isNoServer && !isRunning) {
        console.log("Service not running, starting service...");
        const cliPath = join(__dirname, "cli.js");
        const startProcess = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
        });
        startProcess.on("error", (error) => {
          console.error("Failed to start service:", error.message);
          process.exit(1);
        });
        startProcess.unref();

        if (await waitForService()) {
          executeCodeCommand(codeArgs, presetConfig, envOverrides, command);
        } else {
          console.error(
            "Service startup timeout, please manually run `ccr start` to start the service"
          );
          process.exit(1);
        }
      } else {
        executeCodeCommand(codeArgs, presetConfig, envOverrides, command);
      }
      return;
    }

    // Fallback: check if it's a preset
    const manifest = await readPresetFile(command);

    if (manifest) {
      // This is a preset, load its configuration
      const presetDir = getPresetDir(command);
      const presetConfigData = loadConfigFromManifest(manifest, presetDir);

      // Execute code command
      const codeArgs = process.argv.slice(3); // Get remaining arguments

      // Check noServer configuration
      const shouldStartServer = presetConfigData.noServer !== true;

      // Build environment variable overrides
      let envOverrides: Record<string, string> = {};

      // Handle provider configuration (supports both old and new formats)
      let presetProvider: any = null;

      // Old format: config.provider is the provider name
      if (presetConfigData.provider && typeof presetConfigData.provider === 'string') {
        const globalConfig = await readConfigFile();
        presetProvider = globalConfig.Providers?.find((p: any) => p.name === presetConfigData.provider);
      }
      // New format: config.Providers is an array of providers
      else if (presetConfigData.Providers && presetConfigData.Providers.length > 0) {
        presetProvider = presetConfigData.Providers[0];
      }

      // If noServer is not true, use local server baseurl
      if (shouldStartServer) {
        const globalConfig = await readConfigFile();
        const port = globalConfig.PORT || 3456;
        envOverrides = {
          ...envOverrides,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/preset/${command}`,
        };
      } else if (presetProvider) {
        // Handle api_base_url, remove /v1/messages suffix
        if (presetProvider.api_base_url) {
          let baseUrl = presetProvider.api_base_url;
          if (baseUrl.endsWith('/v1/messages')) {
            baseUrl = baseUrl.slice(0, -'/v1/messages'.length);
          } else if (baseUrl.endsWith('/')) {
            baseUrl = baseUrl.slice(0, -1);
          }
          envOverrides = {
            ...envOverrides,
            ANTHROPIC_BASE_URL: baseUrl,
          };
        }

        // Handle api_key
        if (presetProvider.api_key) {
          envOverrides = {
            ...envOverrides,
            ANTHROPIC_AUTH_TOKEN: presetProvider.api_key,
          };
        }
      }

      // Apply provider-specific context/token overrides
      if (presetProvider) {
        if (presetProvider.MAX_CONTEXT_TOKENS) {
          envOverrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(presetProvider.MAX_CONTEXT_TOKENS);
        }
        if (presetProvider.AUTOCOMPACT_PCT) {
          envOverrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(presetProvider.AUTOCOMPACT_PCT);
        }
        if (presetProvider.MAX_OUTPUT_TOKENS) {
          envOverrides.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(presetProvider.MAX_OUTPUT_TOKENS);
        }
      }

      // Build PresetConfig
      const presetConfig: PresetConfig = {
        noServer: presetConfigData.noServer,
        claudeCodeSettings: presetConfigData.claudeCodeSettings,
        StatusLine: presetConfigData.StatusLine
      };

      if (shouldStartServer && !isRunning) {
        console.log("Service not running, starting service...");
        const cliPath = join(__dirname, "cli.js");
        const startProcess = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
        });

        startProcess.on("error", (error) => {
          console.error("Failed to start service:", error.message);
          process.exit(1);
        });

        startProcess.unref();

        if (await waitForService()) {
          executeCodeCommand(codeArgs, presetConfig, envOverrides, command);
        } else {
          console.error(
            "Service startup timeout, please manually run `ccr start` to start the service"
          );
          process.exit(1);
        }
      } else {
        // Service is already running or no need to start server
        if (shouldStartServer && !isRunning) {
          console.error("Service is not running. Please start it first with `ccr start`");
          process.exit(1);
        }
        executeCodeCommand(codeArgs, presetConfig, envOverrides, command);
      }
      return;
    } else {
      // Not a provider, preset, nor a known command
      console.log(HELP_TEXT);
      process.exit(1);
    }
  }

  switch (command) {
    case "start":
      await run();
      break;
    case "stop":
      try {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8"));
        process.kill(pid);
        cleanupPidFile();
        if (existsSync(REFERENCE_COUNT_FILE)) {
          try {
            fs.unlinkSync(REFERENCE_COUNT_FILE);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
        console.log(
          "claude code router service has been successfully stopped."
        );
      } catch (e) {
        console.log(
          "Failed to stop the service. It may have already been stopped."
        );
        cleanupPidFile();
      }
      break;
    case "status":
      await showStatus();
      break;
    case "statusline":
      // Read JSON input from stdin
      let inputData = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("readable", () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
          inputData += chunk;
        }
      });

      process.stdin.on("end", async () => {
        try {
          const input: StatusLineInput = JSON.parse(inputData);
          // Check if preset name is provided as argument
          const presetName = process.argv[3];
          const statusLine = await parseStatusLineData(input, presetName);
          console.log(statusLine);
        } catch (error) {
          console.error("Error parsing status line data:", error);
          process.exit(1);
        }
      });
      break;
    // ADD THIS CASE
    case "model":
      await runModelSelector();
      break;
    case "preset":
      await handlePresetCommand(process.argv.slice(3));
      break;
    case "install":
      const presetName = process.argv[3];
      await handleInstallCommand(presetName);
      break;
    case "activate":
    case "env":
      await activateCommand();
      break;
    case "code":
      {
        // Check if the current provider uses noServer mode
        const codeConfig = await readConfigFile();
        const codeProvider = resolveRouterProvider(codeConfig);
        const needsServer = !codeProvider?.noServer;

        if (needsServer && !isRunning) {
          console.log("Service not running, starting service...");
          const cliPath = join(__dirname, "cli.js");
          const startProcess = spawn("node", [cliPath, "start"], {
            detached: true,
            stdio: "ignore",
          });

          startProcess.on("error", (error) => {
            console.error("Failed to start service:", error.message);
            process.exit(1);
          });

          startProcess.unref();

          if (await waitForService()) {
            const codeArgs = process.argv.slice(3);
            executeCodeCommand(codeArgs);
          } else {
            console.error(
              "Service startup timeout, please manually run `ccr start` to start the service"
            );
            process.exit(1);
          }
        } else {
          const codeArgs = process.argv.slice(3);
          executeCodeCommand(codeArgs);
        }
      }
      break;
    case "happy":
      {
        const happyConfig = await readConfigFile();
        const happyProviderName = process.argv[3];
        let happyProvider: any = null;
        let happyEnvOverrides: Record<string, string> = {};
        let happyArgs: string[];
        let happyNeedsServer = true;

        if (happyProviderName) {
          happyProvider = happyConfig.Providers?.find(
            (p: any) => p.name.toLowerCase() === happyProviderName.toLowerCase()
          );
        }

        if (happyProvider) {
          happyArgs = process.argv.slice(4);
          if (happyProvider.noServer === true) {
            happyEnvOverrides = { ...happyProvider.env };
            happyNeedsServer = false;
          } else {
            const defaults = happyConfig.Defaults || {};
            if (happyProvider.MAX_CONTEXT_TOKENS) {
              happyEnvOverrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(happyProvider.MAX_CONTEXT_TOKENS);
            } else if (defaults.MAX_CONTEXT_TOKENS) {
              happyEnvOverrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(defaults.MAX_CONTEXT_TOKENS);
            }
            if (happyProvider.AUTOCOMPACT_PCT) {
              happyEnvOverrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(happyProvider.AUTOCOMPACT_PCT);
            } else if (defaults.AUTOCOMPACT_PCT) {
              happyEnvOverrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(defaults.AUTOCOMPACT_PCT);
            }
            if (happyProvider.MAX_OUTPUT_TOKENS) {
              happyEnvOverrides.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(happyProvider.MAX_OUTPUT_TOKENS);
            } else if (defaults.MAX_OUTPUT_TOKENS) {
              happyEnvOverrides.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(defaults.MAX_OUTPUT_TOKENS);
            }
          }
        } else {
          happyArgs = process.argv.slice(3);
        }

        const envArg = Object.keys(happyEnvOverrides).length ? happyEnvOverrides : undefined;

        if (happyNeedsServer && !isRunning) {
          console.log("Service not running, starting service...");
          const cliPath = join(__dirname, "cli.js");
          const startProcess = spawn("node", [cliPath, "start"], {
            detached: true,
            stdio: "ignore",
          });

          startProcess.on("error", (error) => {
            console.error("Failed to start service:", error.message);
            process.exit(1);
          });

          startProcess.unref();

          if (await waitForService()) {
            await executeHappyCommand(happyArgs, envArg);
          } else {
            console.error(
              "Service startup timeout, please manually run `ccr start` to start the service"
            );
            process.exit(1);
          }
        } else {
          await executeHappyCommand(happyArgs, envArg);
        }
      }
      break;
    case "ui":
      // Check if service is running
      if (!isRunning) {
        console.log("Service not running, starting service...");
        const cliPath = join(__dirname, "cli.js");
        const startProcess = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
        });

        startProcess.on("error", (error) => {
          console.error("Failed to start service:", error.message);
          process.exit(1);
        });

        startProcess.unref();

        if (!(await waitForService())) {
          // If service startup fails, try to start with default config
          console.log(
            "Service startup timeout, trying to start with default configuration..."
          );
          const {
            initDir,
            writeConfigFile,
            backupConfigFile,
          } = require("./utils");

          try {
            // Initialize directories
            await initDir();

            // Backup existing config file if it exists
            const backupPath = await backupConfigFile();
            if (backupPath) {
              console.log(
                `Backed up existing configuration file to ${backupPath}`
              );
            }

            // Create a minimal default config file
            await writeConfigFile({
              PORT: 3456,
              Providers: [],
              Router: {},
            });
            console.log(
              "Created minimal default configuration file at ~/.claude-code-router/config.json"
            );
            console.log(
              "Please edit this file with your actual configuration."
            );

            // Try starting the service again
            const restartProcess = spawn("node", [cliPath, "start"], {
              detached: true,
              stdio: "ignore",
            });

            restartProcess.on("error", (error) => {
              console.error(
                "Failed to start service with default config:",
                error.message
              );
              process.exit(1);
            });

            restartProcess.unref();

            if (!(await waitForService(15000))) {
              // Wait a bit longer for the first start
              console.error(
                "Service startup still failing. Please manually run `ccr start` to start the service and check the logs."
              );
              process.exit(1);
            }
          } catch (error: any) {
            console.error(
              "Failed to create default configuration:",
              error.message
            );
            process.exit(1);
          }
        }
      }

      // Get service info and open UI
      const serviceInfo = await getServiceInfo();

      // Add temporary API key as URL parameter if successfully generated
      const uiUrl = `${serviceInfo.endpoint}/ui/`;

      console.log(`Opening UI at ${uiUrl}`);

      // Open URL in browser based on platform
      const platform = process.platform;
      let openCommand = "";

      if (platform === "win32") {
        // Windows
        openCommand = `start ${uiUrl}`;
      } else if (platform === "darwin") {
        // macOS
        openCommand = `open ${uiUrl}`;
      } else if (platform === "linux") {
        // Linux
        openCommand = `xdg-open ${uiUrl}`;
      } else {
        console.error("Unsupported platform for opening browser");
        process.exit(1);
      }

      exec(openCommand, (error) => {
        if (error) {
          console.error("Failed to open browser:", error.message);
          process.exit(1);
        }
      });
      break;
    case "-v":
    case "version":
      console.log(`claude-code-router version: ${version}`);
      break;
    case "restart":
      await restartService();
      break;
    case "-h":
    case "help":
      console.log(HELP_TEXT);
      break;
    default:
      console.log(HELP_TEXT);
      process.exit(1);
  }
}

main().catch(console.error);

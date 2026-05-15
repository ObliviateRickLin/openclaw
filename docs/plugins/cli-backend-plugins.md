---
summary: "Build a plugin that registers a local AI CLI backend"
title: "Building CLI backend plugins"
sidebarTitle: "CLI backend plugins"
doc-schema-version: 1
read_when:
  - You are building a local AI CLI backend plugin
  - You want to register a backend for model refs such as acme-cli/model
  - You need to map a third-party CLI into OpenClaw's text fallback runner
---

CLI backend plugins let OpenClaw call a local AI CLI as a text inference
backend. The backend appears as a provider prefix in model refs:

```text
acme-cli/acme-large
```

Use a CLI backend when the upstream integration already exists as a local
command, the CLI owns local login state, or the CLI is a useful fallback if API
providers are unavailable.

If the upstream service exposes a normal HTTP model API, build a
[provider plugin](/plugins/sdk-provider-plugins). If the upstream runtime owns
agent sessions, tool events, compaction, or background task state, use an
[agent harness](/plugins/sdk-agent-harness).

## What the plugin owns

| Contract             | File                   | Purpose                                                   |
| -------------------- | ---------------------- | --------------------------------------------------------- |
| Package entry        | `package.json`         | Points OpenClaw at the plugin runtime module              |
| Manifest ownership   | `openclaw.plugin.json` | Declares the backend id before runtime loads              |
| Runtime registration | `index.ts`             | Calls `api.registerCliBackend(...)` with command defaults |

The manifest is discovery metadata. It does not execute the CLI and does not
register runtime behavior. Runtime behavior starts when the plugin entry calls
`api.registerCliBackend(...)`.

## Build the backend

<Steps>
  <Step title="Create package metadata">
    ```json package.json
    {
      "name": "@acme/openclaw-acme-cli",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "compat": {
          "pluginApi": ">=2026.3.24-beta.2",
          "minGatewayVersion": "2026.3.24-beta.2"
        },
        "build": {
          "openclawVersion": "2026.3.24-beta.2",
          "pluginSdkVersion": "2026.3.24-beta.2"
        }
      },
      "dependencies": {
        "openclaw": "^2026.3.24"
      },
      "devDependencies": {
        "typescript": "^5.9.0"
      }
    }
    ```

    Published packages must ship built JavaScript runtime files. If the source
    entry is `./src/index.ts`, add `openclaw.runtimeExtensions` that points at
    the built JavaScript peer. See [SDK entry points](/plugins/sdk-entrypoints).

  </Step>

  <Step title="Declare backend ownership">
    ```json openclaw.plugin.json
    {
      "id": "acme-cli",
      "name": "Acme CLI",
      "description": "Run Acme's local AI CLI through OpenClaw",
      "cliBackends": ["acme-cli"],
      "setup": {
        "cliBackends": ["acme-cli"],
        "requiresRuntime": false
      },
      "activation": {
        "onStartup": false
      },
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```

    `cliBackends` is the runtime ownership list. It lets OpenClaw auto-load the
    plugin when config or model selection mentions `acme-cli/...`.

    `setup.cliBackends` is the descriptor-first setup surface. Add it when
    model discovery, onboarding, or status should recognize the backend without
    loading the plugin runtime. Use `requiresRuntime: false` only when static
    descriptors are enough for setup.

  </Step>

  <Step title="Register the backend">
    ```typescript index.ts
    import {
      CLI_FRESH_WATCHDOG_DEFAULTS,
      CLI_RESUME_WATCHDOG_DEFAULTS,
      type CliBackendPlugin,
    } from "openclaw/plugin-sdk/cli-backend";
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

    function buildAcmeCliBackend(): CliBackendPlugin {
      return {
        id: "acme-cli",
        liveTest: {
          defaultModelRef: "acme-cli/acme-large",
          defaultImageProbe: false,
          defaultMcpProbe: false,
          docker: {
            npmPackage: "@acme/acme-cli",
            binaryName: "acme",
          },
        },
        config: {
          command: "acme",
          args: ["chat", "--json"],
          output: "json",
          input: "stdin",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptFileArg: "--system-file",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          reliability: {
            watchdog: {
              fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
              resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
            },
          },
          serialize: true,
        },
      };
    }

    export default definePluginEntry({
      id: "acme-cli",
      name: "Acme CLI",
      description: "Run Acme's local AI CLI through OpenClaw",
      register(api) {
        api.registerCliBackend(buildAcmeCliBackend());
      },
    });
    ```

    The backend id must match the manifest `cliBackends` entry. The registered
    `config` is the default; user config under
    `agents.defaults.cliBackends.acme-cli` is merged over it at runtime.

  </Step>
</Steps>

## Keep the config small

`CliBackendConfig` tells OpenClaw how to launch the CLI, pass prompts and
models, parse output, resume sessions, pass images, and apply reliability
watchdogs. Start with the smallest static config that matches the CLI.

Common fields include:

- `command` and `args` for fresh runs.
- `resumeArgs`, `sessionArg`, `sessionArgs`, `sessionMode`, and
  `sessionIdFields` for session reuse. `resumeArgs` supports `{sessionId}` as a
  placeholder for the OpenClaw session id.
- `output` and `resumeOutput` for `json`, `jsonl`, or `text` parsing.
- `input`, `modelArg`, `systemPromptArg`, and `systemPromptFileArg` for prompt
  transport.
- `imageArg` and `imageMode` for image paths.
- `modelAliases` to map OpenClaw model ids to CLI-native model ids.
- `sessionMode` to choose `always`, `existing`, or `none` session behavior.
- `systemPromptWhen` to choose whether OpenClaw passes a system prompt on the
  `first`, `always`, or `never` execution.
- `serialize` and `reliability.watchdog` for ordering and no-output timeout
  behavior.

Use plugin callbacks only for behavior that belongs to the backend:

| Callback or field                  | Use                                                   |
| ---------------------------------- | ----------------------------------------------------- |
| `normalizeConfig(config, context)` | Rewrite legacy user config after merge                |
| `resolveExecutionArgs(ctx)`        | Add request-scoped flags such as thinking effort      |
| `prepareExecution(ctx)`            | Create temporary auth or config bridges before launch |
| `transformSystemPrompt(ctx)`       | Apply a final CLI-specific system-prompt transform    |
| `textTransforms`                   | Bidirectional prompt and output replacements          |
| `defaultAuthProfileId`             | Prefer a specific OpenClaw auth profile               |
| `authEpochMode`                    | Decide how auth changes invalidate stored sessions    |
| `nativeToolMode`                   | Declare whether the CLI has always-on native tools    |
| `bundleMcp` and `bundleMcpMode`    | Opt into OpenClaw's loopback MCP tool bridge          |

See [SDK overview](/plugins/sdk-overview) for the registration API and
[CLI backends](/gateway/cli-backends) for user-facing runtime config.
When a backend hook can express CLI-specific behavior, keep that behavior in the
provider-owned backend hook instead of adding CLI-specific branches to core.

## Enable the MCP tool bridge

CLI backends do not receive OpenClaw tools by default. If the CLI can consume
an MCP configuration, opt in explicitly:

```typescript
return {
  id: "acme-cli",
  bundleMcp: true,
  bundleMcpMode: "codex-config-overrides",
  config: {
    command: "acme",
    args: ["chat", "--json"],
    output: "json",
  },
};
```

Only enable the bridge when the CLI can actually consume it. If the CLI has an
always-on native tool layer that cannot be disabled, set
`nativeToolMode: "always-on"` so OpenClaw can fail closed when a caller
requires no native tools.

`bundleMcpMode` tells OpenClaw how to expose the loopback MCP bridge:

| Mode                     | Use                                                              |
| ------------------------ | ---------------------------------------------------------------- |
| `claude-config-file`     | CLIs that accept an MCP config file                              |
| `codex-config-overrides` | CLIs that accept config overrides on argv                        |
| `gemini-system-settings` | CLIs that read MCP settings from their system settings directory |

## Document user overrides

Users can override backend defaults:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "acme-cli": {
          command: "/opt/acme/bin/acme",
          args: ["chat", "--json", "--profile", "work"],
          modelAliases: {
            large: "acme-large-2026",
          },
        },
      },
      model: {
        primary: "openai/gpt-5.5",
        fallbacks: ["acme-cli/large"],
      },
    },
  },
}
```

Document only the overrides users are likely to need. Most backends need to
document `command` when the binary is outside `PATH`, plus any required login
or profile flags.

## Verify the backend

For bundled plugins, add a focused test around the builder and setup
registration, then run the plugin's targeted test lane:

```bash
pnpm test extensions/acme-cli
```

For local or installed plugins, verify discovery and one real model run:

```bash
openclaw plugins inspect acme-cli --runtime --json
openclaw agent --message "reply exactly: backend ok" --model acme-cli/acme-large
```

If the backend supports images or MCP, add a live smoke that proves those paths
with the real CLI. Do not rely on static inspection for prompt, image, MCP, or
session-resume behavior.

## Checklist

<Check>`package.json` has `openclaw.extensions` and built runtime entries for published packages</Check>
<Check>`openclaw.plugin.json` declares `cliBackends` and intentional `activation.onStartup`</Check>
<Check>`setup.cliBackends` is present when setup/model discovery should see the backend cold</Check>
<Check>`api.registerCliBackend(...)` uses the same backend id as the manifest</Check>
<Check>User overrides under `agents.defaults.cliBackends.<id>` still win</Check>
<Check>Session, system prompt, image, MCP, and output parser settings match the real CLI contract</Check>
<Check>Targeted tests and at least one live CLI smoke prove the backend path</Check>

## Related

- [CLI backends](/gateway/cli-backends)
- [Building plugins](/plugins/building-plugins)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin manifest](/plugins/manifest)
- [SDK entry points](/plugins/sdk-entrypoints)
- [Agent harness plugins](/plugins/sdk-agent-harness)

---
summary: "Create your first OpenClaw plugin in minutes"
title: "Building plugins"
sidebarTitle: "Getting Started"
doc-schema-version: 1
read_when:
  - You want to create a new OpenClaw plugin
  - You need a quick-start for plugin development
  - You are choosing between channel, provider, CLI backend, tool, hook, or capability docs
---

Plugins extend OpenClaw without changing core. A plugin can add a messaging
channel, model provider, local CLI backend, agent tool, hook, media provider,
or another shared capability.

You do not need to add an external plugin to the OpenClaw repository. Publish
the package to [ClawHub](/clawhub) and users install it with:

```bash
openclaw plugins install clawhub:<package-name>
```

Bare package specs still install from npm during the launch cutover. Use the
`clawhub:` prefix when you want ClawHub resolution.

## Requirements

- Use Node 22 or newer.
- Use TypeScript with ESM modules.
- Have a package manager available. External plugin examples work with `npm`
  or `pnpm`; source-checkout bundled plugin work uses `pnpm`.
- For in-repo bundled plugin work, run `pnpm install` first. Source-checkout
  plugin development is pnpm-only because OpenClaw loads bundled plugins from
  `extensions/*` workspace packages and discovers those bundled plugin packages
  automatically.
- For an external plugin, ship built JavaScript entry points in your published
  package.

## Choose the plugin shape

<CardGroup cols={3}>
  <Card title="Channel plugin" icon="messages-square" href="/plugins/sdk-channel-plugins">
    Connect OpenClaw to a messaging platform.
  </Card>
  <Card title="Provider plugin" icon="cpu" href="/plugins/sdk-provider-plugins">
    Add a model, media, search, fetch, speech, or realtime provider.
  </Card>
  <Card title="CLI backend plugin" icon="terminal" href="/plugins/cli-backend-plugins">
    Run a local AI CLI through OpenClaw model fallback.
  </Card>
  <Card title="Tool or hook plugin" icon="wrench" href="/plugins/hooks">
    Register agent tools, policy hooks, delivery hooks, or lifecycle hooks.
  </Card>
  <Card title="New core capability" icon="layers" href="/plugins/adding-capabilities">
    Add a shared capability contract as an OpenClaw contributor.
  </Card>
</CardGroup>

Use one package per ownership boundary. A company plugin can register multiple
capabilities for the same vendor, but a shared OpenClaw capability should live
behind a generic contract before channels or tools consume it directly.

## Build a minimal tool plugin

This example registers one required agent tool. It is the shortest useful
plugin shape and shows the package, manifest, entry point, and local proof.

<Steps>
  <Step title="Create package metadata">
    ```json package.json
    {
      "name": "@myorg/openclaw-my-plugin",
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
      }
    }
    ```

    Published external plugins should point runtime entries at built JavaScript
    files. See [SDK entry points](/plugins/sdk-entrypoints) for the full entry
    point contract.

  </Step>

  <Step title="Add the plugin manifest">
    ```json openclaw.plugin.json
    {
      "id": "my-plugin",
      "name": "My Plugin",
      "description": "Adds a custom tool to OpenClaw",
      "contracts": {
        "tools": ["my_tool"]
      },
      "activation": {
        "onStartup": true
      },
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```

    Every plugin needs a manifest, even when it has no config. Runtime tools
    must appear in `contracts.tools` so OpenClaw can discover ownership without
    eagerly loading every plugin runtime. Set `activation.onStartup`
    intentionally. This example starts on Gateway startup.

    For every manifest field, see [Plugin manifest](/plugins/manifest).

  </Step>

  <Step title="Register the tool">
    ```typescript index.ts
    import { Type } from "@sinclair/typebox";
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

    export default definePluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      description: "Adds a custom tool to OpenClaw",
      register(api) {
        api.registerTool({
          name: "my_tool",
          description: "Echo one input value",
          parameters: Type.Object({ input: Type.String() }),
          async execute(_id, params) {
            return {
              content: [{ type: "text", text: `Got: ${params.input}` }],
            };
          },
        });
      },
    });
    ```

    Use `definePluginEntry` for non-channel plugins. Channel plugins use
    `defineChannelPluginEntry`; setup-only entry points use
    `defineSetupPluginEntry`.

  </Step>

  <Step title="Test the runtime">
    For an installed or external plugin, inspect the loaded runtime:

    ```bash
    openclaw plugins inspect my-plugin --runtime --json
    ```

    If the plugin registers a CLI command, run that command too. For example,
    a demo command should have an execution proof such as
    `openclaw demo-plugin ping`.

    For a bundled plugin in this repository, run the closest targeted test:

    ```bash
    pnpm test -- extensions/my-plugin/
    pnpm check
    ```

  </Step>

  <Step title="Publish">
    Validate the package before publishing:

    ```bash
    clawhub package publish your-org/your-plugin --dry-run
    clawhub package publish your-org/your-plugin
    ```

    The canonical ClawHub snippets live in `docs/snippets/plugin-publish/`.

  </Step>
</Steps>

## Register optional tools

Tools can be required or optional. Required tools are always available when the
plugin is enabled. Optional tools require user opt-in.

```typescript
register(api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a workflow",
      parameters: Type.Object({ pipeline: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

Declare optional tools in the manifest too:

```json
{
  "contracts": {
    "tools": ["workflow_tool"]
  },
  "toolMetadata": {
    "workflow_tool": {
      "optional": true
    }
  }
}
```

Users opt in with `tools.allow`:

```json5
{
  tools: { allow: ["workflow_tool"] }, // or ["my-plugin"] for all tools from one plugin
}
```

Use optional tools for side effects, unusual binaries, or capabilities that
should not be exposed by default. Tool names must not conflict with core tools;
conflicts are skipped and reported in plugin diagnostics. Malformed
registrations, including tool descriptors without `parameters`, are skipped and
reported the same way. Registered tools are typed functions the model can call
after policy and allowlist checks pass.

Tool factories receive a runtime-supplied context object. Use `ctx.activeModel`
when a tool needs to log, display, or adapt to the active model for the current
turn. The object can include `provider`, `modelId`, and `modelRef`. Treat it as
informational runtime metadata, not as a security boundary against the local
operator, installed plugin code, or a modified OpenClaw runtime. Sensitive local
tools should still require an explicit plugin or operator opt-in and fail closed
when active-model metadata is missing or unsuitable.

OpenClaw captures and caches the validated descriptor from the registered tool,
so plugins do not duplicate `description` or schema data in the manifest. The
manifest declares ownership and discovery; execution still calls the live
registered tool implementation. Keep `toolMetadata.<tool>.optional: true`
aligned with `api.registerTool(..., { optional: true })` so OpenClaw can avoid
loading that plugin runtime until the tool is explicitly allowlisted.

## Keep imports narrow

Import from focused SDK subpaths:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
```

Do not import from the deprecated root barrel:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk";
```

Within your plugin package, use local barrel files such as `api.ts` and
`runtime-api.ts` for internal imports. Do not import your own plugin through an
SDK path. Provider-specific helpers should stay in the provider package unless
the seam is truly generic.

Custom Gateway RPC methods are an advanced entry point. Keep them on a
plugin-specific prefix; core admin namespaces such as `config.*`,
`exec.approvals.*`, `operator.admin.*`, `wizard.*`, and `update.*` stay reserved
and resolve to `operator.admin`. The
`openclaw/plugin-sdk/gateway-method-runtime` bridge is reserved for plugin HTTP
routes that declare `contracts.gatewayMethodDispatch: ["authenticated-request"]`.

For the full import map, see [Plugin SDK overview](/plugins/sdk-overview).

## Pre-submission checklist

<Check>`package.json` has `openclaw` metadata and published runtime entries</Check>
<Check>`openclaw.plugin.json` exists, validates, and declares ownership contracts</Check>
<Check>The entry point uses `definePluginEntry` or `defineChannelPluginEntry`</Check>
<Check>Runtime registrations match manifest ownership ids</Check>
<Check>Imports use focused `openclaw/plugin-sdk/<subpath>` paths</Check>
<Check>Optional tools are marked in both runtime registration and manifest metadata</Check>
<Check>Targeted tests or a real installed-plugin smoke prove the plugin loads</Check>

## Test against beta releases

When beta tags appear on
[openclaw/openclaw releases](https://github.com/openclaw/openclaw/releases),
test plugins quickly. Beta tags use the shape `v2026.3.N-beta.1`. You can
subscribe through GitHub `Watch` > `Releases`; release announcements can also
appear on the official OpenClaw X account, [@openclaw](https://x.com/openclaw).

After testing, post in your plugin's thread in the `plugin-forum` Discord
channel with either `all good` or what broke. If a beta breaks your plugin, open
or update an issue titled `Beta blocker: <plugin-name> - <summary>` and apply
the `beta-blocker` label when you have permission. Open a PR to `main` titled
`fix(<plugin-id>): beta blocker - <summary>`, then link the issue and PR from
the plugin thread. Contributors cannot label PRs, so the title is the PR-side
signal for maintainers and automation. Blockers with a PR get merged; blockers
without one might ship anyway. Silence means green, and fixes that miss the beta
window likely land in the next cycle.

## Related

- [Building channel plugins](/plugins/sdk-channel-plugins)
- [Building provider plugins](/plugins/sdk-provider-plugins)
- [Building CLI backend plugins](/plugins/cli-backend-plugins)
- [Plugin hooks](/plugins/hooks)
- [Adding capabilities](/plugins/adding-capabilities)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Runtime helpers](/plugins/sdk-runtime)
- [Plugin manifest](/plugins/manifest)
- [Plugin architecture](/plugins/architecture)
- [SDK testing](/plugins/sdk-testing)

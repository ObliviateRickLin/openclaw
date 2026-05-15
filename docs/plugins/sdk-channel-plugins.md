---
summary: "Build a messaging channel plugin for OpenClaw"
title: "Building channel plugins"
sidebarTitle: "Channel plugins"
doc-schema-version: 1
read_when:
  - You are building a new messaging channel plugin
  - You want to connect OpenClaw to a messaging platform
  - You need the first workflow before reading the channel SDK references
---

This guide builds one messaging channel plugin. By the end, the plugin has
manifest metadata, channel config, a setup-safe entry, outbound delivery,
inbound dispatch, and a targeted test.

If you have not built any OpenClaw plugin before, start with
[Building plugins](/plugins/building-plugins) for the package and manifest
basics.

## What a channel plugin owns

Core keeps one shared `message` tool and the outer session-key shape. The
channel plugin owns the platform-specific facts:

| Area               | Plugin responsibility                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| Config and setup   | Account resolution, setup-safe metadata, status, and secret targets                 |
| Security           | DM policy, allowlists, pairing, and platform-specific sender facts                  |
| Inbound routing    | Webhook or listener receive path, mention evidence, route facts, and turn admission |
| Outbound delivery  | Text, media, polls, threading, receipts, and platform-specific payload shaping      |
| Optional native UX | Typing indicators, live preview, native approval surfaces, buttons, or reactions    |

Use the shared SDK helpers for the common path. Reach for lower-level
interfaces only when the platform needs behavior the builders cannot express.

## Build the channel

<Steps>
  <Step title="Create package and manifest metadata">
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-chat",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "setupEntry": "./setup-entry.ts",
        "channel": {
          "id": "acme-chat",
          "label": "Acme Chat",
          "blurb": "Connect OpenClaw to Acme Chat."
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-chat",
      "kind": "channel",
      "channels": ["acme-chat"],
      "name": "Acme Chat",
      "description": "Acme Chat channel plugin",
      "configSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "channelConfigs": {
        "acme-chat": {
          "schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "token": { "type": "string" },
              "allowFrom": {
                "type": "array",
                "items": { "type": "string" }
              }
            }
          },
          "uiHints": {
            "token": {
              "label": "Bot token",
              "sensitive": true
            }
          }
        }
      }
    }
    ```

    `configSchema` validates `plugins.entries.acme-chat.config`.
    `channelConfigs` validates `channels.acme-chat` and is the cold-path source
    for config schema, setup, and UI surfaces before the full channel runtime
    loads.

    If a channel is optional during onboarding, use
    `createOptionalChannelSetupSurface(...)` from
    `openclaw/plugin-sdk/channel-setup` so setup surfaces advertise the install
    requirement and fail closed on real config writes until the plugin exists.

  </Step>

  <Step title="Build the channel plugin object">
    Start with `createChatChannelPlugin(...)` and add adapters as the platform
    needs them.

    ```typescript src/channel.ts
    import {
      createChannelPluginBase,
      createChatChannelPlugin,
      type OpenClawConfig,
    } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatApi } from "./client.js";

    type ResolvedAccount = {
      accountId: string | null;
      token: string;
      allowFrom: string[];
      dmPolicy: string | undefined;
    };

    type AcmeChannelConfig = {
      token?: string;
      allowFrom?: string[];
      dmSecurity?: string;
    };

    function readChannelConfig(cfg: OpenClawConfig): AcmeChannelConfig {
      return (
        (cfg.channels as Record<string, AcmeChannelConfig | undefined>)?.[
          "acme-chat"
        ] ?? {}
      );
    }

    function resolveAccount(
      cfg: OpenClawConfig,
      accountId?: string | null,
    ): ResolvedAccount {
      const section = readChannelConfig(cfg);
      const token = section?.token;
      if (!token) throw new Error("acme-chat: token is required");
      return {
        accountId: accountId ?? null,
        token,
        allowFrom: section?.allowFrom ?? [],
        dmPolicy: section?.dmSecurity,
      };
    }

    export const acmeChatPlugin = createChatChannelPlugin<ResolvedAccount>({
      base: createChannelPluginBase({
        id: "acme-chat",
        config: {
          listAccountIds(cfg) {
            return readChannelConfig(cfg).token ? ["default"] : [];
          },
          resolveAccount,
          inspectAccount(cfg, accountId) {
            const section = readChannelConfig(cfg);
            return {
              enabled: Boolean(section?.token),
              configured: Boolean(section?.token),
              tokenStatus: section?.token ? "available" : "missing",
            };
          },
        },
        setup: {
          applyAccountConfig({ cfg, input }) {
            return {
              ...cfg,
              channels: {
                ...(cfg.channels as Record<string, unknown>),
                "acme-chat": {
                  ...readChannelConfig(cfg),
                  token: String(input.token ?? ""),
                },
              },
            };
          },
        },
      }),
      security: {
        dm: {
          channelKey: "acme-chat",
          resolvePolicy: (account) => account.dmPolicy,
          resolveAllowFrom: (account) => account.allowFrom,
          defaultPolicy: "allowlist",
        },
      },
      pairing: {
        text: {
          idLabel: "Acme Chat username",
          message: "Send this code to verify your identity:",
          notify: async ({ target, code }) => {
            await acmeChatApi.sendDm(target, `Pairing code: ${code}`);
          },
        },
      },
      threading: { topLevelReplyToMode: "reply" },
      outbound: {
        attachedResults: {
          sendText: async (params) => {
            const result = await acmeChatApi.sendMessage(
              params.to,
              params.text,
            );
            return { messageId: result.id };
          },
        },
        base: {
          sendMedia: async (params) => {
            await acmeChatApi.sendFile(params.to, params.filePath);
          },
        },
      },
    });
    ```

    The builder composes DM security, pairing, threading, and outbound adapter
    surfaces. Raw adapters are still available when the platform needs full
    control. For threading, target parsing, receipts, live preview, and receive
    acknowledgement contracts, use the references linked below instead of
    hand-rolling those details in the guide.

  </Step>

  <Step title="Wire entry points">
    ```typescript index.ts
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineChannelPluginEntry({
      id: "acme-chat",
      name: "Acme Chat",
      description: "Acme Chat channel plugin",
      plugin: acmeChatPlugin,
      registerCliMetadata(api) {
        api.registerCli(
          ({ program }) => {
            program
              .command("acme-chat")
              .description("Acme Chat management");
          },
          {
            descriptors: [
              {
                name: "acme-chat",
                description: "Acme Chat management",
                hasSubcommands: false,
              },
            ],
          },
        );
      },
      registerFull(api) {
        api.registerGatewayMethod(/* ... */);
      },
    });
    ```

    Put channel-owned CLI descriptors in `registerCliMetadata(...)` so root
    help can see them without activating the full channel runtime. Keep
    runtime-only work in `registerFull(...)`. If `registerFull(...)` registers
    Gateway RPC methods, use a plugin-specific prefix. Core admin namespaces
    such as `config.*`, `exec.approvals.*`, `operator.admin.*`, `wizard.*`, and
    `update.*` stay reserved.

    Add a setup entry for lightweight onboarding and status paths:

    ```typescript setup-entry.ts
    import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineSetupPluginEntry(acmeChatPlugin);
    ```

    See [SDK entry points](/plugins/sdk-entrypoints) and
    [SDK setup](/plugins/sdk-setup) for the exhaustive entry and setup
    contracts.

  </Step>

  <Step title="Receive inbound messages">
    Channel plugins own their inbound pipeline. A webhook channel usually
    verifies the request, normalizes the platform event, and dispatches through
    the plugin's inbound handler.

    ```typescript
    registerFull(api) {
      api.registerHttpRoute({
        path: "/acme-chat/webhook",
        auth: "plugin",
        handler: async (req, res) => {
          const event = parseWebhookPayload(req);
          await handleAcmeChatInbound(api, event);
          res.statusCode = 200;
          res.end("ok");
          return true;
        },
      });
    }
    ```

    Gather platform-specific facts locally: sender id, group state, explicit
    mentions, reply-to-bot evidence, quoted-bot evidence, thread ids, and
    command bypass facts. Use shared channel SDK helpers for mention policy and
    route normalization when possible.

  </Step>

  <Step title="Test the channel">
    ```typescript src/channel.test.ts
    import { describe, expect, it } from "vitest";
    import { acmeChatPlugin } from "./channel.js";

    describe("acme-chat plugin", () => {
      it("resolves account config", () => {
        const cfg = {
          channels: {
            "acme-chat": { token: "test-token", allowFrom: ["user1"] },
          },
        } as any;
        const account = acmeChatPlugin.config.resolveAccount(cfg, undefined);
        expect(account.token).toBe("test-token");
      });

      it("inspects account without materializing secrets", () => {
        const cfg = { channels: { "acme-chat": { token: "test-token" } } } as any;
        const result = acmeChatPlugin.config.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(true);
        expect(result.tokenStatus).toBe("available");
      });
    });
    ```

    ```bash
    pnpm test -- extensions/acme-chat/
    ```

    Add live or contract tests for any declared native side effect, such as
    message receipts, live preview finalization, deferred acknowledgements, or
    native approvals.

  </Step>
</Steps>

## File structure

```text
extensions/acme-chat/
├── package.json
├── openclaw.plugin.json
├── index.ts
├── setup-entry.ts
├── api.ts
├── runtime-api.ts
└── src/
    ├── channel.ts
    ├── channel.test.ts
    ├── client.ts
    └── runtime.ts
```

## Add advanced channel behavior

Use the focused reference pages when the channel needs deeper surfaces:

| Need                                                        | Go to                                               |
| ----------------------------------------------------------- | --------------------------------------------------- |
| Message adapter, receipts, live preview, receive ack policy | [Channel message API](/plugins/sdk-channel-message) |
| Shared inbound turn lifecycle                               | [Channel turn kernel](/plugins/sdk-channel-turn)    |
| Route, sender, command, access, and activation decisions    | [Channel ingress API](/plugins/sdk-channel-ingress) |
| Setup entries, config schemas, and setup-safe metadata      | [SDK setup](/plugins/sdk-setup)                     |
| Runtime helpers, TTS, search, media, subagents              | [SDK runtime](/plugins/sdk-runtime)                 |
| Channel target resolution and Gateway HTTP routes           | [Plugin internals](/plugins/architecture-internals) |
| Native approval helpers and hook semantics                  | [Plugin hooks](/plugins/hooks)                      |

Do not add new core special cases for one channel. Move platform-specific
parsing, target normalization, media parameters, native approval facts, or
message payload shaping behind the channel plugin surface.

### Message and live-preview details

New channel plugins should expose a `message` adapter with
`defineChannelMessageAdapter` from `openclaw/plugin-sdk/channel-message`.
Declare only capabilities backed by contract tests. Send methods should return
`MessageReceipt` values; compatibility code can derive legacy ids with
`listMessageReceiptPlatformIds(...)` or `resolveMessageReceiptPrimaryId(...)`.
If the existing `outbound` adapter already has the right send methods and
capability metadata, use `createChannelMessageAdapterFromOutbound(...)` to
derive the `message` adapter instead of hand-writing another bridge. For the
complete contract, examples, capability matrix, receipt rules, live preview
finalization, receive ack policy, tests, and migration table, see
[Channel message API](/plugins/sdk-channel-message).

Preview-capable channels declare `message.live.capabilities` for the lifecycle
they own, such as `draftPreview`, `previewFinalization`, `progressUpdates`,
`nativeStreaming`, or `quietFinalization`. Channels that finalize a draft
preview in place also declare `message.live.finalizer.capabilities`, such as
`finalEdit`, `normalFallback`, `discardPending`, `previewReceipt`, and
`retainOnAmbiguousFailure`, and route runtime logic through
`defineFinalizableLivePreviewAdapter(...)` plus
`deliverWithFinalizableLivePreviewAdapter(...)`. Back these claims with
`verifyChannelMessageLiveCapabilityAdapterProofs(...)` and
`verifyChannelMessageLiveFinalizerProofs(...)`.

Inbound receivers that defer platform acknowledgement declare
`message.receive.defaultAckPolicy` and `supportedAckPolicies`; cover every
declared policy with `verifyChannelMessageReceiveAckPolicyAdapterProofs(...)`.
Channels with typing indicators outside inbound replies expose
`heartbeat.sendTyping(...)`, and platforms that require an explicit stop signal
also expose `heartbeat.clearTyping(...)`.

### Channel-owned routing details

If a message tool action accepts media-source params, expose those names through
`describeMessageTool(...).mediaSourceParams`. Prefer an action-keyed map such as
`{ "set-profile": ["avatarUrl", "avatarPath"] }`; use a flat array only for
params intentionally shared by every exposed action. Keep sandbox path
normalization, outbound media-access policy, and runtime media checks in the
channel or `outbound-media-runtime` helper; do not add new core special cases for
one channel's media params.

If a message tool action needs channel-specific payload shaping, implement
`actions.prepareSendPayload(...)`. Put channel-specific data under
`payload.channelData.<channel>`; core still owns the actual shared `message` tool
send. `actions.handleAction(...)` remains a compatibility fallback for older
action handlers.

If the platform stores extra scope inside conversation ids, keep parsing in the
plugin with `messaging.resolveSessionConversation(...)`. The hook maps `rawId`
to the base conversation id, optional thread id, explicit `baseConversationId`,
and ordered `parentConversationCandidates`, from narrowest parent to broadest
base conversation. Bundled plugins that need bootstrap-safe parsing before the
channel registry starts can also expose `session-key-api.ts` with a matching
`resolveSessionConversation(...)` export. The legacy
`messaging.resolveParentConversationCandidates(...)` fallback remains available;
core prefers `resolveSessionConversation(...).parentConversationCandidates` when
both hooks exist.

Use `channel-route` helpers for stable comparison, dedupe keys, and
thread-aware target normalization. Routes should normalize numeric thread ids
before matching. If a plugin has a richer target grammar, adapt it with
`resolveChannelRouteTargetWithParser(...)`; parser-injected fallback candidates
should be ordered from most specific to broadest.

### Native approval details

Core owns same-chat `/approve`, shared approval button payloads, and generic
fallback delivery. Channel plugins that need approval-specific behavior expose
one `approvalCapability` object. `ChannelPlugin.approvals` has been removed, and
`plugin.auth` remains for login/logout only.

Use `approvalCapability.authorizeActorAction` and
`approvalCapability.getActionAvailabilityState` for same-chat approval auth.
Use `approvalCapability.getExecInitiatingSurfaceState` when native exec approval
availability differs from same-chat approval auth. Use
`approvalCapability.delivery` only for native approval routing or fallback
suppression, `approvalCapability.render` only for custom payloads, and
`approvalCapability.describeExecApprovalSetup` when the disabled-path reply
needs account-scoped config paths such as
`channels.<channel>.accounts.<id>.execApprovals.*`.
Use `outbound.shouldSuppressLocalPayloadPrompt` or
`outbound.beforeDeliverPayload` for channel-specific payload lifecycle behavior
such as hiding duplicate local approval prompts or sending typing indicators
before delivery.

For native approval delivery, keep channel code focused on target normalization,
transport, and presentation facts. Use `createChannelExecApprovalProfile`,
`createChannelNativeOriginTargetResolver`,
`createChannelApproverDmTargetResolver`, and
`createApproverRestrictedNativeApprovalCapability` from
`openclaw/plugin-sdk/approval-runtime`. Put channel-specific facts behind
`approvalCapability.nativeRuntime`, ideally via
`createChannelApprovalNativeRuntimeAdapter(...)` or
`createLazyChannelApprovalNativeRuntimeAdapter(...)`. Native approval channels
must route both `accountId` and `approvalKind`; `approvalKind` preserves exec vs
plugin approval behavior without hardcoded core branches. Core owns reroute
notices, so channel plugins should not post their own "approval went elsewhere"
follow-up messages.

Native approval runtime registration flows through `channel-runtime-context`.
The runtime owns origin target resolution, approver DM target resolution, action
auth, action availability, native render data, delivery or fallback suppression,
and disabled-path setup descriptions. Core owns the shared approval ids,
same-chat `/approve`, reroute notices, timeout handling, and plugin-vs-exec
approval kind semantics.

`createChannelNativeOriginTargetResolver` uses the shared channel-route matcher
for `{ to, accountId, threadId }` targets by default. Pass `targetsMatch` only
for provider-specific equivalence rules such as Slack timestamp-prefix matching.
Pass `normalizeTargetForMatch` when matching needs canonical provider ids while
delivery should preserve the original target. Use `normalizeTarget` only when
the resolved delivery target itself should be canonicalized. If the channel can
infer stable owner-like DM identities from config, use
`createResolvedApproverActionAuthAdapter` from
`openclaw/plugin-sdk/approval-runtime` for same-chat `/approve` auth. Reach for
lower-level `createChannelApprovalHandler` or
`createChannelNativeApprovalRuntime` only when the capability-driven seam is not
expressive enough. `createApproverRestrictedNativeApprovalAdapter` remains as a
compatibility wrapper, but new code should prefer the capability builder.

Focused approval subpaths include `approval-auth-runtime`,
`approval-client-runtime`, `approval-delivery-runtime`,
`approval-gateway-runtime`, `approval-handler-adapter-runtime`,
`approval-handler-runtime`, `approval-native-runtime`, `approval-reply-runtime`,
and `channel-runtime-context`.

### Setup and adapter details

If the channel can appear in `status`, `channels list`, `channels status`, or
SecretRef scans before runtime startup, add `openclaw.setupEntry` in
`package.json`. That entrypoint must be safe to import in read-only command
paths and return setup-safe channel metadata, config adapter, status adapter,
and secret target metadata. Do not start clients, listeners, or transport
runtimes from the setup entry.

Setup tests should include the missing-config path. A setup entry must report
unconfigured or missing-secret status without throwing, starting clients, or
materializing secret values.

Keep the main channel entry narrow too. Discovery can evaluate the entry and
plugin module to register capabilities without activating the channel. Files
such as `channel-plugin-api.ts` should export the plugin object without
importing setup wizards, transport clients, socket listeners, subprocess
launchers, or service startup modules. Put runtime pieces behind
`registerFull(...)`, runtime setters, or lazy capability adapters.

Prefer focused imports such as `setup-runtime`, `reply-runtime`,
`reply-dispatch-runtime`, `reply-reference`, and `reply-chunking` when you do
not need the broader channel surface. Channel config helpers preserve
OpenClaw's precedence order: config file, account config, environment, and
channel defaults. Use `normalizeLegacyDmAliases` when migrating old direct-DM
aliases. Adapter builders can provide `chunker(text, limit, ctx)`,
`maxLinesPerMessage`, `replyToIdSource`, and `ctx.formatting` behavior so core
does not need channel-specific reply formatting branches.

Other focused channel helper families include:

| Helper family                                         | Use                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Account/config helpers                                | Named account config, account-scoped status, and account-specific setup paths        |
| `channel-inbound`, `channel-envelope`, dispatch paths | Inbound envelope formatting, receive dispatch, and compatibility receive adapters    |
| `channel-route`, `channel-targets`                    | Messaging target parsing, route comparison, and thread-aware target normalization    |
| `buildThreadAwareOutboundSessionRoute(...)`           | Outbound session routes that need thread recovery semantics                          |
| `thread-bindings-runtime`                             | Durable thread binding and recovery helpers                                          |
| `agent-media-payload`                                 | Agent media payload preparation for outbound channel sends                           |
| `outbound-media-runtime`                              | Runtime media access checks and outbound media policy                                |
| `telegram-command-config`                             | Telegram command config compatibility for maintained Telegram-family channel plugins |

When migrating older receive paths, `createChannelTurnReplyPipeline(...)`,
`dispatchInboundReplyWithBase(...)`, and
`recordInboundSessionAndDispatchReply(...)` are compatibility helpers. New
channel code should use a `message` adapter or the channel turn kernel so thread
bookkeeping and reply dispatch stay owned by the channel surface.

`openclaw/plugin-sdk/channel-ingress-runtime` owns the shared ingress decision
shape for route, sender, command, event, access, and activation decisions. Use it
to build redacted diagnostics, map turn-admission decisions, normalize platform
identity, and serialize raw match evidence without leaking secrets or
platform-specific objects.

Setup-safe helpers are intentionally split from channel runtimes:

| Helper or field                                                                 | Use                                                                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `createEnvPatchedAccountSetupAdapter(...)`                                      | Patch account setup from env-backed config without loading the full channel                                                |
| `noteChannelLookupFailure(...)` / `noteChannelLookupSummary(...)`               | Report lookup notes without exposing secrets                                                                               |
| `promptResolvedAllowFrom(...)`                                                  | Resolve allowlist entries during setup wizards                                                                             |
| `createAllowlistSetupWizardProxy(...)` / `createDelegatedSetupWizardProxy(...)` | Delegate setup wizard flows without importing transport clients                                                            |
| `createOptionalChannelSetupSurface(...)`                                        | Advertise optional install requirements and fail closed on config writes until the plugin is installed                     |
| `channelEnvVars`                                                                | Declare cheap env metadata for setup or auth discovery; runtime config still comes from `channels.<id>` and setup adapters |
| `defineBundledChannelSetupEntry(...)`                                           | Keep bundled channel setup entries lightweight, with optional setup-time runtime wiring through the bundled entry contract |

Channel setup writes must fail closed when required plugin code is not installed.
Do not let optional setup surfaces finalize config by relying on the package copy
that would normally run after install.

### Mention policy details

Channels should collect local evidence before calling shared mention helpers:
explicit mentions, reply-to-bot evidence, quoted-bot evidence, thread
participation, command bypass, sender facts, and service or system-account
exclusions. Bot participation caches are channel-owned evidence, not shared
policy.

Use `resolveInboundMentionDecision({ facts, policy })` through
`api.runtime.channel.mentions` or the focused `channel-inbound` /
`channel-mention-gating` SDK subpaths. The decision returns
`effectiveWasMentioned` and skip/bypass facts. In group contexts,
`requireMention` should skip only when the channel can detect mentions and no
explicit or implicit mention evidence is present. Commands can bypass mention
requirements when the channel has already authenticated the command sender.

## Related

- [Building plugins](/plugins/building-plugins)
- [Building provider plugins](/plugins/sdk-provider-plugins)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Plugin manifest](/plugins/manifest)
- [SDK testing](/plugins/sdk-testing)

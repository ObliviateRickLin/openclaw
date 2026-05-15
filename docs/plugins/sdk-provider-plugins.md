---
summary: "Build a model or media provider plugin for OpenClaw"
title: "Building provider plugins"
sidebarTitle: "Provider plugins"
doc-schema-version: 1
read_when:
  - You are building a new model provider plugin
  - You want to add an OpenAI-compatible proxy or custom LLM to OpenClaw
  - You need the first workflow before reading provider runtime references
---

Provider plugins add model, media, search, fetch, speech, or realtime provider
capabilities to OpenClaw. This guide builds a text model provider with API-key
auth, a model catalog, and dynamic model resolution.

If the upstream service runs through a native agent daemon that owns threads,
compaction, tool events, or background task state, pair the provider with an
[agent harness](/plugins/sdk-agent-harness) instead of putting daemon protocol
details in core.

## Build the provider

<Steps>
  <Step title="Create package and manifest metadata">
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-ai",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "providers": ["acme-ai"],
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

    ```json openclaw.plugin.json
    {
      "id": "acme-ai",
      "name": "Acme AI",
      "description": "Acme AI model provider",
      "providers": ["acme-ai"],
      "modelSupport": {
        "modelPrefixes": ["acme-"]
      },
      "providerAuthEnvVars": {
        "acme-ai": ["ACME_AI_API_KEY"]
      },
      "providerAuthAliases": {
        "acme-ai-coding": "acme-ai"
      },
      "providerAuthChoices": [
        {
          "provider": "acme-ai",
          "method": "api-key",
          "choiceId": "acme-ai-api-key",
          "choiceLabel": "Acme AI API key",
          "groupId": "acme-ai",
          "groupLabel": "Acme AI",
          "cliFlag": "--acme-ai-api-key",
          "cliOption": "--acme-ai-api-key <key>",
          "cliDescription": "Acme AI API key"
        }
      ],
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```

    `providerAuthEnvVars` lets OpenClaw detect credentials without loading the
    plugin runtime. `providerAuthAliases` lets a provider variant reuse another
    provider id's auth. `modelSupport` lets OpenClaw auto-load the plugin from
    shorthand model ids such as `acme-large` before runtime hooks exist.
    ClawHub-published provider packages must include both `openclaw.compat`
    and `openclaw.build` metadata so OpenClaw can reject incompatible plugin
    API or Gateway versions before loading runtime code.

  </Step>

  <Step title="Register a provider and catalog">
    ```typescript index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

    export default definePluginEntry({
      id: "acme-ai",
      name: "Acme AI",
      description: "Acme AI model provider",
      register(api) {
        api.registerProvider({
          id: "acme-ai",
          label: "Acme AI",
          docsPath: "/providers/acme-ai",
          envVars: ["ACME_AI_API_KEY"],
          auth: [
            createProviderApiKeyAuthMethod({
              providerId: "acme-ai",
              methodId: "api-key",
              label: "Acme AI API key",
              hint: "API key from your Acme AI dashboard",
              optionKey: "acmeAiApiKey",
              flagName: "--acme-ai-api-key",
              envVar: "ACME_AI_API_KEY",
              promptMessage: "Enter your Acme AI API key",
              defaultModel: "acme-ai/acme-large",
            }),
          ],
          catalog: {
            order: "simple",
            run: async (ctx) => {
              const apiKey = ctx.resolveProviderApiKey("acme-ai").apiKey;
              if (!apiKey) return null;
              return {
                provider: {
                  baseUrl: "https://api.acme-ai.com/v1",
                  apiKey,
                  api: "openai-completions",
                  models: [
                    {
                      id: "acme-large",
                      name: "Acme Large",
                      reasoning: true,
                      input: ["text", "image"],
                      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                      contextWindow: 200000,
                      maxTokens: 32768,
                    },
                  ],
                },
              };
            },
          },
        });

        api.registerModelCatalogProvider({
          provider: "acme-ai",
          kinds: ["text"],
          liveCatalog: async (ctx) => {
            const apiKey = ctx.resolveProviderApiKey("acme-ai").apiKey;
            if (!apiKey) return null;
            return [
              {
                kind: "text",
                provider: "acme-ai",
                model: "acme-large",
                label: "Acme Large",
                source: "live",
              },
            ];
          },
        });
      },
    });
    ```

    `registerProvider(...)` owns runtime inference configuration. The
    `catalog.run(...)` hook can call vendor APIs and returns
    `models.providers` entries.

    `registerModelCatalogProvider(...)` is the control-plane catalog surface
    used by list, help, and picker UI. Use it for text, image-generation,
    video-generation, and music-generation rows. Keep vendor endpoint calls and
    response mapping in the plugin.

    Provider auth choices can also drive onboarding. With the manifest above,
    `openclaw onboard --acme-ai-api-key <key>` can seed the API key and then
    let the user select `acme-ai/acme-large` as the default model.

  </Step>

  <Step title="Accept dynamic model ids">
    If the provider accepts arbitrary upstream model ids, add
    `resolveDynamicModel`.

    ```typescript
    api.registerProvider({
      id: "acme-ai",
      // auth and catalog omitted
      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        name: ctx.modelId,
        provider: "acme-ai",
        api: "openai-completions",
        baseUrl: "https://api.acme-ai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }),
    });
    ```

    If resolution needs a network call, use `prepareDynamicModel` for async
    warm-up. OpenClaw calls `resolveDynamicModel` again after warm-up finishes.

  </Step>

  <Step title="Add provider hooks only when needed">
    Most providers stop at `catalog` plus `resolveDynamicModel`. Add runtime
    hooks when the upstream provider needs token exchange, custom headers,
    transcript replay policy, stream wrapping, tool-schema cleanup, usage
    reporting, or failover classification.

    Shared family builders cover common replay, stream, and tool-compat
    patterns:

    ```typescript
    import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
    import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream";
    import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";

    api.registerProvider({
      id: "acme-gemini-compatible",
      // auth and catalog omitted
      ...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
      ...buildProviderStreamFamilyHooks("google-thinking"),
      ...buildProviderToolCompatFamilyHooks("gemini"),
    });
    ```

    For the full hook list, order, and bundled examples, see
    [Provider runtime hooks](/plugins/architecture-internals#provider-runtime-hooks).

    Use `api.registerTextTransforms(...)` only when a provider needs
    provider-owned text replacements. `input` transforms apply to system
    prompts and text message content before transport. `output` transforms
    apply to assistant text deltas or final text before OpenClaw handles
    control markers or channel delivery.

  </Step>

  <Step title="Test the provider">
    ```typescript src/provider.test.ts
    import { describe, expect, it } from "vitest";
    import { acmeProvider } from "./provider.js";

    describe("acme-ai provider", () => {
      it("resolves dynamic models", () => {
        const model = acmeProvider.resolveDynamicModel!({
          modelId: "acme-beta-v3",
        } as any);
        expect(model.id).toBe("acme-beta-v3");
        expect(model.provider).toBe("acme-ai");
      });

      it("returns null catalog without auth", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: undefined }),
        } as any);
        expect(result).toBeNull();
      });
    });
    ```

    Add a live smoke when a behavior depends on the real upstream API, such as
    model discovery, usage endpoints, custom transport headers, or media
    generation.

  </Step>
</Steps>

## Add non-text capabilities

A provider plugin can register speech, realtime transcription, realtime voice,
media understanding, image generation, music generation, video generation, web
fetch, and web search alongside text inference. Prefer one vendor-owned plugin
that registers the capabilities that vendor actually owns.

| Capability                  | Registration method                           |
| --------------------------- | --------------------------------------------- |
| Text inference              | `api.registerProvider(...)`                   |
| Control-plane model catalog | `api.registerModelCatalogProvider(...)`       |
| Speech                      | `api.registerSpeechProvider(...)`             |
| Realtime voice              | `api.registerRealtimeVoiceProvider(...)`      |
| Media understanding         | `api.registerMediaUnderstandingProvider(...)` |
| Image generation            | `api.registerImageGenerationProvider(...)`    |
| Video generation            | `api.registerVideoGenerationProvider(...)`    |
| Web fetch                   | `api.registerWebFetchProvider(...)`           |
| Web search                  | `api.registerWebSearchProvider(...)`          |

Keep capability-specific request normalization and vendor API calls in the
plugin. Core owns the shared runtime helper, fallback, config, and policy.

### Provider API details

Single-provider packages can use
`defineSingleProviderPluginEntry(...)` from `openclaw/plugin-sdk/provider-entry`
when the package owns one provider id and one plugin entry. Provider builders
such as `buildProvider(...)` and `buildStaticProvider(...)` are plugin-local
convenience helpers used by bundled provider packages; the public contract is
the registered provider object. Static providers should keep their model catalog
stable and local, while live catalogs belong in `catalog.run(...)` or
`registerModelCatalogProvider(...)`.

Use provider setup and onboarding helpers only for provider-owned auth/config
patching. `plugin-sdk/provider-onboard` owns onboarding config patch helpers,
and `plugin-sdk/provider-auth` / `provider-auth-api-key` own API-key profile
writes. `plugin-sdk/provider-catalog-shared` contains catalog helpers such as
`buildSingleProviderApiKeyCatalog`, `buildManifestModelProviderConfig`,
`supportsNativeStreamingUsageCompat`, and
`applyProviderNativeStreamingUsageCompat`. `models list --all` can execute
static catalogs for bundled provider plugins when config/env and agent/workspace
paths are empty, so static catalog callbacks should stay deterministic and avoid
network calls. Native streaming usage compatibility is applied only when the
endpoint capability map says the provider/base URL supports it; custom provider
ids must pass through the same capability check instead of assuming
OpenAI-compatible behavior. Preset helpers such as
`createDefaultModelPresetAppliers(...)`,
`createDefaultModelsPresetAppliers(...)`, and
`createModelCatalogPresetAppliers(...)` keep provider-owned default model
presets out of core.

Provider runtime hooks are intentionally family-oriented. Replay behavior uses
`buildProviderReplayFamilyHooks(...)`; stream behavior uses
`buildProviderStreamFamilyHooks(...)`; tool-schema compatibility uses
`buildProviderToolCompatFamilyHooks(...)`. Use
`resolveSystemPromptContribution` only when a provider family owns an additional
system-prompt contribution and preserve OpenClaw's stable/dynamic prompt-cache
split instead of replacing the whole system prompt. Use `plugin-sdk/provider-http`
for guarded provider HTTP calls, endpoint capability helpers, provider HTTP
errors, and audio transcription multipart helpers such as
`assertOkOrThrowProviderError(...)` and `buildAudioTranscriptionFormData(...)`.

Replay families include `openai-compatible`, `anthropic-by-model`,
`native-anthropic-by-model`, `google-gemini`, `passthrough-gemini`, and
`hybrid-anthropic-openai`. They set replay policy, replay-history sanitization,
and reasoning-output handling. Stream families include `google-thinking`,
`kilocode-thinking`, `moonshot-thinking`, `minimax-fast-mode`,
`openai-responses-defaults`, `openrouter-thinking`, and
`tool-stream-default-on`; lower-level wrappers such as
`composeProviderStreamWrappers(...)`, `createToolStreamWrapper(...)`, and
provider-specific thinking wrappers should stay provider-local unless the seam is
shared by more than one provider.

Transport identity hooks are provider-owned too. `resolveTransportTurnState` can
return native `headers` and `metadata` for a context with `provider`, `modelId`,
optional `model`, optional `sessionId`, `turnId`, `attempt`, and `transport`.
`resolveWebSocketSessionPolicy` can return WebSocket `headers` and
`degradeCooldownMs`; providers commonly use this for session headers such as
`x-session-id` before generic WebSocket transports choose retry or fallback.

Provider-specific auth remains plugin-owned. For example, a Bedrock-style
provider should rely on the AWS SDK default credential chain in its own runtime
instead of teaching core to discover AWS-specific credentials.

Speech providers can use `postJsonRequest(...)` with `url`, `headers`, `body`,
`timeoutMs`, `fetchFn`, and `auditContext`; always release guarded HTTP resources
after reading the response. Speech contracts include `prepareSynthesis`,
`isConfigured`, `synthesize`, optional `streamSynthesize`, optional
`synthesizeTelephony`, and optional `listVoices`. Use provider HTTP helpers so
timeout, proxy, SSRF, retry, and provider-error handling stay consistent across
provider plugins.

Batch speech-to-text helpers use `buildAudioTranscriptionFormData(...)` for
multipart uploads. It normalizes uploaded AAC filenames to M4A-style filenames
when the filename ends in `.aac` or the MIME type is `audio/aac`.

Realtime and media providers still follow the same ownership rule:

| Capability               | Concrete contract detail                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime transcription   | Register the provider and keep streaming-session setup, auth, vendor events, and `createRealtimeTranscriptionWebSocketSession(...)` use in plugin                                                  |
| Realtime voice and Talk  | Provider plugins own vendor session setup, `talk.catalog` exposure, `handleBargeIn`, and bridge implementation; core owns Talk session semantics                                                   |
| Image generation         | Register `generate` and vendor request normalization through the image-generation seam                                                                                                             |
| Video generation         | Declare mode-specific capability blocks such as `generate`, `imageToVideo`, and `videoToVideo`; include limits such as `maxInputImages`, `maxInputVideos`, and `maxDurationSeconds` where relevant |
| Music generation         | Use explicit `generate` and `edit` capability blocks when both modes exist                                                                                                                         |
| Web fetch and web search | Register provider-owned credential helpers, tool creation, and request execution                                                                                                                   |

Realtime transcription helpers handle proxy capture, reconnect backoff, close
flushing, ready handshakes, audio queueing, and close diagnostics around the
provider's WebSocket event mapping.

Realtime voice providers declare `capabilities` with `transports`,
`inputAudioFormats`, `outputAudioFormats`, `supportsBargeIn`, and
`supportsToolCalls`; implement `isConfigured` and `createBridge`. Bridges can
expose `supportsToolResultContinuation`, `connect`, `sendAudio`,
`setMediaTimestamp`, `submitToolResult`, `acknowledgeMark`, `close`, and
`isConnected`. Provider code owns vendor truncation and clearing behavior when
barge-in or tool continuation requires it.

Media understanding providers declare `capabilities` such as `image` and
`audio`, and implement methods such as `describeImage` and `transcribeAudio`
only for capabilities they actually support.

Video providers declare `capabilities`, `supportsResolution`, `maxVideos`, and
mode `enabled` flags where relevant, then implement `generateVideo`. If a
provider supports image-to-video limits, expose `maxInputImagesByModel` or the
matching mode-specific limits; leave unsupported modes such as `videoToVideo`
disabled instead of accepting and failing late.

Web fetch and web search providers should include `hint`, `envVars`,
`placeholder`, `signupUrl`, `credentialPath`, `getCredentialValue`,
`setCredentialValue`, and `createTool`. Web search providers register with
`api.registerWebSearchProvider(...)`; their tool definitions own the `search`
execution shape. Web fetch providers register with
`api.registerWebFetchProvider(...)` and own fetch execution.

Web fetch providers should declare their own env/config shape, for example
`ACME_FETCH_API_KEY` plus a credential path such as
`plugins.entries.acme.config.webFetch.apiKey`, instead of teaching core a
provider-specific secret location.

Catalog tests should cover both missing-auth and configured-auth paths. For an
API-key provider, include a positive test that injects a key and asserts the
expected model count or expected provider/model row.

Catalog order controls how OpenClaw merges provider rows:

| Order     | Use                                                                                 |
| --------- | ----------------------------------------------------------------------------------- |
| `simple`  | One provider catalog wins by provider/model id with normal dedupe                   |
| `profile` | Auth-profile catalogs can override generic rows for the active profile              |
| `paired`  | Paired provider entries resolve together when a provider exposes related variants   |
| `late`    | Supplemental rows append after normal discovery and lose collisions to earlier rows |

For provider-hook order and the full hook table, see
[Provider runtime hooks](/plugins/architecture-internals#provider-runtime-hooks).

## Publish to ClawHub

Provider plugins publish the same way as other external plugin packages:

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
```

Do not use the legacy skill-only publish alias for plugin packages.

## File structure

```text
extensions/acme-ai/
├── package.json
├── openclaw.plugin.json
├── index.ts
└── src/
    ├── provider.ts
    ├── provider.test.ts
    └── usage.ts
```

## Related

- [Plugin SDK overview](/plugins/sdk-overview)
- [SDK runtime](/plugins/sdk-runtime)
- [SDK testing](/plugins/sdk-testing)
- [Plugin manifest](/plugins/manifest)
- [Plugin architecture](/plugins/architecture)
- [Provider runtime hooks](/plugins/architecture-internals#provider-runtime-hooks)
- [Agent harness plugins](/plugins/sdk-agent-harness)

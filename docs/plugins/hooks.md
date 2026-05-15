---
summary: "Plugin hooks: intercept agent, tool, message, session, and Gateway lifecycle events"
title: "Plugin hooks"
doc-schema-version: 1
read_when:
  - You are building a plugin that needs before_tool_call, before_agent_reply, message hooks, or lifecycle hooks
  - You need to block, rewrite, or require approval for tool calls from a plugin
  - You are deciding between internal hooks and plugin hooks
---

Plugin hooks are in-process extension points for OpenClaw plugins. Use them
when a plugin needs to inspect or change agent runs, tool calls, message flow,
session lifecycle, subagent routing, installs, or Gateway startup.

Use [internal hooks](/automation/hooks) instead when you want a small
operator-installed `HOOK.md` script for command and Gateway events such as
`/new`, `/reset`, `/stop`, `agent:bootstrap`, or `gateway:startup`.

## Register a hook

Register typed plugin hooks with `api.on(...)` from your plugin entry:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "tool-preflight",
  name: "Tool Preflight",
  register(api) {
    api.on(
      "before_tool_call",
      async (event) => {
        if (event.toolName !== "web_search") return;

        return {
          requireApproval: {
            title: "Run web search",
            description: `Allow search query: ${String(event.params.query ?? "")}`,
            severity: "info",
            timeoutMs: 60_000,
            timeoutBehavior: "deny",
          },
        };
      },
      { priority: 50 },
    );
  },
});
```

Hook handlers run sequentially in descending `priority`. Same-priority hooks
keep registration order. Each handler receives `event.context.pluginConfig`,
the resolved config for the plugin that registered the handler, so hook
decisions can use current plugin options. The context is injected per handler
without mutating the shared event object seen by other plugins.

## Set hook timeouts

`api.on(name, handler, opts?)` accepts:

- `priority` - handler ordering. Higher runs first.
- `timeoutMs` - optional per-hook budget. When set, the hook runner aborts
  that handler after the budget elapses and continues to the next handler.
  This keeps slow setup, recall, or policy work from consuming the caller's
  configured model timeout. If no hook timeout is set, OpenClaw uses the generic
  observation or decision timeout for that hook phase.

Operators can set hook budgets in config:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "hooks": {
          "timeoutMs": 30000,
          "timeouts": {
            "before_prompt_build": 90000,
            "agent_end": 60000
          }
        }
      }
    }
  }
}
```

`hooks.timeouts.<hookName>` overrides `hooks.timeoutMs`, which overrides the
plugin-authored `api.on(..., { timeoutMs })` value. Values must be positive
integers no greater than 600000 milliseconds. Prefer per-hook overrides when
only one hook needs a larger budget, so a plugin does not receive an extended
budget for every hook it registers.

## Choose the hook family

| Goal                                                  | Hook family                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Switch provider or model before model resolution      | `before_model_resolve`                                                                     |
| Add same-turn context before prompt hooks             | `agent_turn_prepare`                                                                       |
| Add prompt or system context                          | `before_prompt_build`                                                                      |
| Block a model run before submission                   | `before_agent_run`                                                                         |
| Short-circuit a reply                                 | `before_agent_reply`, including synthetic replies or silence                               |
| Request one bounded revision pass before final answer | `before_agent_finalize`                                                                    |
| Observe final run outcome                             | `agent_end`                                                                                |
| Rewrite, block, or require approval for tools         | `before_tool_call`                                                                         |
| Observe tool results                                  | `after_tool_call`, including errors and duration                                           |
| Rewrite persisted tool-result messages                | `tool_result_persist`                                                                      |
| Claim inbound messages before routing                 | `inbound_claim`, including synthetic replies                                               |
| Observe or rewrite message delivery                   | `message_received`, `message_sending`, `message_sent`, `before_dispatch`, `reply_dispatch` |
| Coordinate subagent routing                           | `subagent_spawning`, `subagent_delivery_target`, `subagent_spawned`, `subagent_ended`      |
| Track sessions and compaction                         | `session_start`, `session_end`, `before_compaction`, `after_compaction`, `before_reset`    |
| Start or stop plugin-owned services                   | `gateway_start`, `gateway_stop`                                                            |
| Observe cron lifecycle changes                        | `cron_changed`                                                                             |
| Inspect plugin or skill installs                      | `before_install`                                                                           |

Names that make decisions can block, cancel, override, or require approval.
Observation hooks should log, update plugin-owned state, or emit metrics without
changing the caller's behavior.

## Gate tool calls

`before_tool_call` receives `event.toolName`, `event.params`, optional
`event.derivedPaths`, optional `event.runId`, optional `event.toolCallId`, and
context fields such as `ctx.agentId`, `ctx.sessionKey`, `ctx.sessionId`,
`ctx.runId`, `ctx.jobId`, and diagnostic trace fields such as `ctx.trace`.
`event.derivedPaths`
contains best-effort host-derived target path hints for known tool envelopes
such as `apply_patch`; those paths may be incomplete or over-approximate what
the tool will actually touch.

It can return:

```typescript
type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    pluginId?: string;
    onResolution?: (
      decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled",
    ) => Promise<void> | void;
  };
};
```

Decision rules:

- `block: true` is terminal and skips lower-priority handlers.
- `block: false` is treated as no decision.
- `params` rewrites tool parameters before execution.
- `requireApproval` pauses the agent run and asks through plugin approvals.
  The `/approve` command can approve both exec approvals and plugin approvals.
  If an exec approval id is not found, OpenClaw retries that id through plugin
  approvals. Plugin approval forwarding is configured independently through
  `approvals.plugin`.
- A lower-priority `block: true` can still block after a higher-priority hook
  requested approval.
- `onResolution` receives `allow-once`, `allow-always`, `deny`, `timeout`, or
  `cancelled`.

Custom approval plumbing should import `isApprovalNotFoundError` from
`openclaw/plugin-sdk/error-runtime` instead of matching approval-expiry strings.

Bundled plugins that need host-level policy can register trusted tool policies
with `api.registerTrustedToolPolicy(...)`. These run before ordinary
`before_tool_call` hooks and before external plugin decisions. Use trusted
policies for host-owned gates such as workspace policy, budget enforcement, or
reserved workflow safety. External plugins should use normal hooks.

## Persist tool results safely

Tool results can include structured `details` for UI rendering, diagnostics,
media routing, or plugin-owned metadata. Treat `details` as runtime metadata,
not prompt content:

- OpenClaw strips `toolResult.details` before provider replay and compaction
  input.
- Persisted session entries keep only bounded `details`; oversized details are
  replaced with a compact summary and `persistedDetailsTruncated: true`.
- `tool_result_persist` and `before_message_write` run before the final
  persistence cap.
- `before_message_write` can inspect or block an in-progress message write
  before it reaches storage.

Keep returned `details` small. Put model-visible tool output in `content`, not
only in `details`.

## Mutate prompts and model choices

Use phase-specific hooks for new plugins:

- `before_model_resolve` receives the current prompt and attachment metadata.
  Return `providerOverride` or `modelOverride`.
- `agent_turn_prepare` receives the prompt, prepared session messages, and
  exactly-once queued injections drained for the session. Return
  `prependContext` or `appendContext`.
- `before_prompt_build` receives the prompt and session messages. Return
  `prependContext`, `appendContext`, `systemPrompt`, `prependSystemContext`, or
  `appendSystemContext`.
- `heartbeat_prompt_contribution` runs only for heartbeat turns and returns
  `prependContext` or `appendContext` for background-monitor state. It should
  not change user-initiated turns.

`before_agent_start` remains for compatibility. Prefer the explicit hooks above.

`before_agent_run` runs after prompt construction and before any model input,
including prompt-local image loading and `llm_input` observation. It receives
the current user input as `prompt`, loaded session history in `messages`, and
the active system prompt. Return `{ outcome: "block", reason, message? }` to
stop the run before the model can read the prompt. `reason` is internal;
`message` is the user-facing replacement. Unsupported decision shapes fail
closed. When a run is blocked, OpenClaw stores only the replacement text plus
bounded non-sensitive block metadata; the original user text and internal block
reason are excluded from transcript, history, broadcast, logs, and diagnostics.

Use `model_call_started` and `model_call_ended` for provider-call telemetry that
must not receive raw prompts, history, responses, headers, request bodies, or
provider request ids. These hooks include stable metadata such as `runId`,
`callId`, `provider`, `model`, optional `api` or `transport`, terminal
`durationMs` and `outcome`, and `upstreamRequestIdHash` when OpenClaw can derive
a bounded provider request-id hash. `llm_input` and `llm_output` are the raw
conversation-observation hooks and require conversation-access opt-in.
`llm_input` observes provider input, including the system prompt, user prompt,
and loaded history. `llm_output` observes provider output, usage, and the
resolved `contextTokenBudget` when available, only after a model attempt
produces assistant output.

`before_agent_finalize` runs only when a harness is about to accept a natural
final assistant answer. It is not the `/stop` cancellation path and does not run
when the user aborts a turn. Return `{ action: "revise", reason }` to ask the
harness for one more model pass, `{ action: "finalize", reason? }` to force
finalization, or omit a result to continue. A revise result can include
`retry: { instruction, idempotencyKey?, maxAttempts? }`; OpenClaw appends
`instruction` to the revision reason, counts equivalent requests by
`idempotencyKey`, and caps extra passes with `maxAttempts`. Codex native Stop
hooks are relayed into this hook as OpenClaw `before_agent_finalize` decisions.

Non-bundled plugins that need raw conversation hooks such as
`before_model_resolve`, `before_agent_reply`, `llm_input`, `llm_output`,
`before_agent_finalize`, `agent_end`, or `before_agent_run` must opt in:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Prompt-mutating hooks and durable next-turn injections can be disabled per
plugin with `plugins.entries.<id>.hooks.allowPromptInjection=false`.

## Use session extensions

Workflow plugins can persist small JSON-compatible session state with
`api.registerSessionExtension(...)` and update it through the Gateway
`sessions.pluginPatch` method. Session rows project registered extension state
through `pluginExtensions`, which is the Control UI and client rendering
boundary for plugin-owned state without teaching clients plugin internals.

Use `api.enqueueNextTurnInjection(...)` when a plugin needs durable context to
reach the next model turn exactly once. OpenClaw drains queued injections before
prompt hooks, drops expired injections, and deduplicates by `idempotencyKey` per
plugin. Typical uses include approval resumes, policy summaries, background
monitor deltas, and command continuations. The injection is visible to the next
turn only; it is not a permanent system-prompt mutation.

Cleanup callbacks receive `reset`, `delete`, `disable`, or `restart`. The host
removes the owning plugin's persistent session extension state and pending
next-turn injections for reset, delete, and disable. Restart keeps durable
session state while cleanup callbacks release out-of-band resources for the old
runtime generation, such as scheduler jobs, run context, sockets, or other
plugin-owned handles.

## Observe message delivery

Use message hooks for channel-level routing and delivery policy:

- `message_received` observes inbound content, sender, `threadId`,
  `messageId`, `senderId`, optional run/session correlation, and metadata.
- `message_sending` rewrites outbound `content` or returns `{ cancel: true }`.
- `message_sent` observes outbound delivery success or failure.
- `before_dispatch` inspects or rewrites an outbound dispatch before channel
  handoff.
- `reply_dispatch` participates in the final reply-dispatch pipeline.

Prefer typed `threadId` and `replyToId` fields before using channel-specific
metadata. Message hook contexts expose stable correlation fields such as
`ctx.sessionKey`, `ctx.runId`, `ctx.messageId`, `ctx.senderId`, `ctx.trace`,
`ctx.traceId`, `ctx.spanId`, `ctx.parentSpanId`, and `ctx.callDepth`. For
channel-originated runs, `ctx.messageProvider` names the provider surface such
as `discord` or `telegram`, and `ctx.channelId` is the conversation target id
when OpenClaw can derive one from the session key or delivery metadata.

Decision rules:

- `message_sending` with `cancel: true` is terminal.
- `message_sending` with `cancel: false` is treated as no decision.
- `message_sending` supports only `pass` and `block` style outcomes through
  normal continuation or cancellation.
- Rewritten `content` continues to lower-priority hooks unless a later hook
  cancels delivery.
- `message_sending` can return `cancelReason` and bounded `metadata`.
- Keep observability fields sanitized; useful categories include blocker id,
  outcome, timestamp, and safe reason categories.
- `message_sent` is observation-only; handler failures are logged and do not
  change delivery.

For audio-only TTS messages, hooks can see the hidden transcript used for model
or policy decisions even when there is no visible text caption. Do not assume
that rewriting that transcript will create a media caption in the channel UI.

## Handle installs and Gateway lifecycle

`before_install` runs after the built-in scan for skill and plugin installs.
Return additional findings or `{ block: true, blockReason }` to stop the
install. `block: true` is terminal. `block: false` is treated as no decision.

Use `gateway_start` for plugin services that need Gateway-owned state. The
context exposes `ctx.config`, `ctx.workspaceDir`, and `ctx.getCron?.()`. Use
`gateway_stop` to clean up long-running resources. Do not rely on the internal
`gateway:startup` hook for plugin-owned runtime services.

`cron_changed` fires for gateway-owned cron lifecycle events with a typed
snapshot and delivery status. Reasons include `added`, `updated`, `removed`,
`started`, `finished`, and `scheduled`. The event carries a
`PluginHookGatewayCronJob` snapshot, including `state.nextRunAtMs`,
`state.lastRunStatus`, and `state.lastError` when present, plus a
`PluginHookGatewayCronDeliveryStatus` of `not-requested`, `delivered`,
`not-delivered`, or `unknown`. Removed events still carry the deleted job
snapshot. Use `ctx.getCron?.()` and `ctx.config` from the runtime context when
syncing external wake schedulers, and keep OpenClaw as the source of truth for
due checks and execution.

`session_end` includes a `reason` of `new`, `reset`, `idle`, `daily`,
`compaction`, `deleted`, `shutdown`, `restart`, or `unknown`. `shutdown` and
`restart` fire from the Gateway shutdown finalizer for sessions still active
when the process stops or restarts. `agent_end` is observation-only and runs
fire-and-forget after a turn with a 30 second timeout; timeouts are logged and do
not cancel plugin-owned network work unless the plugin also uses its own abort
signal. The shutdown finalizer is bounded so a slow plugin cannot block
`SIGTERM` or `SIGINT`. `before_agent_start` and `agent_end` include
`event.runId` when available; the same value is also available on `ctx.runId`.
Cron-driven runs expose `ctx.jobId`.

For proof of the effective session model, inspect runtime registrations and use
`openclaw sessions` or Gateway session/status surfaces. When debugging provider
payloads, start the Gateway with `--raw-stream` and `--raw-stream-path <path>`
to write raw model stream events to a jsonl file.

## Migrate deprecated hook surfaces

A few hook-adjacent surfaces are deprecated but still supported:

- Plaintext channel envelopes in `inbound_claim` and `message_received`
  handlers. Read `BodyForAgent` and structured user-context blocks instead.
- `before_agent_start`. New plugins should use `before_model_resolve` and
  `before_prompt_build`. Migrate before the next major release.
- Free-form `onResolution` values in `before_tool_call`. Use the typed
  `PluginApprovalResolution` union.
- Legacy `message_sending` direct delivery with an empty result array is treated
  as suppressed delivery with `cancelled_by_message_sending_hook`.
- Other active deprecations include provider thinking profiles, external auth
  provider helpers, provider discovery types, task runtime accessors, and the
  `command-auth` to `command-status` rename.

For the full list, see
[Plugin SDK migration](/plugins/sdk-migration#active-deprecations).

## Related

- [Building plugins](/plugins/building-plugins)
- [Plugin SDK overview](/plugins/sdk-overview)
- [SDK entry points](/plugins/sdk-entrypoints)
- [Internal hooks](/automation/hooks)
- [Plugin architecture internals](/plugins/architecture-internals)

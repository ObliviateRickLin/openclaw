---
summary: "Contributor guide for adding a new shared capability to the OpenClaw plugin system"
read_when:
  - Adding a new core capability and plugin registration surface
  - Deciding whether code belongs in core, a vendor plugin, or a feature plugin
  - Wiring a new runtime helper for channels or tools
title: "Adding capabilities"
sidebarTitle: "Adding capabilities"
doc-schema-version: 1
---

This is a contributor guide for OpenClaw core developers. If you are building
an external plugin, start with [Building plugins](/plugins/building-plugins).
If you need the deep architecture reference, see
[Plugin architecture](/plugins/architecture).

Use this when OpenClaw needs a new shared domain such as image generation,
video generation, or a future vendor-backed feature area.

The rule is:

- **plugin** = ownership boundary
- **capability** = shared core contract

Do not start by wiring one vendor directly into a channel or tool. Start by
defining the shared capability.

## Create a capability only when needed

Create a new capability when all of these are true:

1. More than one vendor could plausibly implement it.
2. Channels, tools, or feature plugins should consume it without caring about
   the vendor.
3. Core needs to own fallback, policy, config, or delivery behavior.

If the work is vendor-only and no shared contract exists yet, define the
contract before adding vendor-specific branches.

## Follow the standard sequence

1. Define the typed core contract.
2. Add plugin registration for that contract.
3. Add a shared runtime helper.
4. Wire one real vendor plugin as proof.
5. Move feature or channel consumers onto the runtime helper.
6. Add contract tests.
7. Document the operator-facing config and ownership model.

## Put code in the owning layer

| Layer                     | Owns                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Core                      | Request and response types, provider registry, fallback behavior, config schema, runtime helper surface |
| Vendor plugin             | Vendor API calls, auth handling, request normalization, capability implementation registration          |
| Feature or channel plugin | Calls to `api.runtime.*` or the matching `plugin-sdk/*-runtime` helper                                  |

Feature and channel plugins should not import vendor implementations directly.
They should call the shared runtime helper.

When core owns a config schema, preserve generated-doc metadata too. `title` and
`description` metadata must propagate through nested object, wildcard,
array-item, and composition nodes so config reference output stays useful.

## Use provider and harness seams correctly

Use provider hooks when behavior belongs to the model provider contract rather
than the generic agent loop. Examples include provider-specific request params,
auth-profile preference, prompt overlays, and follow-up routing after
model/profile failover. Provider-specific request params apply after transport
selection, where the provider knows which transport-specific shape it is
building.

Use agent harness hooks when behavior belongs to the runtime executing a turn.
Harnesses can classify successful-but-unusable attempt results such as empty,
reasoning-only, or planning-only responses so the outer fallback policy can
decide whether to retry.

Keep both seams narrow:

- Core owns retry and fallback policy.
- Provider plugins own provider-specific request, auth, and routing hints.
- Harness plugins own runtime-specific attempt classification.
- Third-party plugins return hints, not direct mutations of core state.

## Touch the expected surfaces

For a new capability, expect to update:

- `src/<capability>/types.ts`
- `src/<capability>/...registry/runtime.ts`
- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `src/plugins/captured-registration.ts`
- `src/plugins/contracts/registry.ts`
- `src/plugins/runtime/types-core.ts`
- `src/plugins/runtime/index.ts`
- `src/plugin-sdk/<capability>.ts`
- `src/plugin-sdk/<capability>-runtime.ts`
- One or more bundled plugin packages.
- Config, docs, and tests.

The exact list depends on the capability shape. The invariant is that the
public contract, plugin registration, runtime helper, bundled proof, docs, and
tests move together.

## Example: image generation

Image generation follows the standard shape:

1. Core defines `ImageGenerationProvider`.
2. Core exposes `registerImageGenerationProvider(...)`.
3. Core exposes `runtime.imageGeneration.generate(...)`.
4. Vendor plugins such as OpenAI, Google, fal, and MiniMax register
   implementations.
5. Future vendors register the same contract without changing channels or
   tools.

The config key is separate from vision-analysis routing:

- `agents.defaults.imageModel` analyzes images.
- `agents.defaults.imageGenerationModel` generates images.

Keep those separate so fallback and policy remain explicit.

## Review before shipping

<Check>No channel or tool imports vendor code directly</Check>
<Check>The runtime helper is the shared path</Check>
<Check>At least one contract test asserts bundled ownership</Check>
<Check>Config docs name the new model or config key</Check>
<Check>Plugin docs explain the ownership boundary</Check>
<Check>New plugin, channel, app, or docs surfaces update `.github/labeler.yml` and GitHub labels when required</Check>

If a PR skips the capability layer and hardcodes vendor behavior into a channel
or tool, send it back and define the contract first.

## Related

- [Plugin architecture](/plugins/architecture)
- [Plugin architecture internals](/plugins/architecture-internals)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin manifest](/plugins/manifest)
- [SDK testing](/plugins/sdk-testing)
- [Building plugins](/plugins/building-plugins)

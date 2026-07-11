// Covers the canonical worktree-GC owner liveness predicate (#104108).
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { IDLE_GC_MS } from "../agents/worktrees/service.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { isManagedWorktreeOwnerActive } from "./worktree-owner-activity.js";

afterEach(() => {
  resetConfigRuntimeState();
});

describe("isManagedWorktreeOwnerActive", () => {
  test("keeps live session owners active and idle-expired ones inactive", async () => {
    await withStateDirEnv("worktree-owner-activity-", async ({ stateDir }) => {
      const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const now = Date.now();
      fs.writeFileSync(
        path.join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:main:live": { sessionId: "sess-live", lastInteractionAt: now, updatedAt: now },
          "agent:main:stale": {
            sessionId: "sess-stale",
            lastInteractionAt: now - IDLE_GC_MS - 60_000,
            updatedAt: now - IDLE_GC_MS - 60_000,
          },
        }),
        "utf8",
      );
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      expect(isManagedWorktreeOwnerActive("session", "agent:main:live")).toBe(true);
      expect(isManagedWorktreeOwnerActive("session", "agent:main:stale")).toBe(false);
      // Non-session owners rely on the git-lock fallback inside gc(), never
      // on session activity.
      expect(isManagedWorktreeOwnerActive("manual", "agent:main:live")).toBe(false);
      // Unknown sessions are not treated as live.
      expect(isManagedWorktreeOwnerActive("session", "agent:main:missing")).toBe(false);
    });
  });
});

// Canonical GC liveness predicate for managed worktrees.
import { IDLE_GC_MS } from "../agents/worktrees/service.js";
import type { ManagedWorktreeOwnerKind } from "../agents/worktrees/types.js";
import { loadSessionEntry } from "./session-utils.js";

/**
 * Session-owned worktrees take no git worktree lock (chat runs avoid registry
 * acquire writes), so recent owning-session activity is their only protection
 * against idle-expiry removal. Every gc() caller — scheduled maintenance, the
 * worktrees.gc RPC, and the CLI command — must pass this same predicate;
 * omitting it lets gc remove a live session's worktree (#104108).
 */
export function isManagedWorktreeOwnerActive(
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): boolean {
  if (ownerKind !== "session") {
    return false;
  }
  try {
    const entry = loadSessionEntry(ownerId, { clone: false }).entry;
    const activityAt = Math.max(entry?.lastInteractionAt ?? 0, entry?.updatedAt ?? 0);
    return activityAt > 0 && Date.now() - activityAt <= IDLE_GC_MS;
  } catch {
    return false;
  }
}

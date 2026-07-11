// Persistence coverage for transcript rotation after successful compaction.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  rotateTranscriptAfterCompaction,
  rotateTranscriptFileAfterCompaction,
  shouldRotateCompactionTranscript,
} from "./compaction-successor-transcript.js";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

let tmpDir: string | undefined;

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-successor-test-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    tmpDir = undefined;
  }
});

function makeAssistant(text: string, timestamp: number) {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    timestamp,
  });
}

function makeThinkingAssistant(text: string, thinkingSignature: string, timestamp: number) {
  return makeAgentAssistantMessage({
    content: [
      { type: "thinking", thinking: "reasoning", thinkingSignature } as never,
      { type: "text", text },
    ],
    timestamp,
  });
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

type TranscriptEntry = ReturnType<SessionManager["getEntries"]>[number];

function requireEntryByIdAndType<T extends TranscriptEntry["type"]>(
  entries: readonly TranscriptEntry[],
  id: string,
  type: T,
  label: string,
): Extract<TranscriptEntry, { type: T }> {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`expected ${label}`);
  }
  if (entry.type !== type) {
    throw new Error(`expected ${label} to be ${type}, got ${entry.type}`);
  }
  return entry as Extract<TranscriptEntry, { type: T }>;
}

function requireEntryByType<T extends TranscriptEntry["type"]>(
  entries: readonly TranscriptEntry[],
  type: T,
  label: string,
): Extract<TranscriptEntry, { type: T }> {
  const entry = entries.find((candidate) => candidate.type === type);
  if (!entry) {
    throw new Error(`expected ${label}`);
  }
  return entry as Extract<TranscriptEntry, { type: T }>;
}

function createCompactedSession(sessionDir: string): {
  manager: SessionManager;
  sessionFile: string;
  firstKeptId: string;
  oldUserId: string;
} {
  // Fixture includes pre-compaction history, preserved branch metadata, and
  // post-compaction turns so rotation can prove exactly which entries survive.
  const manager = SessionManager.create(sessionDir, sessionDir);
  manager.appendModelChange("openai", "gpt-5.2");
  manager.appendThinkingLevelChange("medium");
  manager.appendCustomEntry("test-extension", { cursor: "before-compaction" });
  const oldUserId = manager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
  manager.appendLabelChange(oldUserId, "old bookmark");
  manager.appendMessage(makeAssistant("old assistant", 2));
  const firstKeptId = manager.appendMessage({ role: "user", content: "kept user", timestamp: 3 });
  manager.appendLabelChange(firstKeptId, "kept bookmark");
  manager.appendMessage(makeAssistant("kept assistant", 4));
  manager.appendCompaction("Summary of old user and old assistant.", firstKeptId, 5000);
  manager.appendMessage({ role: "user", content: "post user", timestamp: 5 });
  manager.appendMessage(makeAssistant("post assistant", 6));
  return {
    manager,
    sessionFile: requireString(manager.getSessionFile(), "compacted session file"),
    firstKeptId,
    oldUserId,
  };
}

describe("rotateTranscriptAfterCompaction", () => {
  it("can rotate a persisted transcript without opening a manager", async () => {
    const dir = await createTmpDir();
    const { sessionFile } = createCompactedSession(dir);

    // File-only rotation is used after the active manager has moved on; opening
    // a new manager here would hide bugs in the direct persistence path.
    const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
      throw new Error("SessionManager.open should not be used for file rotation");
    });
    const result = await rotateTranscriptFileAfterCompaction({
      sessionFile,
      now: () => new Date("2026-04-27T12:00:00.000Z"),
    });
    openSpy.mockRestore();

    expect(result.rotated).toBe(true);
    const successorFile = requireString(result.sessionFile, "successor session file");

    const successor = SessionManager.open(successorFile);
    const header = requireValue(successor.getHeader(), "successor header");
    expect(header.parentSession).toBe(sessionFile);
    expect(header.cwd).toBe(dir);
    const messages = successor.buildSessionContext().messages;
    expect(
      messages.map((message) => {
        if (message.role === "compactionSummary") {
          return {
            role: message.role,
            summary: message.summary,
            tokensBefore: message.tokensBefore,
          };
        }
        if (!("content" in message)) {
          throw new Error(`expected ${message.role} message content`);
        }
        return {
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
        };
      }),
    ).toEqual([
      {
        role: "compactionSummary",
        summary: "Summary of old user and old assistant.",
        tokensBefore: 5000,
      },
      // The last assistant reply before firstKeptEntryId is preserved so the
      // successor shows compactionSummary → assistant → user (issue #76729).
      {
        role: "assistant",
        content: [{ type: "text", text: "old assistant" }],
        timestamp: 2,
      },
      { role: "user", content: "kept user", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "kept assistant" }],
        timestamp: 4,
      },
      { role: "user", content: "post user", timestamp: 5 },
      {
        role: "assistant",
        content: [{ type: "text", text: "post assistant" }],
        timestamp: 6,
      },
    ]);
  });

  it("keeps the paired tool result without replaying summarized custom context", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "read the file", timestamp: 1 });
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      }),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 3,
    });
    manager.appendCustomMessageEntry("test", "summarized custom context", false);
    const firstKeptId = manager.appendMessage({
      role: "user",
      content: "continue",
      timestamp: 4,
    });
    manager.appendMessage(makeAssistant("done", 5));
    manager.appendCompaction("Summary of the read.", firstKeptId, 5000);
    manager.appendMessage({ role: "user", content: "next", timestamp: 6 });

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "session file"),
    });
    const successor = SessionManager.open(requireString(result.sessionFile, "successor file"));
    const messages = successor.buildSessionContext().messages;
    const assistant = messages.find((message) => message.role === "assistant");
    const toolResult = messages.find((message) => message.role === "toolResult");

    expect(assistant?.role).toBe("assistant");
    expect(toolResult?.role).toBe("toolResult");
    expect(JSON.stringify(messages)).toContain("file contents");
    expect(JSON.stringify(messages)).not.toContain("summarized custom context");
  });

  it("creates a compacted successor transcript and leaves the archive untouched", async () => {
    const dir = await createTmpDir();
    const { manager, sessionFile, firstKeptId, oldUserId } = createCompactedSession(dir);
    const originalBytes = await fs.readFile(sessionFile, "utf8");
    const originalEntryCount = manager.getEntries().length;

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile,
      now: () => new Date("2026-04-27T12:00:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successorSessionId = requireString(result.sessionId, "successor session id");
    const successorFile = requireString(result.sessionFile, "successor session file");
    expect(successorFile).not.toBe(sessionFile);
    expect(await fs.readFile(sessionFile, "utf8")).toBe(originalBytes);

    const successor = SessionManager.open(successorFile);
    const header = requireValue(successor.getHeader(), "successor header");
    expect(header.id).toBe(successorSessionId);
    expect(header.parentSession).toBe(sessionFile);
    expect(header.cwd).toBe(dir);
    expect(successor.getEntries().length).toBeLessThan(originalEntryCount);
    expect(successor.getBranch()[0]?.type).toBe("model_change");
    const customBranchEntry = requireEntryByType(
      successor.getBranch(),
      "custom",
      "preserved custom branch entry",
    );
    expect(customBranchEntry.customType).toBe("test-extension");
    expect(customBranchEntry.data).toStrictEqual({ cursor: "before-compaction" });

    const context = successor.buildSessionContext();
    const contextText = JSON.stringify(context.messages);
    expect(contextText).toContain("Summary of old user and old assistant.");
    expect(contextText).toContain("kept user");
    expect(contextText).toContain("post assistant");
    expect(
      context.messages.some((message) => message.role === "user" && message.content === "old user"),
    ).toBe(false);
    expect(context.model?.provider).toBe("openai");
    expect(context.thinkingLevel).toBe("medium");
    expect(successor.getLabel(firstKeptId)).toBe("kept bookmark");
    expect(successor.getLabel(oldUserId)).toBeUndefined();
  });

  it("rotates with a fallback timestamp when the injected clock is invalid", async () => {
    const dir = await createTmpDir();
    const { manager, sessionFile } = createCompactedSession(dir);
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00Z"));

    try {
      const result = await rotateTranscriptAfterCompaction({
        sessionManager: manager,
        sessionFile,
        now: () => new Date(Number.NaN),
      });

      expect(result.rotated).toBe(true);
      const successor = SessionManager.open(requireString(result.sessionFile, "successor file"));
      expect(successor.getHeader()?.timestamp).toBe("2026-05-30T12:00:00.000Z");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("deduplicates stale pre-compaction session state", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    const staleModelId = manager.appendModelChange("anthropic", "claude-sonnet-4-5");
    const staleThinkingId = manager.appendThinkingLevelChange("low");
    const staleSessionInfoId = manager.appendSessionInfo("stale title");
    manager.appendCustomEntry("test-extension", { cursor: "preserved" });
    manager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
    manager.appendMessage(makeAssistant("old assistant", 2));

    manager.appendModelChange("openai", "gpt-5.2");
    manager.appendThinkingLevelChange("high");
    manager.appendSessionInfo("current title");
    const firstKeptId = manager.appendMessage({ role: "user", content: "kept user", timestamp: 3 });
    manager.appendMessage(makeAssistant("kept assistant", 4));
    manager.appendCompaction("Summary of old user and old assistant.", firstKeptId, 5000);
    manager.appendMessage({ role: "user", content: "post user", timestamp: 5 });

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
      now: () => new Date("2026-04-27T12:05:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const entries = successor.getEntries();
    expect(entries.find((entry) => entry.id === staleModelId)).toBeUndefined();
    expect(entries.find((entry) => entry.id === staleThinkingId)).toBeUndefined();
    expect(entries.find((entry) => entry.id === staleSessionInfoId)).toBeUndefined();
    const countEntryType = (type: (typeof entries)[number]["type"]) =>
      entries.reduce((count, entry) => count + (entry.type === type ? 1 : 0), 0);
    expect(countEntryType("model_change")).toBe(1);
    expect(countEntryType("thinking_level_change")).toBe(1);
    expect(countEntryType("session_info")).toBe(1);
    const modelChange = requireEntryByType(entries, "model_change", "current model change");
    expect(modelChange.provider).toBe("openai");
    expect(modelChange.modelId).toBe("gpt-5.2");
    const customEntry = requireEntryByType(entries, "custom", "preserved custom entry");
    expect(customEntry.customType).toBe("test-extension");
    expect(customEntry.data).toStrictEqual({ cursor: "preserved" });

    const context = successor.buildSessionContext();
    expect(context.thinkingLevel).toBe("high");
    expect(successor.getSessionName()).toBe("current title");
  });

  it("drops duplicate user messages from the rotated active branch tail", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
    const firstKeptId = manager.appendMessage(makeAssistant("old assistant", 2));
    manager.appendCompaction("Summary of old work.", firstKeptId, 5000);
    const firstDuplicateId = manager.appendMessage({
      role: "user",
      content: "please run the deployment status check for production",
      timestamp: 3_000,
    });
    const secondDuplicateId = manager.appendMessage({
      role: "user",
      content: " please   run the deployment status check for production ",
      timestamp: 4_000,
    });
    manager.appendMessage(makeAssistant("status checked", 5_000));

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
      now: () => new Date("2026-04-27T12:10:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const entries = successor.getEntries();
    requireValue(
      entries.find((entry) => entry.id === firstDuplicateId),
      "kept duplicate entry",
    );
    expect(entries.find((entry) => entry.id === secondDuplicateId)).toBeUndefined();
    const contextText = JSON.stringify(successor.buildSessionContext().messages);
    expect(contextText.match(/deployment status check/g)).toHaveLength(1);
  });

  it("skips sessions with no compaction entry", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    manager.appendMessage(makeAssistant("hi", 2));

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
    });

    expect(result.rotated).toBe(false);
    expect(result.reason).toBe("no compaction entry");
  });

  it("uses a refreshed manager after manual boundary hardening", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
    manager.appendMessage(makeAssistant("old answer", 2));
    const recentTailId = manager.appendMessage({
      role: "user",
      content: "recent question",
      timestamp: 3,
    });
    manager.appendMessage(makeAssistant("detailed recent answer", 4));
    const compactionId = manager.appendCompaction("fresh manual summary", recentTailId, 200);
    const sessionFile = requireString(manager.getSessionFile(), "manual compaction session file");
    const staleManager = SessionManager.open(sessionFile);

    const hardened = await hardenManualCompactionBoundary({ sessionFile });
    expect(hardened.applied).toBe(true);
    const staleLeaf = staleManager.getLeafEntry();
    expect(staleLeaf?.type).toBe("compaction");
    if (!staleLeaf || staleLeaf.type !== "compaction") {
      throw new Error("expected stale leaf to be a compaction entry");
    }
    expect(staleLeaf.firstKeptEntryId).toBe(recentTailId);

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: SessionManager.open(sessionFile),
      sessionFile,
      now: () => new Date("2026-04-27T12:30:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const successorText = JSON.stringify(successor.buildSessionContext().messages);
    expect(successorText).toContain("fresh manual summary");
    expect(successorText).not.toContain("recent question");
    expect(successorText).not.toContain("detailed recent answer");
    const successorCompaction = successor
      .getEntries()
      .find((entry) => entry.type === "compaction" && entry.id === compactionId);
    if (!successorCompaction || successorCompaction.type !== "compaction") {
      throw new Error("expected successor compaction entry");
    }
    expect(successorCompaction.firstKeptEntryId).toBe(compactionId);
  });

  it("collects abandoned sibling branches while keeping the active-chain branch summary", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const branchFromId = manager.appendMessage(makeAssistant("hi there", 2));

    const siblingMsgId = manager.appendMessage({
      role: "user",
      content: "do task B instead",
      timestamp: 3,
    });
    const siblingReplyId = manager.appendMessage(makeAssistant("done B", 4));

    const branchSummaryId = manager.branchWithSummary(
      branchFromId,
      "Summary of the abandoned branch.",
    );
    manager.appendMessage({ role: "user", content: "do task A", timestamp: 5 });
    manager.appendMessage(makeAssistant("done A", 6));
    // Keep the branch summary in the kept pre-compaction span so the test can
    // separate "on the active chain" from "summarized away".
    manager.appendCompaction("Summary of main branch.", branchSummaryId, 5000);
    manager.appendMessage({ role: "user", content: "next", timestamp: 7 });

    const sessionFile = requireString(manager.getSessionFile(), "source session file");
    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile,
      now: () => new Date("2026-04-27T12:45:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const allEntries = successor.getEntries();
    const branchSummary = requireEntryByIdAndType(
      allEntries,
      branchSummaryId,
      "branch_summary",
      "preserved active-chain branch summary",
    );
    expect(branchSummary.summary).toBe("Summary of the abandoned branch.");
    // The abandoned task-B branch is unreachable from the active leaf; rotation
    // collects it instead of copying it into every successor file (#103934).
    expect(allEntries.some((entry) => entry.id === siblingMsgId)).toBe(false);
    expect(allEntries.some((entry) => entry.id === siblingReplyId)).toBe(false);

    const activeContextText = JSON.stringify(successor.buildSessionContext().messages);
    expect(activeContextText).toContain("Summary of main branch.");
    expect(activeContextText).toContain("next");
    expect(activeContextText).not.toContain("do task B instead");
  });

  it("keeps scanned custom entries and kept-target labels while collecting dead branches", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const branchFromId = manager.appendMessage(makeAssistant("hi there", 2));

    // Custom entries are consumed via whole-file scans (provider replay
    // markers, bootstrap completion), so they survive rotation even when a
    // rewind left them off the active chain.
    const customEntryId = manager.appendCustomEntry("test-replay-marker", { flag: true });
    const deadMsgId = manager.appendMessage({
      role: "user",
      content: "abandoned path",
      timestamp: 3,
    });
    const deadLabelTargetId = manager.appendMessage(makeAssistant("abandoned reply", 4));
    manager.appendLabelChange(deadLabelTargetId, "dead-branch-label");

    manager.branch(branchFromId);
    manager.appendMessage({ role: "user", content: "active branch", timestamp: 5 });
    const keptAssistantId = manager.appendMessage(makeAssistant("active done", 6));
    const keptLabelId = manager.appendLabelChange(keptAssistantId, "kept-label");
    manager.appendCompaction("Summary of active work.", keptAssistantId, 5000);
    const activeLeafId = manager.appendMessage({
      role: "user",
      content: "next active",
      timestamp: 7,
    });

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
      now: () => new Date("2026-04-27T13:00:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const entries = successor.getEntries();
    const entryIds = new Set(entries.map((entry) => entry.id));
    expect(entryIds.has(customEntryId)).toBe(true);
    expect(entryIds.has(keptLabelId)).toBe(true);
    expect(entryIds.has(deadMsgId)).toBe(false);
    expect(entryIds.has(deadLabelTargetId)).toBe(false);
    expect(
      entries.some((entry) => entry.type === "label" && entry.label === "dead-branch-label"),
    ).toBe(false);
    expect(entries.at(-1)?.id).toBe(activeLeafId);
    expect(successor.getLeafId()).toBe(activeLeafId);

    const activeContextText = JSON.stringify(successor.buildSessionContext().messages);
    expect(activeContextText).toContain("Summary of active work.");
    expect(activeContextText).toContain("next active");
    expect(activeContextText).not.toContain("abandoned path");
  });

  it("collects overflow-rewrite orphan suffixes at the next rotation (#103934)", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
    const oversizedAssistantId = manager.appendMessage(
      makeAssistant(`huge tool output ${"x".repeat(2000)}`, 2),
    );
    manager.appendMessage({ role: "user", content: "follow-up", timestamp: 3 });
    const tailAssistantId = manager.appendMessage(makeAssistant("tail answer", 4));

    // Overflow recovery rewrites by forking from the rewritten entry's parent
    // and re-appending the suffix; the original suffix entries stay behind as
    // an unreachable branch.
    const rewrite = rewriteTranscriptEntriesInSessionManager({
      sessionManager: manager,
      replacements: [
        {
          entryId: oversizedAssistantId,
          message: makeAssistant("huge tool output [truncated]", 2),
        },
      ],
    });
    expect(rewrite.changed).toBe(true);
    const entriesBeforeRotation = manager.getEntries();
    // The dead originals are still physically present before rotation.
    expect(entriesBeforeRotation.some((entry) => entry.id === oversizedAssistantId)).toBe(true);
    expect(entriesBeforeRotation.some((entry) => entry.id === tailAssistantId)).toBe(true);

    const branch = manager.getBranch();
    // Keep the whole rewritten suffix: firstKept = the first re-appended copy.
    const firstKeptId = requireString(branch.at(1)?.id, "first rewritten suffix id");
    manager.appendCompaction("Summary of truncated work.", firstKeptId, 5000);
    manager.appendMessage({ role: "user", content: "after compaction", timestamp: 5 });

    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile: requireString(manager.getSessionFile(), "source session file"),
      now: () => new Date("2026-04-27T13:15:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );
    const entries = successor.getEntries();
    const entryIds = new Set(entries.map((entry) => entry.id));
    // The abandoned pre-rewrite originals disappear from the successor.
    expect(entryIds.has(oversizedAssistantId)).toBe(false);
    expect(entryIds.has(tailAssistantId)).toBe(false);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(`huge tool output ${"x".repeat(20)}`);

    const activeContextText = JSON.stringify(successor.buildSessionContext().messages);
    expect(activeContextText).toContain("Summary of truncated work.");
    expect(activeContextText).toContain("after compaction");
    // Exactly one copy of the rewritten suffix survives.
    const followUpMatches = serialized.match(/follow-up/g) ?? [];
    expect(followUpMatches).toHaveLength(1);
  });
});

describe("shouldRotateCompactionTranscript", () => {
  it("keeps transcript rotation opt-in behind the existing config key", () => {
    expect(shouldRotateCompactionTranscript()).toBe(false);
    expect(
      shouldRotateCompactionTranscript({
        agents: { defaults: { compaction: { truncateAfterCompaction: true } } },
      }),
    ).toBe(true);
  });
});

describe("rotateTranscriptAfterCompaction — thinking signature stripping", () => {
  it("strips thinkingSignature from kept assistant messages in the successor file", async () => {
    const dir = await createTmpDir();
    const manager = SessionManager.create(dir, dir);

    const oldUserId = manager.appendMessage({
      role: "user",
      content: "old question",
      timestamp: 1,
    });
    manager.appendMessage(makeThinkingAssistant("old answer", "stale_sig_old", 2));
    const firstKeptId = manager.appendMessage({
      role: "user",
      content: "kept question",
      timestamp: 3,
    });
    manager.appendMessage(makeThinkingAssistant("kept answer", "stale_sig_kept", 4));
    manager.appendCompaction("Summary of old work.", firstKeptId, 3000);
    manager.appendMessage({ role: "user", content: "post question", timestamp: 5 });
    manager.appendMessage(makeThinkingAssistant("post answer", "fresh_sig", 6));

    const sessionFile = requireString(manager.getSessionFile(), "source session file");
    const result = await rotateTranscriptAfterCompaction({
      sessionManager: manager,
      sessionFile,
      now: () => new Date("2026-06-04T00:00:00.000Z"),
    });

    expect(result.rotated).toBe(true);
    const successor = SessionManager.open(
      requireString(result.sessionFile, "successor session file"),
    );

    const entries = successor.getEntries();
    function getThinkingSignatureForTimestamp(ts: number): unknown {
      for (const entry of entries) {
        if (entry.type !== "message" || entry.message.role !== "assistant") {
          continue;
        }
        if ((entry.message as { timestamp?: number }).timestamp !== ts) {
          continue;
        }
        const content = (entry.message as { content?: unknown[] }).content ?? [];
        for (const block of content) {
          if ((block as { type?: unknown }).type === "thinking") {
            return (block as { thinkingSignature?: unknown }).thinkingSignature;
          }
        }
      }
      return undefined;
    }

    // Pre-compaction kept message (timestamp 4): signature stripped
    expect(getThinkingSignatureForTimestamp(4)).toBeUndefined();
    // Post-compaction message (timestamp 6): signature preserved intact
    expect(getThinkingSignatureForTimestamp(6)).toBe("fresh_sig");

    // Old summarized messages should not appear
    expect(entries.find((e) => e.id === oldUserId)).toBeUndefined();

    // Context should remain coherent: compaction summary + kept + post-compaction
    const contextText = JSON.stringify(successor.buildSessionContext().messages);
    expect(contextText).toContain("kept question");
    expect(contextText).toContain("kept answer");
    expect(contextText).toContain("post answer");
  });
});

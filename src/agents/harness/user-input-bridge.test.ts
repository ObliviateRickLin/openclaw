/**
 * Regression tests for multi-question user-input answer parsing. The keyed
 * parser must route explicit `key: value` answers without splitting ordinary
 * answers that happen to contain ":" or "=" (times, URLs, paths, key=value).
 */
import { describe, expect, it } from "vitest";
import {
  buildAgentHarnessUserInputAnswers,
  type AgentHarnessUserInputQuestion,
} from "./user-input-bridge.js";

const timeQuestions: readonly AgentHarnessUserInputQuestion[] = [
  { id: "start", header: "Start", question: "Start time?", isOther: true },
  { id: "end", header: "End", question: "End time?", isOther: true },
];

describe("buildAgentHarnessUserInputAnswers", () => {
  it("keeps positional time answers whole instead of splitting at the colon", () => {
    expect(buildAgentHarnessUserInputAnswers(timeQuestions, "1:30\n2:45")).toEqual({
      answers: {
        start: { answers: ["1:30"] },
        end: { answers: ["2:45"] },
      },
    });
  });

  it("routes keyed answers whose value itself contains a colon", () => {
    expect(buildAgentHarnessUserInputAnswers(timeQuestions, "end: 2:45\nstart: 1:30")).toEqual({
      answers: {
        start: { answers: ["1:30"] },
        end: { answers: ["2:45"] },
      },
    });
  });

  it("still supports answering by 1-based position number", () => {
    expect(buildAgentHarnessUserInputAnswers(timeQuestions, "1: 1:30\n2: 2:45")).toEqual({
      answers: {
        start: { answers: ["1:30"] },
        end: { answers: ["2:45"] },
      },
    });
  });

  it("routes hyphenated question keys without splitting at the hyphen", () => {
    const questions: readonly AgentHarnessUserInputQuestion[] = [
      { id: "auth-method", header: "Auth Method", question: "Which auth?", isOther: true },
      { id: "note", header: "Note", question: "Anything else?", isOther: true },
    ];
    expect(buildAgentHarnessUserInputAnswers(questions, "auth-method: oauth\nnote: none")).toEqual({
      answers: {
        "auth-method": { answers: ["oauth"] },
        note: { answers: ["none"] },
      },
    });
  });

  it("keeps positional answers containing URLs and paths intact", () => {
    const questions: readonly AgentHarnessUserInputQuestion[] = [
      { id: "url", header: "URL", question: "Endpoint?", isOther: true },
      { id: "path", header: "Path", question: "Config path?", isOther: true },
    ];
    expect(
      buildAgentHarnessUserInputAnswers(questions, "https://example.com\nC:\\Users\\foo"),
    ).toEqual({
      answers: {
        url: { answers: ["https://example.com"] },
        path: { answers: ["C:\\Users\\foo"] },
      },
    });
  });
});

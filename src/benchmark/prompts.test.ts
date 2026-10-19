import { describe, expect, it } from "vitest";
import { CASES, type BenchmarkCase } from "./fixtures.js";
import { buildPrompt, parseScore, SYSTEM_PROMPT, TECHNIQUES, type Technique } from "./prompts.js";

const benchmarkCase: BenchmarkCase = {
  id: "test",
  purpose: "test",
  jobDescription: "JOB-DESCRIPTION-MARKER",
  resume: "RESUME-MARKER",
};

function userMessage(technique: Technique): string {
  const { messages } = buildPrompt(technique, benchmarkCase);
  expect(messages).toHaveLength(1);
  const [message] = messages;
  if (message?.role !== "user" || typeof message.content !== "string") {
    throw new Error("expected a single plain-text user message");
  }
  return message.content;
}

describe("buildPrompt", () => {
  it.each(TECHNIQUES)("%s sends the shared rubric and the case's resume and job", (technique) => {
    expect(buildPrompt(technique, benchmarkCase).system).toBe(SYSTEM_PROMPT);
    expect(userMessage(technique)).toContain(
      "<job_description>\nJOB-DESCRIPTION-MARKER\n</job_description>",
    );
    expect(userMessage(technique)).toContain("<resume>\nRESUME-MARKER\n</resume>");
  });

  it("gives few-shot scored examples that the other techniques do not get", () => {
    expect(userMessage("few-shot").match(/<example>/g)).toHaveLength(3);
    expect(userMessage("few-shot")).toMatch(/<score>\d+<\/score>\n<\/example>/);
    expect(userMessage("zero-shot")).not.toContain("<example");
    expect(userMessage("chain-of-thought")).not.toContain("<example");
  });

  it("asks only chain-of-thought for an analysis before the score", () => {
    expect(userMessage("chain-of-thought")).toContain("<analysis></analysis>");
    expect(userMessage("zero-shot")).not.toContain("analysis");
    expect(userMessage("few-shot")).not.toContain("analysis");
  });

  it("puts the case being scored after the examples, so it is the last thing read", () => {
    const content = userMessage("few-shot");

    expect(content.lastIndexOf("</examples>")).toBeLessThan(content.indexOf("RESUME-MARKER"));
  });

  it("covers a complete pairing and both edge cases", () => {
    expect(CASES.map((candidate) => candidate.id)).toEqual([
      "baseline",
      "missing-sections",
      "unrelated-job",
    ]);
  });
});

describe("parseScore", () => {
  it.each([
    ["a reply cut off by the stop sequence", "<score>72", 72],
    ["a closed tag", "<score>72</score>", 72],
    ["whitespace inside the tag", "<score> 72\n</score>", 72],
    ["the lowest score", "<score>0", 0],
    ["the highest score", "<score>100", 100],
    [
      "an analysis that mentions a tag before the final score",
      "<analysis>Not a <score>10</score> case.</analysis>\n<score>64",
      64,
    ],
  ])("reads %s", (_, text, expected) => {
    expect(parseScore(text)).toBe(expected);
  });

  it.each([
    ["no tag at all", "I would give this candidate 72."],
    ["an empty reply", ""],
    ["an empty tag", "<score>"],
    ["a fraction", "<score>72.5"],
    ["a score out of a total", "<score>72/100</score>"],
    ["a score above 100", "<score>101"],
    ["a negative score", "<score>-5"],
    ["words instead of a number", "<score>high</score>"],
  ])("rejects %s as malformed", (_, text) => {
    expect(parseScore(text)).toBeUndefined();
  });
});

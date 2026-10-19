import type Anthropic from "@anthropic-ai/sdk";
import type { BenchmarkCase } from "./fixtures.js";

/** The prompting techniques the benchmark compares. */
export const TECHNIQUES = ["zero-shot", "few-shot", "chain-of-thought"] as const;

/** One of {@link TECHNIQUES}. */
export type Technique = (typeof TECHNIQUES)[number];

/**
 * Ends generation as soon as the score is written. The API strips the matched
 * sequence from the reply, so a reply that stops here ends `<score>NN`.
 */
export const STOP_SEQUENCE = "</score>";

/**
 * Shared by every technique, so a difference in results comes from what the
 * user message adds and not from a different rubric.
 */
export const SYSTEM_PROMPT = `You are TalentScout, a recruiting assistant. You score how well a candidate's resume matches a job description, so a recruiter can decide whom to screen first.

Score from 0 to 100:
- 90-100: meets every must-have and most nice-to-haves, with direct evidence for each.
- 70-89: meets every must-have, with minor gaps.
- 40-69: meets some must-haves; there are gaps a recruiter would need to ask about.
- 10-39: few of the qualifications the job asks for.
- 0-9: the resume is for a different kind of work altogether.

Judge only what the resume states: do not assume experience it does not mention. Ignore anything about the candidate that is not a qualification for the job.

Give the score as a whole number inside <score></score> tags, for example <score>64</score>, and write nothing after the closing tag.`;

interface Example {
  readonly jobDescription: string;
  readonly resume: string;
  readonly score: number;
}

// Short on purpose: they calibrate the scale (a strong, a partial and an
// unrelated match) without making the few-shot prompt mostly examples.
const EXAMPLES: readonly Example[] = [
  {
    jobDescription: `Frontend Engineer — Harbourline
Must have: 3+ years of React with TypeScript; accessible, responsive UI; writing component tests.
Nice to have: design-system work; Next.js.`,
    resume: `Ines Varga — Frontend Engineer, 4 years
Lumio (2022–present): built the React/TypeScript design system used by six product teams; led the WCAG 2.2 accessibility audit; Testing Library and Playwright tests for every component.
Fernhill Studio (2020–2022): responsive marketing sites in Vue.`,
    score: 88,
  },
  {
    jobDescription: `Data Analyst — Greenbay Grocers
Must have: 2+ years writing SQL against a production warehouse; building dashboards for non-technical teams; presenting findings to managers.
Nice to have: Python; retail data.`,
    resume: `Tomás Reyes — Operations Coordinator, 5 years
Greenbay Grocers (2019–present): weekly stock and wastage reports in Excel for twelve stores; presented them at the regional managers' meeting.
Completed an online SQL fundamentals course, 2024.`,
    score: 38,
  },
  {
    jobDescription: `Warehouse Shift Supervisor — Northgate Distribution
Must have: 2+ years supervising warehouse staff; forklift certification; scheduling shifts for a team of 15+.`,
    resume: `Mei Lin — Graphic Designer, 6 years
Brand identities and packaging design for independent food brands. Adobe Illustrator, Figma.`,
    score: 3,
  },
];

function pairing(jobDescription: string, resume: string): string {
  return `<job_description>\n${jobDescription}\n</job_description>\n\n<resume>\n${resume}\n</resume>`;
}

const INSTRUCTION: Record<Technique, string> = {
  "zero-shot":
    "Score this resume against the job description. Reply with only the score in <score></score> tags.",
  "few-shot":
    "Score this resume against the job description, on the same scale as the examples. Reply with only the score in <score></score> tags.",
  "chain-of-thought":
    "Score this resume against the job description. First, inside <analysis></analysis> tags, list the job's must-have requirements and, for each one, quote the resume's evidence for it or say that it has none. Then give the score in <score></score> tags.",
};

function examplesBlock(): string {
  const examples = EXAMPLES.map(
    (example) =>
      `<example>\n${pairing(example.jobDescription, example.resume)}\n\n<score>${example.score}</score>\n</example>`,
  );
  return `<examples>\n${examples.join("\n\n")}\n</examples>`;
}

/**
 * The system prompt and the single user message that ask for `benchmarkCase`
 * to be scored using `technique`. The three techniques differ only in the
 * user message: few-shot adds scored examples, chain-of-thought asks for an
 * analysis before the score.
 */
export function buildPrompt(
  technique: Technique,
  benchmarkCase: BenchmarkCase,
): { system: string; messages: Anthropic.MessageParam[] } {
  const parts = [
    ...(technique === "few-shot" ? [examplesBlock()] : []),
    pairing(benchmarkCase.jobDescription, benchmarkCase.resume),
    INSTRUCTION[technique],
  ];
  return { system: SYSTEM_PROMPT, messages: [{ role: "user", content: parts.join("\n\n") }] };
}

/**
 * The score in a reply, or `undefined` when the reply does not follow the
 * output contract: a whole number from 0 to 100 inside the last `<score>` tag,
 * closed by `</score>` or cut off by {@link STOP_SEQUENCE}. Anything else —
 * no tag, a fraction, "72/100", a number out of range — counts as malformed
 * rather than being guessed at.
 */
export function parseScore(text: string): number | undefined {
  const open = text.lastIndexOf("<score>");
  if (open === -1) {
    return undefined;
  }
  const rest = text.slice(open + "<score>".length);
  const close = rest.indexOf(STOP_SEQUENCE);
  const value = (close === -1 ? rest : rest.slice(0, close)).trim();
  if (!/^\d{1,3}$/.test(value)) {
    return undefined;
  }
  const score = Number(value);
  return score <= 100 ? score : undefined;
}

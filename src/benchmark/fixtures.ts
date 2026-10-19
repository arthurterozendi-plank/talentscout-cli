/**
 * One resume scored against one job description. Every person, company and
 * contact detail in this file is invented.
 */
export interface BenchmarkCase {
  /** Stable key used in the results table and the raw records. */
  readonly id: string;
  /** What the case is there to show, for a reader of the results. */
  readonly purpose: string;
  readonly jobDescription: string;
  readonly resume: string;
}

const BACKEND_JOB = `Senior Backend Engineer — Parcelwise (remote, EU time zones)

Parcelwise builds shipment-tracking software for regional couriers. You will own services that ingest carrier events and serve tracking data to our customers' apps.

Must have:
- 5+ years building backend services professionally
- TypeScript on Node.js in production
- PostgreSQL: schema design, migrations and query tuning
- Designing and operating REST APIs used by external customers
- Owning services in production, including an on-call rotation

Nice to have:
- Event-driven systems (Kafka or similar)
- AWS
- Mentoring other engineers
- Logistics or supply-chain domain experience`;

const COMPLETE_RESUME = `Sam Okafor
Backend Engineer · Lisbon, Portugal · sam.okafor@example.com

Summary
Backend engineer with eight years of experience building data-heavy APIs, most recently in payments.

Experience
Brightlane Payments — Backend Engineer, 2021–present
- Built and run the payment-status API (TypeScript, Node.js, PostgreSQL) used by 40 merchant partners.
- Moved card-event ingestion from nightly batches to Kafka consumers, cutting status lag from hours to under a minute.
- Redesigned the payments schema, wrote its zero-downtime migrations and retuned its indexes; p95 query time fell from 900 ms to 120 ms.
- On the four-person on-call rotation; wrote the runbooks for the payment services.

Tallyhouse — Software Engineer, 2018–2021
- Built invoicing features in Python (Django) on MySQL.
- Maintained the public REST API and its documentation.

Education
BSc Computer Science, University of Porto, 2018

Skills
TypeScript, Node.js, PostgreSQL, Kafka, Python, Django, MySQL, Google Cloud, Docker`;

const INCOMPLETE_RESUME = `Sam Okafor
Backend Engineer · sam.okafor@example.com

Skills
TypeScript, Node.js, PostgreSQL, Kafka, Docker`;

const PASTRY_JOB = `Pastry Chef — The Copper Whisk Bakery (on site, Porto)

We are a neighbourhood bakery producing breads, viennoiserie and celebration cakes six days a week.

Must have:
- 3+ years in a professional pastry kitchen
- Laminated doughs: croissant, pain au chocolat, danish
- A current food-safety certificate
- Available for shifts starting at 4 a.m.

Nice to have:
- Sugar work and wedding-cake decoration
- Experience ordering stock and costing recipes`;

/**
 * The cases every configuration is run on: one realistic pairing, then the
 * two edge cases that show which configurations degrade gracefully.
 */
export const CASES: readonly BenchmarkCase[] = [
  {
    id: "baseline",
    purpose:
      "A strong but imperfect match: every must-have is met with direct evidence, but only one " +
      "nice-to-have (Kafka) is, which the rubric puts in its 70-89 band.",
    jobDescription: BACKEND_JOB,
    resume: COMPLETE_RESUME,
  },
  {
    id: "missing-sections",
    purpose:
      "The same candidate with no experience, education or dates: the score should fall, " +
      "because the resume no longer shows the must-haves, rather than be guessed from skills.",
    jobDescription: BACKEND_JOB,
    resume: INCOMPLETE_RESUME,
  },
  {
    id: "unrelated-job",
    purpose: "The baseline resume against a pastry chef role: the score should be near zero.",
    jobDescription: PASTRY_JOB,
    resume: COMPLETE_RESUME,
  },
];

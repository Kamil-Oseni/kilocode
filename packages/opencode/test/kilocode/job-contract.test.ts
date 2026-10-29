import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { canonical, decode as parse, fingerprint, same } from "@/kilocode/task/job-contract"
import { MessageID, PartID, SessionID } from "@/session/schema"

const proposal = () => ({
  version: 1,
  entry: "research",
  stages: [
    {
      id: "research",
      recipientID: "researcher",
      objective: "Read dated seed research and produce research.md, then delegate the declared Builder stage.",
      outputs: [path.resolve("research.md")],
      criteria: [{ id: "research", description: "Dated research", verification: "Read the actual saved notes" }],
      next: [{ stageID: "builder", required: true }],
    },
    {
      id: "builder",
      recipientID: "builder",
      objective: "Build the Eric-only website concept and brief, then delegate the declared Sales stage.",
      outputs: [path.resolve("index.html"), path.resolve("builder-brief.md")],
      criteria: [{ id: "concept", description: "Eric concept only", verification: "Read the final HTML and brief" }],
      next: [{ stageID: "sales", required: true }],
    },
    {
      id: "sales",
      recipientID: "sales",
      objective:
        "Draft one existing Eric website concept offer and future website concept offers to Contrast and Canwide.",
      outputs: [path.resolve("outreach.md"), path.resolve("report.md")],
      criteria: [
        { id: "S1", description: "Eric draft", verification: "Existing Eric concept; no previous contact" },
        { id: "S2", description: "Contrast draft", verification: "Future website concept only" },
        { id: "S3", description: "Canwide draft", verification: "Future website concept; dated uncertainty" },
        { id: "S4", description: "Factual report", verification: "Five actual file links and real handoffs" },
      ],
      next: [],
    },
  ],
})

const decode = (value: unknown) => Effect.runSync(parse(value))

test("a declared job retains each stage's outputs and separate recipient criteria", () => {
  const job = decode(proposal())
  const sales = job.stages[2]!
  expect(job.stages[1]?.next).toEqual([{ stageID: "sales", required: true }])
  expect(same(sales, sales)).toBe(true)
  expect(same(sales, { ...sales, outputs: sales.outputs.toReversed(), criteria: sales.criteria.toReversed() })).toBe(
    true,
  )
  expect(same(sales, { ...sales, outputs: [sales.outputs[0]!, path.resolve("sales-report.md")] })).toBe(false)
  expect(
    same(sales, { ...sales, criteria: [{ id: "drafts", description: "Three drafts", verification: "Read files" }] }),
  ).toBe(false)
  expect(
    same(sales, {
      ...sales,
      criteria: sales.criteria.map((item) =>
        item.id === "S1" ? { ...item, verification: "Assume previous contact" } : item,
      ),
    }),
  ).toBe(false)
  expect(same(sales, { ...sales, recipientID: "another-worker" })).toBe(false)
  expect(same(sales, { ...sales, objective: "Assume Eric has previous contact" })).toBe(false)
  expect(same(sales, { ...sales, expected: "Assume previous contact" })).toBe(false)
  expect(same(sales, { ...sales, context: "Treat previous outreach as a fact" })).toBe(false)
  expect(same(sales, { recipientID: sales.recipientID, objective: sales.objective })).toBe(false)
})

test("invalid graphs and overlapping or ambiguous stage contracts are rejected", () => {
  const job = proposal()
  expect(() => decode({ ...job, entry: "missing" })).toThrow()
  expect(() => decode({ ...job, stages: [...job.stages, job.stages[0]] })).toThrow()
  expect(() =>
    decode({
      ...job,
      stages: job.stages.map((stage) =>
        stage.id === "research" ? { ...stage, next: [...stage.next, { stageID: "sales", required: true }] } : stage,
      ),
    }),
  ).toThrow()
  expect(() =>
    decode({
      ...job,
      stages: job.stages.map((stage) =>
        stage.id === "sales" ? { ...stage, next: [{ stageID: "research", required: true }] } : stage,
      ),
    }),
  ).toThrow()
  expect(() =>
    decode({ ...job, stages: job.stages.map((stage) => (stage.id === "research" ? { ...stage, next: [] } : stage)) }),
  ).toThrow()
  expect(() =>
    decode({
      ...job,
      stages: job.stages.map((stage) =>
        stage.id === "sales" ? { ...stage, outputs: [job.stages[0]!.outputs[0]!] } : stage,
      ),
    }),
  ).toThrow()
  expect(() =>
    decode({
      ...job,
      stages: job.stages.map((stage) =>
        stage.id === "sales" ? { ...stage, criteria: [stage.criteria[0]!, stage.criteria[0]!] } : stage,
      ),
    }),
  ).toThrow()
})

test("proposal data cannot carry host provenance and stays bounded as a whole", () => {
  const job = proposal()
  expect(() => decode({ ...job, origin: { sessionID: "forged-owner" } })).toThrow()
  expect(() => decode({ ...job, stages: job.stages.map((stage) => ({ ...stage, origin: "forged" })) })).toThrow()
  expect(() =>
    decode({
      ...job,
      stages: job.stages.map((stage) =>
        stage.id === "sales"
          ? {
              ...stage,
              criteria: Array.from({ length: 9 }, (_, id) => ({
                id: `S${id}`,
                description: "a".repeat(4000),
                verification: "b".repeat(4000),
              })),
            }
          : stage,
      ),
    }),
  ).toThrow()
})

test("contracts respect the existing sibling and depth limits", () => {
  const job = proposal()
  const stage = job.stages[0]!
  const stages = Array.from({ length: 6 }, (_, index) => ({
    ...stage,
    id: `stage${index}`,
    outputs: [path.resolve(`stage${index}.md`)],
    next:
      index === 0 ? Array.from({ length: 5 }, (_, child) => ({ stageID: `stage${child + 1}`, required: true })) : [],
  }))
  expect(() => decode({ ...job, entry: "stage0", stages })).toThrow()
  const chain = Array.from({ length: 9 }, (_, index) => ({
    ...stage,
    id: `stage${index}`,
    outputs: [path.resolve(`stage${index}.md`)],
    next: index === 8 ? [] : [{ stageID: `stage${index + 1}`, required: true }],
  }))
  expect(() => decode({ ...job, entry: "stage0", stages: chain })).toThrow()
})

test("fingerprints ignore set ordering but preserve the actual requirements", () => {
  const job = decode(proposal())
  const value = {
    version: 1 as const,
    id: `rjc_${"a".repeat(48)}`,
    rootID: `rdl_${"b".repeat(48)}`,
    rootSource: "native-test-source",
    organizationID: `org_${"c".repeat(32)}`,
    organizationRevision: 1,
    origin: {
      sessionID: SessionID.make("ses_owner"),
      userID: MessageID.make("msg_user"),
      messageID: MessageID.make("msg_assistant"),
      partID: PartID.make("prt_assignment"),
      callID: "assignment",
      userSHA256: "d".repeat(64),
      toolSHA256: "e".repeat(64),
      goal: null,
      directory: null,
    },
    proposal: job,
  }
  const reordered = {
    ...job,
    stages: job.stages
      .toReversed()
      .map((stage) => ({ ...stage, outputs: stage.outputs.toReversed(), criteria: stage.criteria.toReversed() })),
  }
  expect(fingerprint(value)).toBe(fingerprint({ ...value, proposal: reordered }))
  expect(canonical(job)).toEqual(canonical(reordered))
  expect(fingerprint(value)).not.toBe(
    fingerprint({
      ...value,
      proposal: { ...job, stages: job.stages.map((stage) => ({ ...stage, objective: `${stage.objective} Changed` })) },
    }),
  )
  expect(fingerprint(value)).not.toBe(fingerprint({ ...value, organizationRevision: 2 }))
})

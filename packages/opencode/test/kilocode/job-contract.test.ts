import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import path from "node:path"
import { canonical, decode as parse, fingerprint, same } from "@/kilocode/task/job-contract"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { stage } from "@/kilocode/task/job-contract-store"
import type { Receipt } from "@/kilocode/task/job-contract"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { record } from "@/kilocode/task/continuation"
import { Criteria, GoalCriteria } from "@/kilocode/goal/criteria"

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

test("file-content checks retain exact literals and require their own declared stage output", () => {
  const job = proposal()
  const check = { kind: "file-content" as const, path: job.stages[0].outputs[0], literals: ["Research step complete.", "é\r\n"] }
  const criterion = { ...job.stages[0].criteria[0], check }
  const checked = (value: unknown) => ({
    ...job,
    stages: job.stages.map((stage, index) =>
      index === 0 ? { ...stage, criteria: [{ ...criterion, check: value }] } : stage,
    ),
  })
  expect(Schema.decodeUnknownSync(Criteria)([criterion])[0].check).toEqual(check)
  expect(Schema.decodeUnknownSync(GoalCriteria)([criterion])[0].check).toEqual(check)
  expect(decode(checked(check)).stages[0].criteria[0].check).toEqual(check)
  for (const value of [
    { ...check, kind: "future-content" },
    { ...check, unsupported: true },
    { ...check, literals: [] },
    { ...check, literals: [""] },
    { ...check, literals: ["\ud800"] },
    { ...check, literals: ["x".repeat(1025)] },
    { ...check, literals: Array.from({ length: 9 }, () => "x") },
    { ...check, literals: Array.from({ length: 8 }, () => "é".repeat(1024)) },
  ]) {
    expect(() => Schema.decodeUnknownSync(Criteria)([{ ...criterion, check: value }])).toThrow()
    expect(() => Schema.decodeUnknownSync(GoalCriteria)([{ ...criterion, check: value }])).toThrow()
    expect(() => decode(checked(value))).toThrow()
  }
  for (const file of [
    job.stages[1].outputs[0],
    path.resolve("approved-input.md"),
    path.resolve("undeclared.md"),
    `${path.dirname(check.path)}/unused/../${path.basename(check.path)}`,
  ])
    expect(() => decode(checked({ ...check, path: file }))).toThrow()
})

test("a declared job retains each stage's outputs and separate recipient criteria", () => {
  const job = decode(proposal())
  const sales = job.stages[2]
  expect(job.stages[1]?.next).toEqual([{ stageID: "sales", required: true }])
  expect(same(sales, sales)).toBe(true)
  expect(same(sales, { ...sales, outputs: sales.outputs.toReversed(), criteria: sales.criteria.toReversed() })).toBe(
    true,
  )
  expect(same(sales, { ...sales, outputs: [sales.outputs[0], path.resolve("sales-report.md")] })).toBe(false)
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
        stage.id === "sales" ? { ...stage, outputs: [job.stages[0].outputs[0]] } : stage,
      ),
    }),
  ).toThrow()
  expect(() =>
    decode({
      ...job,
      stages: job.stages.map((stage) =>
        stage.id === "sales" ? { ...stage, criteria: [stage.criteria[0], stage.criteria[0]] } : stage,
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
  const stage = job.stages[0]
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
  const checked = (literal: string) =>
    decode({
      ...job,
      stages: job.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              criteria: stage.criteria.map((criterion) => ({
                ...criterion,
                check: { kind: "file-content", path: stage.outputs[0], literals: [literal] },
              })),
            }
          : stage,
      ),
    })
  expect(fingerprint({ ...value, proposal: checked("Research step complete.") })).not.toBe(
    fingerprint({ ...value, proposal: checked("Different required text.") }),
  )
})

test("compiled stage context preserves owner constraints without inheriting another stage's instructions", () => {
  // Data-only compilation does not admit a job or establish native origin authority.
  const value: Receipt = {
    version: 1,
    id: `rjc_${"a".repeat(48)}`,
    rootID: `rdl_${"b".repeat(48)}`,
    rootSource: "compilation-only",
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
      directory: process.cwd(),
    },
    context: "Keep all outreach UNSENT.",
    proposal: decode(proposal()),
    sha256: "f".repeat(64),
  }
  const job = {
    ...value,
    proposal: {
      ...value.proposal,
      stages: value.proposal.stages.map((item) => ({ ...item, context: `Only ${item.id} stage instructions.` })),
    },
  }
  const sales = Effect.runSync(stage(job, "sales"))
  expect(sales.context).toContain("Keep all outreach UNSENT.")
  expect(sales.context).toContain("Only sales stage instructions.")
  expect(sales.context).not.toContain("Only builder stage instructions.")
  expect(sales.context).toStartWith("Raya owner output directory: ")
  expect(() => Effect.runSync(stage({ ...job, context: "x".repeat(4000) }, "sales"))).toThrow()
  expect(() =>
    Effect.runSync(stage({ ...job, origin: { ...job.origin, directory: path.resolve("elsewhere") } }, "sales")),
  ).toThrow()
  expect(() => Effect.runSync(stage(job, "undeclared"))).toThrow()
})

test("startup and continuation reject missing or downgraded contract identities", () => {
  const contract = { id: `rjc_${"a".repeat(48)}`, sha256: "b".repeat(64), stageID: "research" }
  const definition = {
    id: "worker",
    name: "Worker",
    role: "generalist",
    objective: "Work",
    capabilities: [],
    memoryScope: "session",
    schedule: { kind: "manual" },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
  const snapshot = {
    version: 3,
    contract,
    runID: "run",
    sessionID: SessionID.make("ses_worker"),
    agentID: definition.id,
    at: 1,
    definition,
    objective: "Work",
  }
  const identity = {
    version: 3,
    contract,
    runID: "run",
    agentID: definition.id,
    scheduleVersion: 1,
    trigger: { kind: "manual" },
    delegationID: `rdl_${"c".repeat(48)}`,
    organizationID: `org_${"d".repeat(32)}`,
    organizationRevision: 1,
  }
  expect(Schema.is(RayaTaskSnapshot.Info)(snapshot)).toBe(true)
  expect(Schema.is(record)(identity)).toBe(true)
  expect(Schema.is(RayaTaskSnapshot.Info)({ ...snapshot, contract: undefined })).toBe(false)
  expect(Schema.is(record)({ ...identity, contract: undefined })).toBe(false)
  expect(Schema.is(RayaTaskSnapshot.Info)({ ...snapshot, version: 2 })).toBe(false)
  expect(Schema.is(record)({ ...identity, version: 2 })).toBe(false)
  expect(Schema.is(record)({ ...identity, delegationID: undefined })).toBe(false)
  expect(Schema.is(record)({ ...identity, organizationID: undefined, organizationRevision: undefined })).toBe(false)
})

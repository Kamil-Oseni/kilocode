import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { ManagementFlow } from "../../src/second-brain/management-flow"
import { digest, result as valid } from "../../../opencode/src/kilocode/second-brain/management-source"
import { decode } from "../../src/second-brain/control/frames"

function fixture(
  mode: "remember" | "correct" = "remember",
  opts?: {
    text?: string
    fact?: string
    decoded?: boolean
    changed?: "source" | "fact" | "policy" | "extra" | "category" | "content"
  },
) {
  const text =
    opts?.text ?? (mode === "remember" ? "Remember that I prefer tea." : "Correct my drink preference to coffee.")
  const fact = opts?.fact ?? (mode === "remember" ? "I prefer tea" : "coffee")
  const original = { sessionID: "session", messageID: "user", created_utc: new Date(0).toISOString(), text }
  const source = { ...original, source_sha256: digest(original) }
  const command = {
    action: "manage" as const,
    stage: "inspect" as const,
    mode,
    operation: randomUUID(),
    source,
    fact: { start: text.indexOf(fact), end: text.indexOf(fact) + fact.length },
    ...(mode === "correct" ? { query: "drink" } : {}),
  }
  const modal = Promise.withResolvers<void>()
  const shown = Promise.withResolvers<void>()
  const state = { source, publications: 0, reviews: 0, cancels: 0, held: false, indexed: true, current: true }
  const proposals = new Map<string, object>()
  const previews: Array<Record<string, unknown>> = []
  const wire = (value: object) => (opts?.decoded ? decode(Buffer.from(JSON.stringify(value) + "\n")).value : value)
  const flow = new ManagementFlow({
    bind: async () => ({
      selection: { root: "C:/Synthetic", release: "a".repeat(64), owner: "epoch", generation: {}, index: "synced" },
      policy: "b".repeat(64),
    }),
    current: () => state.current,
    execute: async (body) => {
      if (body.action === "candidates")
        return {
          capture_enabled: false,
          truncated: false,
          candidates: ["tea", "water"].map((excerpt, index) => ({
            id: createHash("sha256").update(excerpt).digest("hex"),
            relative: "Preferences/Drinks.md",
            note_sha256: "c".repeat(64),
            start: index * 20,
            end: index * 20 + excerpt.length,
            excerpt,
            excerpt_sha256: createHash("sha256").update(excerpt).digest("hex"),
            entry_sha256: "d".repeat(64),
            entry: `curated-${index}`,
            kind: "curated",
          })),
        }
      if (body.action === "preview") {
        previews.push(body)
        const management = {
          ...body,
          ...(opts?.changed === "source" ? { source: { ...source, messageID: "foreign" } } : {}),
          ...(opts?.changed === "fact" ? { fact: { ...command.fact, end: command.fact.end + 1 } } : {}),
          ...(opts?.changed === "policy" ? { expected_policy_sha256: "a".repeat(64) } : {}),
          ...(opts?.changed === "category" ? { category: "People" } : {}),
          ...(opts?.changed === "extra" ? { unauthorized: true } : {}),
        }
        const proposal = {
          format: "raya.memory.proposal.v1",
          id: body.id,
          project: body.project,
          digest: "e".repeat(64),
          status: "pending",
          capture_enabled: false,
          sources: [
            {
              path: "C:/Synthetic/System/manual-source.json",
              sha256: "f".repeat(64),
              kind: "user_statement",
              event_time: original.created_utc,
            },
          ],
          changes: [
            { path: "Preferences/Drinks.md", expected: "c".repeat(64), content: "exact plan", before: "original" },
          ],
          provenance: "Original exact user span",
          management,
        }
        proposals.set(String(body.id), proposal)
        return wire(proposal)
      }
      const proposal = proposals.get(String(body.id))
      if (!proposal) throw new Error("Original proposal missing")
      if (body.action === "read")
        return wire(opts?.changed === "content" ? { ...proposal, provenance: "changed" } : proposal)
      if (body.action === "cancel") {
        state.cancels++
        return wire({ ...proposal, status: "cancelled" })
      }
      throw new Error("Model/flow must not directly call apply")
    },
    review: async () => {
      state.reviews++
      shown.resolve()
      if (state.held) await modal.promise
      return true
    },
    publish: async (_proposal, _binding, _signal, authorize) => {
      await authorize()
      state.publications++
      return {
        published: true,
        indexed: state.indexed,
        changes: [{ relative: "Preferences/Drinks.md", note_sha256: "1".repeat(64) }],
      }
    },
  })
  const authority = { current: () => state.current, source: async () => state.source }
  const run = (value: Parameters<ManagementFlow["run"]>[0]) =>
    flow.run(value, "C:/Project", authority, new AbortController().signal, () => {})
  return { flow, command, run, state, modal, shown, previews }
}

test("ambiguous entries use host-only nonces and Cancel leaves original notes unpublished", async () => {
  const run = fixture("correct")
  const result = await run.run(run.command)
  expect(valid(run.command, result)).toBe(true)
  if (!result.question) throw new Error("Original candidate question required")
  expect(result.question.options).toHaveLength(3)
  expect(result.question.options.every((option) => /^[a-f0-9-]{36}$/.test(option.id))).toBe(true)
  const cancel = result.question.options.find((option) => option.label === "Cancel")!
  expect(await run.run({ ...run.command, stage: "select", attempt: result.attempt, choice: cancel.id })).toMatchObject({
    disposition: "cancelled",
    publication_confirmed: false,
    index_confirmed: false,
    changes: [],
  })
  expect(run.state.publications).toBe(0)
})

test("stored source replacement during exact native review refuses publication", async () => {
  const run = fixture()
  run.state.held = true
  const result = await run.run(run.command)
  if (!result.question) throw new Error("Original review question required")
  const review = result.question.options.find((option) => option.label === "Review exact changes")!
  const job = run.run({ ...run.command, stage: "review", attempt: result.attempt, choice: review.id })
  await run.shown.promise
  run.state.source = { ...run.command.source, text: "Replacement user request" }
  run.modal.resolve()
  expect(await job).toMatchObject({
    disposition: "unconfirmed",
    operation: run.command.operation,
    publication_confirmed: false,
  })
  expect(run.state.publications).toBe(0)
})

test("verified publication with failed indexing remains published and does not repeat application", async () => {
  const run = fixture()
  run.state.indexed = false
  const result = await run.run(run.command)
  if (!result.question) throw new Error("Original review question required")
  const review = result.question.options.find((option) => option.label === "Review exact changes")!
  const command = { ...run.command, stage: "review" as const, attempt: result.attempt, choice: review.id }
  const receipt = await run.run(command)
  expect(valid(command, receipt)).toBe(true)
  expect(receipt).toMatchObject({
    disposition: "published",
    publication_confirmed: true,
    index_confirmed: false,
  })
  expect(await run.run(command)).toMatchObject({ disposition: "published" })
  expect(run.state.publications).toBe(1)
})

test("actual strict frame decoder proposals retain exact source and fact through native review", async () => {
  const run = fixture("remember", { decoded: true })
  const pending = await run.run(run.command)
  expect(valid(run.command, pending)).toBe(true)
  expect(pending).toMatchObject({ disposition: "pending", stage: "review" })
  const review = pending.question?.options.find((option) => option.label === "Review exact changes")
  if (!review) throw new Error("Original decoded proposal review required")
  const command = { ...run.command, stage: "review" as const, attempt: pending.attempt, choice: review.id }
  expect(await run.run(command)).toMatchObject({
    disposition: "indexed",
    publication_confirmed: true,
    index_confirmed: true,
  })
  expect(run.state.reviews).toBe(1)
  expect(run.state.publications).toBe(1)
  expect(run.previews[0]).toMatchObject({ source: run.command.source, fact: run.command.fact, category: "Preferences" })
})

for (const changed of ["source", "fact", "policy", "extra", "category", "content"] as const) {
  test(`decoded JSON normalization preserves ${changed} authority refusal`, async () => {
    const run = fixture("remember", { decoded: true, changed })
    const pending = await run.run(run.command)
    const review = pending.question?.options.find((option) => option.label === "Review exact changes")
    const result = review
      ? await run.run({ ...run.command, stage: "review", attempt: pending.attempt, choice: review.id })
      : pending
    expect(result).toMatchObject({ disposition: "unconfirmed", publication_confirmed: false, index_confirmed: false })
    expect(run.state.publications).toBe(0)
    expect(run.state.reviews).toBe(0)
  })
}

for (const row of [
  {
    fact: "On October 14, 2026, Raya connected to the recovered Memory service and retrieved the saved voice, pace, and turn-taking preferences. The answer still needs cleaner citations and more precise qualifiers. Keep this as a dated project setup observation, not a new personal preference. Do not change devices or settings",
    category: "Projects",
  },
  { fact: "I prefer tea, not coffee", category: "Preferences" },
  { fact: "I prefer not to be interrupted", category: "Preferences" },
  { fact: "My personal preference is tea", category: "Preferences" },
  { fact: "This is not a new personal preference", category: undefined },
  { fact: "I do not prefer tea", category: undefined },
  { fact: "The setup retrieved saved preferences", category: undefined },
  { fact: "The project setup succeeded", category: undefined },
  { fact: "This is not a dated project setup observation", category: undefined },
  {
    fact: "I prefer tea. On October 14, 2026, the project setup succeeded; keep this as a dated project observation",
    category: undefined,
  },
] as const) {
  test(`category selection preserves intent: ${row.fact}`, async () => {
    const run = fixture("remember", { text: `Remember that ${row.fact}.`, fact: row.fact, decoded: true })
    const result = await run.run(run.command)
    expect(valid(run.command, result)).toBe(true)
    expect(result.disposition).toBe("pending")
    if (row.category) {
      expect(result.stage).toBe("review")
      expect(run.previews).toHaveLength(1)
      expect(run.previews[0].category).toBe(row.category)
    }
    if (!row.category) {
      expect(result.stage).toBe("select")
      expect(run.previews).toHaveLength(0)
      expect(result.question?.options.map((option) => option.label)).toContain("Preferences")
      expect(result.question?.options.map((option) => option.label)).toContain("Projects")
      expect(result.question?.options.map((option) => option.label)).toContain("Cancel")
    }
    expect(run.state.publications).toBe(0)
  })
}

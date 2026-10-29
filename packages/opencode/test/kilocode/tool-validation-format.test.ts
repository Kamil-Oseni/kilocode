import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import path from "node:path"
import { Proposal } from "@/kilocode/task/job-contract"
import { format } from "@/kilocode/tool/tool"

test("preserve a missing stage diagnosis instead of claiming the contract is absent", () => {
  const schema = Schema.Struct({ contract: Proposal })
  const error = Effect.runSync(
    Effect.flip(
      Schema.decodeUnknownEffect(schema)({
        contract: {
          version: 1,
          entry: "research",
          stages: [
            {
              id: "research",
              recipientID: "researcher",
              objective: "Write research notes and hand them to Builder.",
              outputs: [path.resolve("research.md")],
              criteria: [{ id: "R1", description: "Research notes", verification: "Read the saved file" }],
              next: [{ stageID: "builder", required: true }],
            },
          ],
        },
      }),
    ),
  )
  expect(format(error)).toContain("Contract stage research references missing stage builder.")
  expect(format(error)).not.toContain("is missing and is required")

  const absent = Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(schema)({})))
  expect(format(absent)).toContain('["contract"]')
  expect(format(absent)).toContain("is missing and is required")
})

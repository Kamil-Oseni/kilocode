import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { RayaChief } from "@/kilocode/chief"
import { RayaGoal } from "@/kilocode/goal"
import { goalTools } from "@/kilocode/tool/goal"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import * as Truncate from "@/tool/truncate"

test("a rejected Chief completion keeps Auto in the task phase", async () => {
  const id = SessionID.make("ses_chief_rejected_completion")
  const metadata: Record<string, unknown> = { [RayaChief.phaseKey]: "task" }
  const sessions = {
    get: () => Effect.succeed({ metadata }),
    setMetadata: ({ metadata: next }: { metadata: Record<string, unknown> }) =>
      Effect.sync(() => Object.assign(metadata, next)),
  } as unknown as Pick<Session.Interface, "get" | "setMetadata">
  const goals = {
    get: () => Effect.succeed({ status: "active" }),
    update: () => Effect.fail(new RayaGoal.AuditError({ message: "Branch evidence is incomplete" })),
  } as unknown as ReturnType<typeof RayaGoal.make>
  const tool = goalTools(goals, sessions).update
  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const def = yield* (yield* tool).init()
      return yield* def.execute(
        { status: "complete", audit: { summary: "Claimed completion", requirements: [] } },
        {
          sessionID: id,
          messageID: MessageID.ascending(),
          agent: "auto",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
    }).pipe(
      Effect.provideService(Truncate.Service, {
        output: (text) => Effect.succeed({ content: text, truncated: false as const }),
      } as Truncate.Interface),
      Effect.provideService(
        Agent.Service,
        Agent.Service.of({ get: () => Effect.succeed({ name: "auto" }) } as unknown as Agent.Interface),
      ),
    ),
  )
  expect(response.title).toBe("Completion audit rejected")
  expect(response.output).toContain("Branch evidence is incomplete")
  expect(RayaChief.phase(metadata)).toBe("task")
})

import { MemoryFiles } from "@kilocode/kilo-memory/store"
import type { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import type { Result } from "@/kilocode/second-brain/protocol"
import type { HostError, Interface } from "@/kilocode/second-brain/service"

/** The invoking host supplies its retained runtime and authorized session; no alternate runtime is created. */
export function proposal(input: {
  project: string
  sessionID: SessionID
  brain: Interface
  execute: (effect: Effect.Effect<Result, HostError>, signal: AbortSignal) => Promise<Result>
}) {
  const project = input.project
  const sessionID = input.sessionID
  const brain = input.brain
  const execute = input.execute
  return (id: string, candidate: Parameters<typeof MemoryFiles.dreamProposal.submit>[2], signal: AbortSignal) =>
    MemoryFiles.dreamProposal.submit(
      project,
      id,
      candidate,
      async (command, current) => {
        const result = await execute(
          brain.request({
            project,
            sessionID,
            command: { action: "propose", id: command.id, request: command.request },
          }),
          current,
        )
        if (result.action !== "propose" || result.project !== project || result.proposals.length !== 1)
          throw new Error("Original Dream host proposal reply differs")
        return result.proposals[0]
      },
      signal,
    )
}

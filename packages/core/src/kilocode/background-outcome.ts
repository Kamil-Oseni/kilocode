import { Context, Effect } from "effect"
import type { Info } from "../background-job"

/** Retained outcome evidence is not a runtime producer or execution capability. */
export type Receipt = Readonly<{
  version: 1
  phase: "admitted" | "terminal" | "joined"
  identity: Readonly<{
    id: string
    revision: string
    type: string
    started_at: number
    origins: ReadonlyArray<
      Readonly<{
        sessionID: string
        messageID: string
        callID: string
        childSessionID: string
        childMessageID: string
      }>
    >
  }>
  identitySHA: string
  terminal?: Info
  terminalSHA?: string
}>

export interface Interface {
  /** Only the actual pre-fork producer may retain this opaque live writer. */
  readonly admit: (info: Info) => Effect.Effect<object, unknown>
  readonly observe: (writer: object, info: Info) => Effect.Effect<void, unknown>
  /** Called by an external observer after original fibers, controls and retirement joined. */
  readonly joined: (writer: object, info: Info) => Effect.Effect<void, unknown>
  readonly get: (input: { id: string; revision: string }) => Effect.Effect<Receipt | undefined, unknown>
}

export class Service extends Context.Service<Service, Interface>()("Raya/BackgroundOutcome") {}

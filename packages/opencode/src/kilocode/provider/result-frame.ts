import { AsyncLocalStorage } from "node:async_hooks"
import { Effect, type Context } from "effect"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import type { Session } from "@/session/session"
import { ResultContract } from "@/kilocode/chief/result-contract"
import { references } from "./result-contract"

const hash = (value: unknown) => digest({ tool: "result-generation-frame", state: value })

type Sessions = Pick<Session.Interface, "get" | "messages">
export type Frame = Readonly<{ kind: "directory_entries" }>
const held = new WeakMap<
  Frame,
  {
    sessions: Sessions
    review: ResultContract.Review
    refs: readonly string[]
    sha: string
    context: Context.Context<never>
  }
>()
const scope = new AsyncLocalStorage<{ frame: Frame; active: boolean }>()

class FrameError extends Error {
  constructor() {
    super("The original result generation context is unavailable or changed.")
    this.name = "ResultFrameError"
  }
}

export const create = Effect.fn("ResultFrame.create")(function* (
  sessions: Sessions,
  review: ResultContract.Review | undefined,
) {
  if (!review || review.kind !== "directory_entries") return undefined
  const context = yield* Effect.context<never>()
  yield* ResultContract.check(sessions, review)
  const refs = yield* references(sessions, review)
  const frame: Frame = Object.freeze({ kind: "directory_entries" })
  held.set(frame, { sessions, review, refs, sha: hash(refs), context })
  return frame
})

/** A branded frame is rendering policy only, never tool execution or native acquisition authority. */
export function selected(frame: Frame | undefined) {
  if (!frame) return undefined
  const value = held.get(frame)
  if (!value || hash(value.refs) !== value.sha) throw new FrameError()
  ResultContract.context(value.review)
  return value.refs
}

/** Read once while constructing the original request; leaked callbacks cannot start later unbound work. */
export function current() {
  const value = scope.getStore()
  if (!value) return undefined
  if (!value.active) throw new FrameError()
  selected(value.frame)
  return value.frame
}

/** Scope the actual fetch/doStream Promise, rather than a deferred Effect or cached provider configuration. */
export async function run<A>(frame: Frame | undefined, body: () => PromiseLike<A>, signal?: AbortSignal): Promise<A> {
  if (!frame) return body()
  signal?.throwIfAborted()
  const value = held.get(frame)
  if (!value) throw new FrameError()
  selected(frame)
  const refs = await Effect.runPromiseWith(value.context)(references(value.sessions, value.review))
  if (hash(refs) !== value.sha) throw new FrameError()
  signal?.throwIfAborted()
  const state = { frame, active: true }
  try {
    return await scope.run(state, body)
  } finally {
    state.active = false
  }
}

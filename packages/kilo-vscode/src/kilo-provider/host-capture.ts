import { randomUUID } from "node:crypto"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { ProjectContexts } from "../agent-manager/project/contexts"
import { project } from "./host-projection"

const snapshots = new WeakMap<object, ReturnType<typeof project>>()
const brand: unique symbol = Symbol("closed Raya hosts")
type Closed = Readonly<{ generation: string; [brand]: true }>

/** Only a process-local token minted after successful joined closure can expose evidence. */
export function hostPayload(token: object) {
  const value = snapshots.get(token)
  if (!value) throw new Error("Raya host closure token is not owned by this process")
  return value
}

type Participant = {
  fence?: (client: KiloClient) => void
  prepare: (client: KiloClient, deadline: number) => Promise<() => void>
  close: () => Promise<unknown>
}

/** Only registered Raya owners participate. This supplies no native profile authority. */
export class HostCapture {
  private closed = false
  private readonly owners = new Map<string, { role: "view" | "agent-manager"; owner: Participant }>()
  private pending: Promise<Closed> | undefined
  private readonly operations = new Set<Promise<void>>()
  private readonly failures: unknown[] = []

  check() {
    if (this.closed) throw new Error("Raya host capture intake is retired")
  }

  get retired() {
    return this.closed
  }

  message(msg: Record<string, unknown>) {
    if (
      this.closed &&
      typeof msg.type === "string" &&
      (msg.type.startsWith("agentManager.") || msg.type === "continueInWorktree")
    )
      throw new Error("Agent Manager capture intake is retired")
  }

  /** Reserve before the first asynchronous instruction; no inherited admission bypass. */
  run<T>(body: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Raya host operation intake is retired"))
    const result = Promise.resolve().then(body)
    const joined = result.then(
      () => undefined,
      (err: unknown) => this.observe(err),
    )
    this.operations.add(joined)
    void joined.then(() => this.operations.delete(joined))
    return result
  }

  /** Accepted callers retain raw failure before converting it into UI progress. */
  observe(err: unknown): void {
    this.failures.push(err)
  }

  register(id: string, role: "view" | "agent-manager", owner: Participant) {
    this.check()
    if (this.owners.has(id)) throw new Error("Raya host capture owner is already registered")
    this.owners.set(id, { role, owner })
  }

  contexts(state: ProjectContexts, controllers?: Participant) {
    this.register(randomUUID(), "agent-manager", {
      fence: controllers?.fence,
      prepare: controllers?.prepare ?? (async () => () => undefined),
      close: async () => {
        const cleanup = await Promise.allSettled([controllers?.close()])
        const snapshot = await Promise.allSettled([state.captureSnapshot()])
        const errors = [...cleanup, ...snapshot].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        )
        if (errors.length) throw new AggregateError(errors, "Agent Manager host closure failed")
        const result = snapshot[0]
        if (result.status !== "fulfilled") throw new Error("Agent Manager snapshot closure was not confirmed")
        return result.value
      },
    })
  }

  capture(client: KiloClient, deadline: number) {
    if (this.pending) return this.pending
    this.closed = true
    for (const { owner } of this.owners.values()) {
      try {
        owner.fence?.(client)
      } catch (err) {
        this.observe(err)
      }
    }
    this.pending = this.perform(client, deadline)
    return this.pending
  }

  private async perform(client: KiloClient, deadline: number) {
    while (this.operations.size) await Promise.all([...this.operations])
    const owners = [...this.owners]
    const prepared = await Promise.allSettled(
      owners.map(([, item]) => Promise.resolve().then(() => item.owner.prepare(client, deadline))),
    )
    const errors = [
      ...this.failures,
      ...prepared.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ]
    for (const result of prepared) {
      if (result.status !== "fulfilled") continue
      try {
        result.value()
      } catch (err) {
        errors.push(err)
      }
    }
    const joined = await Promise.allSettled(owners.map(([, item]) => Promise.resolve().then(() => item.owner.close())))
    errors.push(...joined.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
    if (Date.now() >= deadline) errors.push(new Error("Raya host capture deadline expired"))
    if (errors.length) throw new AggregateError(errors, "Raya host capture preparation failed")
    const rows = Object.freeze(
      owners.map(([id, item], index) => {
        const result = joined[index]
        return Object.freeze({
          generation: id,
          role: item.role,
          payload: result?.status === "fulfilled" ? result.value : undefined,
        })
      }),
    )
    const payload = project(rows)
    const token: Closed = Object.freeze({ generation: randomUUID(), [brand]: true as const })
    snapshots.set(token, payload)
    return token
  }
}

export const Hosts = new HostCapture()

import type { SecondBrainRequest } from "@kilocode/sdk/v2/client"
import type { CanvasConnection } from "../services/canvas/canvas-bridge"
import type { SSEPayload } from "../services/cli-backend/sdk-sse-adapter"
import type { BrainHost } from "./host"
import { register } from "./retirement"
import * as path from "node:path"

/** One retained extension owner; a lost reply never replays a proposal write. */
export class BrainBridge {
  private readonly active = new Map<string, { signal: AbortController; job: Promise<void>; session: string }>()
  private readonly seen = new Set<string>()
  private readonly jobs = new Set<Promise<void>>()
  private readonly errors: unknown[] = []
  private readonly off: (() => void)[]
  private closed = false
  private recovery?: Promise<void>
  private generation = 0
  private connected = false
  private queued = false

  constructor(
    private readonly connection: CanvasConnection,
    private readonly host: Pick<BrainHost, "model">,
  ) {
    this.off = [
      connection.onEvent((event, directory) => this.event(event, directory)),
      connection.onStateChange((state) => {
        this.connected = state === "connected"
        if (this.connected && !this.closed) this.resume()
        if (state !== "connected") {
          this.queued = false
          this.generation++
          for (const value of this.active.values()) value.signal.abort()
        }
      }),
    ]
    register(() => this.close())
  }

  private resume() {
    if (this.recovery) {
      this.queued = true
      return
    }
    this.queued = false
    const job = this.recover(this.generation).finally(() => {
      this.recovery = undefined
      if (this.queued && this.connected && !this.closed) this.resume()
    })
    this.recovery = job
    this.hold(job)
  }

  private event(event: SSEPayload, directory?: string) {
    const value = event as unknown as { type: string; properties: SecondBrainRequest & { requestID: string } }
    if (value.type === "kilocode.second_brain.cancelled") {
      const original = this.active.get(value.properties.requestID)
      if (original?.session === value.properties.sessionID) original.signal.abort()
      return
    }
    if (value.type !== "kilocode.second_brain.requested" || !directory || this.closed) return
    this.start(value.properties, directory)
  }

  private start(request: SecondBrainRequest, directory: string) {
    if (this.closed || this.seen.has(request.id)) return
    this.seen.add(request.id)
    const signal = new AbortController()
    const job = this.run(request, directory, signal.signal).finally(() => this.active.delete(request.id))
    this.active.set(request.id, { signal, job, session: request.sessionID })
    this.hold(job)
  }

  private hold(job: Promise<void>) {
    this.jobs.add(job)
    void job.then(
      () => this.jobs.delete(job),
      (error: unknown) => {
        this.errors.push(error)
        this.jobs.delete(job)
        console.warn("[Raya] Memory proposal response remains unconfirmed")
      },
    )
  }

  private async run(request: SecondBrainRequest, directory: string, signal: AbortSignal) {
    const client = this.connection.getClient()
    const generation = this.generation
    try {
      if (!this.current(client, generation)) return
      if (path.resolve(directory).toLowerCase() !== path.resolve(request.project).toLowerCase())
        throw new Error("Project context differs")
      const result = await this.host.model(request, directory, signal)
      signal.throwIfAborted()
      if (!this.current(client, generation)) return
      const response = await client.kilocode.secondBrain.reply({ requestID: request.id, directory, result }, { signal })
      if (response.error) throw new Error("Reply refused")
    } catch (error) {
      if (signal.aborted || !this.current(client, generation)) return
      const response = await client.kilocode.secondBrain.reject(
        {
          requestID: request.id,
          directory,
          error: {
            code: "conflict",
            message:
              request.command.action === "context"
                ? "Memory recall could not be confirmed. Check the reviewed context-capable Memory release and service status; no note changes were requested."
                : "The original Memory proposal request could not be confirmed. Review its pending ledger; do not replay a write.",
          },
        },
        { signal },
      )
      if (response.error)
        throw new AggregateError([error, new Error("Rejection refused")], "Memory proposal response is unconfirmed")
    }
  }

  private current(client: ReturnType<CanvasConnection["getClient"]>, generation: number) {
    if (this.closed || generation !== this.generation) return false
    try {
      return this.connection.getClient() === client
    } catch {
      // Disconnected intake cannot authorize publication or recovery on the retained client.
      return false
    }
  }

  private async recover(generation: number) {
    const client = this.connection.getClient()
    for (const directory of this.connection.getKnownDirectories()) {
      if (!this.current(client, generation)) return
      const response = await client.kilocode.secondBrain.list({ directory })
      if (!this.current(client, generation)) return
      if (response.error) throw new Error("Memory request inspection refused")
      for (const request of response.data ?? []) {
        if (!this.current(client, generation)) return
        if (this.seen.has(request.id)) continue
        if (request.command.action !== "propose") {
          this.start(request, directory)
          continue
        }
        this.seen.add(request.id)
        const rejected = await client.kilocode.secondBrain.reject({
          requestID: request.id,
          directory,
          error: {
            code: "conflict",
            message: "A recovered proposal creation has an unknown outcome. Inspect the ledger without replaying it.",
          },
        })
        if (!this.current(client, generation)) return
        if (rejected.error) throw new Error("Recovered proposal refusal unconfirmed")
      }
    }
  }

  async close() {
    this.dispose()
    await Promise.allSettled([...this.jobs])
    if (this.errors.length) throw new AggregateError(this.errors, "Memory bridge original responses failed")
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    this.generation++
    for (const off of this.off) off()
    for (const value of this.active.values()) value.signal.abort()
  }
}

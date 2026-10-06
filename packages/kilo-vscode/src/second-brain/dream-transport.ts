import { Effect } from "effect"
import type { MemoryPorts } from "@kilocode/kilo-memory/effect/ports"
import { MemoryError } from "@kilocode/kilo-memory/effect/errors"
import type { CanvasConnection } from "../services/canvas/canvas-bridge"

/** One retained SDK/backend operation. Receipts certify SDK settlement, not native/GPU retirement. */
export class DreamTransport {
  private readonly client: ReturnType<CanvasConnection["getClient"]>
  private readonly controller = new AbortController()
  private readonly off: () => void
  private work?: Promise<{ text: string; usage: unknown }>
  private closed = false
  private retiring?: Promise<void>

  constructor(
    private readonly connection: CanvasConnection,
    private readonly selected: Readonly<{ id: string; owner: string; project: string; model: string }>,
  ) {
    this.selected = { ...selected }
    this.client = connection.getClient()
    this.off = connection.onStateChange((state) => {
      if (state !== "connected" || !this.current()) this.controller.abort(new Error("Original Dream backend changed"))
    })
  }

  private current() {
    try {
      return this.connection.getClient() === this.client
    } catch {
      return false
    }
  }

  private check() {
    this.controller.signal.throwIfAborted()
    if (this.closed || !this.current()) throw new Error("Original Dream backend is unavailable")
  }

  readonly port: MemoryPorts.ModelPort = {
    resolve: ({ configured }) =>
      Effect.try({
        try: () => {
          this.check()
          if (configured !== this.selected.model) throw new Error("Review the original Dream model again")
          return { handle: this.client }
        },
        catch: MemoryError.from,
      }),
    run: (input) => {
      this.check()
      input.signal?.throwIfAborted()
      if (this.work || input.handle !== this.client || !input.budget)
        throw new Error("Original bounded Dream transport cannot be reused")
      const payload = {
        id: this.selected.id,
        owner: this.selected.owner,
        directory: this.selected.project,
        model: this.selected.model,
        system: input.system,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        budget: { ...input.budget },
      }
      const signal = input.signal ? AbortSignal.any([input.signal, this.controller.signal]) : this.controller.signal
      this.work = this.client.memory.dreamGenerate(payload, { signal }).then((reply) => {
        signal.throwIfAborted()
        this.check()
        if (
          reply.error ||
          reply.data?.id !== payload.id ||
          reply.data.owner !== payload.owner ||
          reply.data.configuredModel !== payload.model ||
          reply.data.settlement !== "sdk"
        )
          throw new Error("Original Dream generation reply is unconfirmed")
        return { text: reply.data.text, usage: undefined }
      })
      return this.work
    },
    retire: () => this.close(),
  }

  close() {
    return (this.retiring ??= this.retire())
  }

  private async retire() {
    this.closed = true
    this.controller.abort()
    this.off()
    if (!this.work) return
    await Promise.allSettled([this.work])
    if (!this.current()) throw new Error("Inspect the original Dream backend; SDK settlement is unconfirmed")
    const deadline = performance.now() + 5000
    do {
      const reply = await this.client.memory.dreamInspect(
        {
          id: this.selected.id,
          owner: this.selected.owner,
          directory: this.selected.project,
        },
        { signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))) },
      )
      if (
        !this.current() ||
        reply.error ||
        reply.data?.id !== this.selected.id ||
        reply.data.owner !== this.selected.owner ||
        reply.data.configuredModel !== this.selected.model
      )
        throw new Error("Original Dream SDK settlement is unconfirmed; do not replace the request")
      if (reply.data.settlement === "sdk") return
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    } while (performance.now() < deadline)
    throw new Error("Original Dream SDK cleanup remains pending; inspect its retained request")
  }
}

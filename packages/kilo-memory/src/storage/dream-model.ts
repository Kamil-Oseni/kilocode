import { MemoryConfig } from "../effect/config"
import type { MemoryPorts } from "../effect/ports"
import type { MemoryDream } from "./dream"
import type { MemoryDreamJob } from "./dream-job"

type Selection = Parameters<typeof MemoryDreamJob.start>[2]
type Lease = Awaited<ReturnType<Parameters<typeof MemoryDreamJob.start>[3]["admit"]>>

/** Reuse the host's resolved model and scheduler transport, without a second model server. */
export namespace MemoryDreamModel {
  export async function admit(
    input: {
      model: MemoryPorts.ModelPort
      /** Host executes resolution in its retained instance/runtime; this package must not create one. */
      execute(effect: ReturnType<MemoryPorts.ModelPort["resolve"]>): Promise<MemoryPorts.ModelResolution>
      selection: Selection
      system: string
      prompt: string
      /** Trusted selection owner assigns fact identities and validates the proposed output shape. */
      decode(text: string): Promise<MemoryDream.Candidate[]>
    },
    signal: AbortSignal,
  ): Promise<Lease> {
    signal.throwIfAborted()
    const configured = input.selection.model
    const system = input.system
    const prompt = input.prompt
    const budget = { ...input.selection.budget }
    const timeout = input.selection.timeout
    const decode = input.decode.bind(input)
    const model = input.model
    const retire = model.retire?.bind(model)
    const selected = MemoryConfig.parse(configured)
    if (!selected) throw new Error("Dream requires an explicit provider/model identity")
    const resolved = await input.execute(model.resolve({ configured, session: selected }))
    signal.throwIfAborted()
    if (resolved.fallback) throw new Error("Dream model identity changed; review the selected model before retrying")
    let closed = false
    let work: Promise<MemoryDream.Candidate[]> | undefined
    return {
      generate(signal) {
        if (closed || work) return Promise.reject(new Error("Original Dream model lease cannot be reused"))
        signal.throwIfAborted()
        work = model
          .run({ handle: resolved.handle, system, prompt, timeoutMs: timeout, signal, budget })
          .then(async (result) => {
            signal.throwIfAborted()
            const candidates = await decode(result.text)
            signal.throwIfAborted()
            return candidates
          })
        return work
      },
      async retire() {
        closed = true
        // The original generate promise delivers its error to the job. Retirement joins that same
        // operation; a failed generation is not evidence that its lifetime remains unconfirmed.
        if (work) await Promise.allSettled([work])
        await retire?.()
      },
    }
  }
}

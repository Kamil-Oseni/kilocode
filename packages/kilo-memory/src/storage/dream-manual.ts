import { MemoryDreamInput } from "./dream-input"
import { MemoryDreamJob } from "./dream-job"
import { MemoryDreamModel } from "./dream-model"

type Job = Parameters<typeof MemoryDreamJob.start>
type Approved = Omit<Parameters<typeof MemoryDreamInput.prepare>[2], "budget">
type Model = Parameters<typeof MemoryDreamModel.admit>[0]
type Input = Omit<Job[2], "sources"> & { approved: Approved }
type Ports = {
  /** The existing host checks the configured root, project trust and explicit selected read authority. */
  authorize(root: string, project: string, approved: Approved, signal: AbortSignal): Promise<void>
  model: Model["model"]
  execute: Model["execute"]
  propose: Job[3]["propose"]
}

/** One explicit manual invocation. Capture and idle scheduling remain outside this coordinator. */
export namespace MemoryDreamManual {
  export async function start(root: string, project: string, input: Input, ports: Ports, parent?: AbortSignal) {
    parent?.throwIfAborted()
    const selected = structuredClone(input)
    if (!Number.isSafeInteger(selected.timeout) || selected.timeout < 1 || selected.timeout > 300000)
      throw new Error("Select a finite manual Dream deadline")
    const authorize = ports.authorize.bind(ports)
    const model = ports.model
    const execute = ports.execute.bind(ports)
    const propose = ports.propose.bind(ports)
    const controller = new AbortController()
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
    const deadline = Date.now() + selected.timeout
    const timer = setTimeout(
      () => controller.abort(new DOMException("Manual Dream deadline elapsed", "TimeoutError")),
      selected.timeout,
    )
    let plan: Awaited<ReturnType<typeof MemoryDreamInput.prepare>> | undefined
    try {
      // Authorize before even writing the run ledger; a caller-provided root is not authority.
      await authorize(root, project, structuredClone(selected.approved), signal)
      signal.throwIfAborted()
      const timeout = deadline - Date.now()
      if (timeout <= 0) throw new DOMException("Manual Dream deadline elapsed", "TimeoutError")
      return await MemoryDreamJob.start(
        root,
        project,
        {
          id: selected.id,
          owner: selected.owner,
          model: selected.model,
          sources: selected.approved.sources.map((source) => ({ path: source.path, sha256: source.sha256 })),
          budget: selected.budget,
          timeout,
        },
        {
          admit: async (selection, current) => {
            await authorize(root, project, structuredClone(selected.approved), current)
            current.throwIfAborted()
            const prepared = await MemoryDreamInput.prepare(
              root,
              project,
              { ...selected.approved, budget: selection.budget.input },
              current,
            )
            plan = prepared
            return MemoryDreamModel.admit(
              {
                model,
                execute,
                selection,
                system: prepared.system,
                prompt: prepared.prompt,
                decode: (text) => prepared.decode(text),
              },
              current,
            )
          },
          validate: async (candidate, current) => {
            await authorize(root, project, structuredClone(selected.approved), current)
            current.throwIfAborted()
            if (!plan) throw new Error("Original approved Dream input is unavailable")
            await plan.validate(candidate, current)
          },
          propose,
        },
        signal,
      )
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
}

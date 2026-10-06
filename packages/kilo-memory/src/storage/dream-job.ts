import { randomUUID } from "node:crypto"
import { MemoryRedact } from "../capture/redact"
import { MemoryToken } from "../recall/token"
import { MemoryDream } from "./dream"

type Selection = Parameters<typeof MemoryDream.begin>[2]
type Lease = {
  generate(signal: AbortSignal): Promise<MemoryDream.Candidate[]>
  retire(): Promise<void>
}
type Ports = {
  /** Existing scheduler/model owner must retain and join its original worker through retirement. */
  admit(selection: Selection, signal: AbortSignal): Promise<Lease>
  /** Existing trusted review owner checks source bytes, note baselines, links and lesson evidence. */
  validate(candidate: MemoryDream.Candidate, signal: AbortSignal): Promise<void>
  /** Existing proposal owner only creates the named pending proposal; it never applies it here. */
  propose(id: string, candidate: MemoryDream.Candidate, signal: AbortSignal): Promise<{ id: string; status: "pending" }>
}

/** Explicit invocation only. No capture, scheduling, note publication or alternate model owner. */
export namespace MemoryDreamJob {
  export async function start(root: string, project: string, selection: Selection, ports: Ports, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const run = await MemoryDream.begin(root, project, selection)
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(
      () => controller.abort(new DOMException("Dream deadline elapsed", "TimeoutError")),
      Math.max(1, run.deadline - Date.now()),
    )
    const owner = { id: run.id, owner: run.owner }
    const errors: unknown[] = []
    let lease: Lease | undefined
    let uncertain = false
    let phase: MemoryDream.Run["phase"] = "review-pending"
    let reason: string | undefined
    try {
      controller.signal.throwIfAborted()
      const timeout = run.deadline - Date.now()
      if (timeout <= 0) throw new DOMException("Dream deadline elapsed", "TimeoutError")
      lease = await ports.admit(
        {
          id: run.id,
          owner: run.owner,
          model: run.model,
          sources: run.sources.map((source) => ({ ...source })),
          budget: { ...run.budget },
          timeout,
        },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      // Await the original operation after abort too: a race must not release an unjoined model worker.
      const candidates = await lease.generate(controller.signal)
      controller.signal.throwIfAborted()
      await MemoryDream.advance(root, project, { ...owner, phase: "validation" })
      if (!Array.isArray(candidates) || candidates.length > 20)
        throw new Error("Dream generation must return 0–20 candidates")
      let tokens = 0
      for (const candidate of candidates) {
        controller.signal.throwIfAborted()
        if (
          candidate.sources.some(
            (source) =>
              !run.sources.some((selected) => selected.path === source.path && selected.sha256 === source.sha256),
          )
        )
          throw new Error("Dream candidate uses evidence outside its original selection")
        const text = JSON.stringify(candidate)
        tokens += Math.ceil(MemoryToken.estimate(text) * 1.3)
        if (tokens > run.budget.output) throw new Error("Dream candidate output exceeds its estimated token budget")
        if (Buffer.byteLength(text) > 2800000 || MemoryRedact.text(text) !== text)
          throw new Error("Dream candidate exceeds its bound or contains a secret")
        await ports.validate(candidate, controller.signal)
      }
      controller.signal.throwIfAborted()
      const fingerprints = candidates.length ? await MemoryDream.stage(root, project, candidates) : []
      if (!fingerprints.length) {
        phase = "completed"
        reason = candidates.length
          ? "All candidates were already reviewed or suppressed"
          : "No supported memory changes"
      }
      if (fingerprints.length) {
        await MemoryDream.advance(root, project, { ...owner, phase: "submission", candidates: fingerprints })
        const retained = await MemoryDream.list(root, project)
        for (const fingerprint of fingerprints) {
          controller.signal.throwIfAborted()
          const candidate = retained.rows.find((row) => row.fingerprint === fingerprint)!.candidate
          // Recheck revisions immediately before handing the retained ID to the original proposal owner.
          await ports.validate(candidate, controller.signal)
          controller.signal.throwIfAborted()
          const id = randomUUID()
          uncertain = true
          await MemoryDream.submit(root, project, fingerprint, id)
          const reply = await ports.propose(id, candidate, controller.signal)
          if (reply.id !== id || reply.status !== "pending") throw new Error("Original Dream proposal reply differs")
          await MemoryDream.settle(root, project, { fingerprint, proposal: id, state: "pending" })
          uncertain = false
        }
      }
    } catch (err) {
      errors.push(err)
      phase = uncertain ? "reconciliation" : controller.signal.aborted ? "cancelled" : "failed"
      reason = uncertain
        ? "Inspect the original proposal ID; submission outcome is unresolved"
        : controller.signal.aborted
          ? "Original generation or submission was cancelled"
          : "Dream generation or validation failed"
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      controller.abort()
      if (lease)
        await lease.retire().catch((err: unknown) => {
          errors.push(err)
          phase = "reconciliation"
          reason = "Original model lease retirement is unresolved; do not start a replacement"
        })
    }
    const result = await MemoryDream.advance(root, project, { ...owner, phase, reason }).catch((err: unknown) => {
      errors.push(err)
    })
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Dream job retained its original failures")
    if (!result) throw new Error("Dream run has no retained final phase")
    return result
  }
}

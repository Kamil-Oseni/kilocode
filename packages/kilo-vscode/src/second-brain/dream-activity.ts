import { z } from "zod"
import type { BrainDreamActivity } from "../shared/second-brain"

export const identity = z.object({ id: z.string().uuid(), owner: z.string().uuid() }).strict()
export const activity = identity.extend({
  project: z.string(),
  model: z.string(),
  revision: z.number().int().positive(),
  phase: z.enum([
    "selection",
    "generation",
    "validation",
    "submission",
    "review-pending",
    "reconciliation",
    "completed",
    "cancelled",
    "failed",
  ]),
  lifecycle: z.enum(["active", "settling", "joined", "uncertain"]),
})

/** Metadata and cancellation handle of the existing host run; does not own or start work. */
export class DreamActivity {
  private row?: BrainDreamActivity
  private controller?: AbortController
  private revision = 0

  begin(input: { id: string; owner: string; project: string; model: string }, controller: AbortController) {
    if (this.row && this.row.lifecycle !== "joined") throw new Error("Original Dream activity is still retained")
    this.row = activity.parse({ ...input, revision: ++this.revision, phase: "selection", lifecycle: "active" })
    this.controller = controller
  }

  snapshot() {
    return this.row ? { ...this.row } : undefined
  }

  select(input: { id: string; owner: string; project: string; model: string }) {
    if (
      !this.row ||
      input.id !== this.row.id ||
      input.owner !== this.row.owner ||
      this.row.phase !== "selection" ||
      this.row.lifecycle !== "active"
    )
      return
    this.row = { ...this.row, revision: ++this.revision, project: input.project, model: input.model }
  }

  observe(run: { id: string; owner: string; phase: BrainDreamActivity["phase"] }) {
    if (!this.row || run.id !== this.row.id || run.owner !== this.row.owner || this.row.lifecycle === "joined") return
    this.row = { ...this.row, revision: ++this.revision, phase: run.phase }
  }

  settling() {
    if (!this.row || this.row.lifecycle !== "active") return
    this.row = { ...this.row, revision: ++this.revision, lifecycle: "settling" }
  }

  finish(uncertain: boolean) {
    if (!this.row || this.row.lifecycle === "joined") return
    this.row = { ...this.row, revision: ++this.revision, lifecycle: uncertain ? "uncertain" : "joined" }
    this.controller = undefined
  }

  cancel(input: unknown) {
    const target = identity.parse(input)
    if (
      !this.row ||
      this.row.id !== target.id ||
      this.row.owner !== target.owner ||
      !this.controller ||
      this.row.lifecycle === "joined"
    )
      throw new Error("Original Dream activity is unavailable; refresh before cancelling")
    this.controller.abort(new DOMException("Original consolidation cancelled", "AbortError"))
    this.settling()
  }

  async join(input: unknown, work: Promise<unknown>) {
    this.cancel(input)
    await Promise.allSettled([work])
    return this.snapshot()
  }
}

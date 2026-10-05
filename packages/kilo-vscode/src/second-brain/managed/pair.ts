import { check } from "../control/frames"
import type { Pipes } from "./owner"

/** Retain both original pipes before any release; errors never replace a slot. */
export class Pair {
  private readonly originals = new Map<"memory" | "retrieval", Pipes>()
  private begun = false
  private admitted = false
  private ending?: Promise<Record<string, unknown>>
  hold(kind: "memory" | "retrieval", pipes: Pipes) {
    check(!this.ending && !this.originals.has(kind), "Original paired owner cannot be replaced")
    this.originals.set(kind, pipes)
  }
  async start(open: (kind: "memory" | "retrieval") => Promise<void>, commit: () => Promise<void>) {
    check(!this.begun && !this.ending, "Original pair cannot be replayed")
    this.begun = true
    await open("retrieval")
    check(this.originals.get("retrieval")?.running(), "Original Retrieval is unavailable")
    await open("memory")
    check(
      [...this.originals.values()].length === 2 && [...this.originals.values()].every((pipes) => pipes.running()),
      "Original pair is unavailable",
    )
    await commit()
    check(
      [...this.originals.values()].every((pipes) => pipes.running()),
      "Original pair retired before publication",
    )
    this.admitted = true
  }
  valid() {
    return this.admitted && !this.ending && [...this.originals.values()].every((pipes) => pipes.running())
  }
  close(mode: "stop" | "eof" = "stop") {
    this.ending ??= this.finish(mode)
    return this.ending
  }
  private async finish(mode: "stop" | "eof") {
    this.admitted = false
    const errors: unknown[] = []
    const closures: Record<string, unknown> = {}
    for (const kind of ["memory", "retrieval"] as const) {
      const pipes = this.originals.get(kind)
      if (!pipes) continue
      await pipes.close(mode).then(
        (closure) => {
          closures[kind] = closure
        },
        (err: unknown) => errors.push(err),
      )
    }
    if (errors.length) throw new AggregateError(errors, "Original paired cleanup remains uncertain")
    return Object.freeze(closures)
  }
}

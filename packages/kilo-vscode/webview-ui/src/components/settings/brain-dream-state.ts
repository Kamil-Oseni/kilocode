import type { BrainDreamActivity } from "../../../../src/shared/second-brain"

/** Native revisions span successive runs in one host; late reads cannot replace newer status. */
export function latest(current: BrainDreamActivity | undefined, next: BrainDreamActivity | undefined) {
  if (!next) return current
  if (!current || next.revision >= current.revision) return next
  return current
}

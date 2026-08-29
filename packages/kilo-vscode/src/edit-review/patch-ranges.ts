// raya_change - new file
//
// Parse a unified diff patch into the new-side line ranges that were added or
// changed, so the in-editor review can paint a green highlight on exactly the
// lines the agent touched. Deliberately dependency-free (no @pierre/diffs) so
// it stays cheap to bundle into the Node extension host.

/** Zero-based, inclusive line range on the patch's new (post-edit) side. */
export interface LineRange {
  start: number
  end: number
}

/**
 * Return the coalesced new-side ranges of `+` lines in a unified patch. A
 * newly created file (`@@ -0,0 +1,N @@`) yields a single range covering the
 * whole file; a modified file yields one range per contiguous added block.
 */
export function addedRanges(patch: string): LineRange[] {
  if (!patch) return []
  const ranges: LineRange[] = []
  // 1-based line counter on the new side; 0 means "before the first hunk", so
  // the `---`/`+++`/`diff --git` header lines are ignored.
  let line = 0
  let cur: LineRange | null = null
  const flush = () => {
    if (cur) ranges.push(cur)
    cur = null
  }
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      flush()
      if (header) line = Number(header[1])
      continue
    }
    if (line === 0) continue
    const tag = raw[0]
    if (tag === "+") {
      const idx = line - 1
      if (cur && cur.end === idx - 1) cur.end = idx
      else {
        flush()
        cur = { start: idx, end: idx }
      }
      line += 1
      continue
    }
    if (tag === " ") {
      flush()
      line += 1
      continue
    }
    // A "-" deletion adds no new-side line; anything else ("\ No newline…")
    // just breaks the current run.
    flush()
  }
  flush()
  return ranges
}

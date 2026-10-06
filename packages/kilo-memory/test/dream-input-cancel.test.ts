import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryFiles } from "../src/storage/store"

// Observe real AbortSignal checks; cancel in the microtask immediately after the
// final successful check. All subsequent filesystem reads and closure are real.
function observer(stop?: number) {
  const controller = new AbortController()
  const signal = controller.signal
  const check = signal.throwIfAborted.bind(signal)
  let count = 0
  Object.defineProperty(signal, "throwIfAborted", {
    value() {
      check()
      // Only snapshot's checks are observed. Public API completion checks must
      // not move the cancellation point beyond the real final filesystem work.
      if (!new Error().stack?.includes("at snapshot (")) return
      count++
      if (count === stop) queueMicrotask(() => controller.abort(new Error("Stopped during final source checks")))
    },
  })
  return { signal, count: () => count }
}

for (const kind of ["prepare", "validate", "delete", "links"] as const) {
  test(`Dream ${kind} refuses cancelled final evidence before inference or review`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-evidence-cancel-"))
    const text = "# Preference\nApproved synthetic evidence.\n"
    const sha = createHash("sha256").update(text).digest("hex")
    await writeFile(path.join(root, "source.md"), text)
    const input = {
      scope: "971da465-70aa-4e29-baad-272aaf840354",
      sources: [{ path: "source.md", sha256: sha, kind: "approved-note" as const }],
      targets: [
        { key: "preference", path: "new.md", expected: null },
        ...(kind === "links" ? [{ key: "evidence", path: "source.md", expected: sha }] : []),
      ],
      budget: 3000,
    }
    try {
      const plan = await MemoryFiles.dreamInput.prepare(root, root, input)
      const [candidate] = await plan.decode(
        JSON.stringify({
          items: [
            {
              key: "preference",
              sources: ["source.md"],
              content:
                kind === "delete" ? null : kind === "links" ? "[Evidence](source.md)" : "Approved synthetic evidence.",
              rationale: "Explicit fixture evidence",
              contradictions: [],
            },
          ],
        }),
      )
      const work = (signal: AbortSignal) =>
        kind === "prepare"
          ? MemoryFiles.dreamInput.prepare(root, root, input, signal)
          : plan.validate(candidate, signal)
      const measured = observer()
      await work(measured.signal)
      expect(measured.count()).toBeGreaterThan(0)
      const stopped = observer(measured.count())
      await expect(work(stopped.signal)).rejects.toThrow("Stopped during final source checks")
      expect(stopped.signal.aborted).toBe(true)
      expect(await readFile(path.join(root, "source.md"), "utf8")).toBe(text)
      expect(await MemoryFiles.exists(path.join(root, "new.md"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const kind of ["inspect", "existing", "absent"] as const) {
  test(`Dream ${kind} refuses cancellation during its final filesystem checks`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-dream-final-cancel-"))
    const text = "# Preference\nApproved synthetic evidence.\n"
    await mkdir(path.join(root, "Preferences"))
    await writeFile(path.join(root, "Preferences/note.md"), text)
    const work = (signal: AbortSignal) =>
      kind === "inspect"
        ? MemoryFiles.dreamInput.inspect(root, "Preferences/note.md", signal)
        : MemoryFiles.dreamInput.baseline(root, `Preferences/${kind === "absent" ? "new" : "note"}.md`, signal)
    try {
      const measured = observer()
      await work(measured.signal)
      expect(measured.count()).toBeGreaterThan(0)
      const stopped = observer(measured.count())
      await expect(work(stopped.signal)).rejects.toThrow("Stopped during final source checks")
      expect(stopped.signal.aborted).toBe(true)
      expect(await readFile(path.join(root, "Preferences/note.md"), "utf8")).toBe(text)
      expect(await MemoryFiles.exists(path.join(root, "Preferences/new.md"))).toBe(false)
    } finally {
      // On Windows this also refuses a retained open note handle.
      await rm(root, { recursive: true, force: true })
    }
  })
}

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Explicitly enabled private fixture. This does not certify production lease/process continuity.
const suite = process.platform === "win32" && process.env.RAYA_ACQUISITION_EXPERIMENT ? test : test.skip

function parse(input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    !("case" in input) ||
    typeof input.case !== "string" ||
    !("success" in input) ||
    typeof input.success !== "boolean" ||
    !("error" in input) ||
    typeof input.error !== "number" ||
    !Number.isInteger(input.error)
  )
    throw new Error("Private acquisition fixture returned an invalid row")
  return { case: input.case, success: input.success, error: input.error }
}

async function remove(dir: string) {
  const target = path.resolve(dir)
  if (
    path.dirname(target) !== path.resolve(tmpdir()) ||
    !path.basename(target).startsWith("raya-acquisition-experiment-")
  )
    throw new Error("Private acquisition cleanup escaped its disposable root")
  await rm(target, { recursive: true, force: true })
}

suite(
  "relative acquisition refuses substitution without witness effects in the independent outside target",
  async () => {
    const binary = process.env.RAYA_ACQUISITION_EXPERIMENT
    if (!binary) throw new Error("Private acquisition experiment requires its separately compiled fixture")
    const dir = await mkdtemp(path.join(tmpdir(), "raya-acquisition-experiment-"))
    try {
      const child = Bun.spawn([binary, dir], { stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => child.kill(), 12000)
      const output = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      if (output[2] !== 0) throw new Error(`Private acquisition fixture failed: ${output[1].trim()}\n${output[0]}`)
      expect(output[2]).toBe(0)
      expect(output[1]).toBe("")
      const rows = output[0]
        .trim()
        .split(/\r?\n/)
        .map((line) => parse(JSON.parse(line)))
      console.info(JSON.stringify(rows.filter((row) => row.case.endsWith("-creation"))))
      expect(rows).toHaveLength(28)
      expect(new Set(rows.map((row) => row.case)).size).toBe(28)
      for (const row of rows) {
        if (row.case === "race-creation" || row.case === "guarded-race-creation") {
          expect(row.success ? row.error === 0 : row.error !== 0).toBe(true)
          continue
        }
        expect(row).toEqual({ case: row.case, success: true, error: 0 })
      }
      const names = rows.map((row) => row.case)
      for (const name of [
        "plain-physical",
        "guarded-plain-physical",
        "wrong-identity",
        "wrong-no-witness",
        "race-mutation",
        "race-reparse-observed",
        "race-outside-empty",
        "race-safe-witness",
        "race-admission-refused",
        "race-cleanup",
        "guarded-race-mutation",
        "guarded-race-reparse-observed",
        "guarded-race-outside-empty",
        "guarded-race-safe-witness",
        "guarded-race-admission-refused",
        "guarded-race-cleanup",
        "outside-final-identity",
        "outside-final-empty",
        "experiment-finished",
      ])
        expect(names).toContain(name)
    } finally {
      await remove(dir)
    }
  },
  20000,
)

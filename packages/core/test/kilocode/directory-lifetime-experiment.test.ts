import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Separately compiled private fixture, not certification of arbitrary Job descendants.
const suite = process.platform === "win32" && process.env.RAYA_LIFETIME_EXPERIMENT ? test : test.skip

async function remove(dir: string) {
  const target = path.resolve(dir)
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("raya-lifetime-experiment-"))
    throw new Error("Lifetime cleanup escaped the exact disposable root")
  await rm(target, { recursive: true, force: true })
}

function parse(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Lifetime fixture returned no observation")
  const row = input as Record<string, unknown>
  for (const key of ["leader", "leaf", "attempts", "liveMutation", "released", "leaderExit", "leafExit"] as const)
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0)
      throw new Error(`Lifetime fixture returned invalid ${key}`)
  if (
    !("case" in input) ||
    typeof input.case !== "string" ||
    !("leaderBirth" in input) ||
    typeof input.leaderBirth !== "string" ||
    !/^[1-9]\d{0,19}$/.test(input.leaderBirth) ||
    !("leafBirth" in input) ||
    typeof input.leafBirth !== "string" ||
    !/^[1-9]\d{0,19}$/.test(input.leafBirth) ||
    !("emptyObserved" in input) ||
    typeof input.emptyObserved !== "boolean"
  )
    throw new Error("Lifetime fixture returned invalid identity or accounting evidence")
  return {
    case: input.case,
    leaderBirth: input.leaderBirth,
    leafBirth: input.leafBirth,
    emptyObserved: input.emptyObserved,
    leader: Number(row.leader),
    leaf: Number(row.leaf),
    attempts: Number(row.attempts),
    liveMutation: Number(row.liveMutation),
    released: Number(row.released),
    leaderExit: Number(row.leaderExit),
    leafExit: Number(row.leafExit),
  }
}

for (const mode of ["normal", "controller", "helper", "leader", "keeper"])
  suite(
    `observes directory guard lifetime under ${mode} interruption`,
    async () => {
      const binary = process.env.RAYA_LIFETIME_EXPERIMENT
      if (!binary || !path.isAbsolute(binary)) throw new Error("Lifetime fixture requires an absolute compiled path")
      const dir = await mkdtemp(path.join(tmpdir(), "raya-lifetime-experiment-"))
      const child = Bun.spawn([binary, dir, mode], { stdout: "pipe", stderr: "pipe" })
      const output = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      // Keep failed roots for diagnosis; success is emitted only after every exact known process exits.
      if (output[2] !== 0) throw new Error(`Lifetime fixture failed; retained ${dir}: ${output[1].trim()}`)
      try {
        expect(output[1]).toBe("")
        expect(output[0].length).toBeLessThan(8192)
        const row = parse(JSON.parse(output[0]))
        console.info(JSON.stringify(row))
        expect(row.case).toBe(mode)
        expect(row.attempts).toBeGreaterThan(0)
        expect(row.released).toBeGreaterThan(0)
        expect(row.leaderExit).toBeGreaterThan(0)
        expect(row.leafExit).toBeGreaterThan(0)
        expect(row.liveMutation).toBeLessThanOrEqual(1)
        if (mode === "keeper") {
          // Either overlap result is evidence for these two known processes only.
          expect(row.emptyObserved).toBe(false)
          return
        }
        expect(row.emptyObserved).toBe(true)
        expect(row.liveMutation).toBe(0)
      } finally {
        await remove(dir)
      }
    },
    25000,
  )

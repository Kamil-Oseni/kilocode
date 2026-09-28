import { expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Explicitly enabled private fixture. This does not certify production lease/process continuity.
const suite = process.platform === "win32" && process.env.RAYA_CHAIN_EXPERIMENT ? test : test.skip

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
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("raya-chain-experiment-"))
    throw new Error("Private acquisition cleanup escaped its disposable root")
  await rm(target, { recursive: true, force: true })
}

suite(
  "full relative chain rejects incomplete edges and preserves ordinary children with complete pins",
  async () => {
    const binary = process.env.RAYA_CHAIN_EXPERIMENT
    if (!binary || !path.isAbsolute(binary))
      throw new Error("Private chain experiment requires an absolute fixture path")
    const dir = await mkdtemp(path.join(tmpdir(), "raya-chain-experiment-"))
    try {
      const snapshot = await stat(dir, { bigint: true })
      const child = Bun.spawn([binary, dir, snapshot.dev.toString(), snapshot.ino.toString()], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), 12000)
      const output = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      if (output[2] !== 0) throw new Error(`Private chain fixture failed: ${output[1].trim()}\n${output[0]}`)
      expect(output[2]).toBe(0)
      expect(output[1]).toBe("")
      expect(output[0].length).toBeLessThan(32768)
      const rows = output[0]
        .trim()
        .split(/\r?\n/)
        .map((line) => parse(JSON.parse(line)))
      expect(rows).toHaveLength(137)
      expect(new Set(rows.map((row) => row.case)).size).toBe(137)
      console.info(
        JSON.stringify(rows.filter((row) => row.case.endsWith("-create-result") || row.case.startsWith("bun-native-"))),
      )
      const failures = rows.filter(
        (row) => !row.success && !row.case.endsWith("-leaf-create-result") && !row.case.startsWith("bun-native-"),
      )
      if (failures.length) console.info(JSON.stringify(failures))
      for (const row of rows) {
        if (row.case.startsWith("bun-native-")) {
          expect(row.error).toBe(0)
          continue
        }
        if (row.case.endsWith("-leaf-create-result")) {
          expect(row.success ? row.error === 0 : row.error !== 0).toBe(true)
          continue
        }
        expect(row).toEqual({ case: row.case, success: true, error: 0 })
      }
      const names = rows.map((row) => row.case)
      expect(names).toContain("bun-native-device-equal")
      expect(names).toContain("bun-native-inode-equal")
      for (const depth of [0, 1, 2]) {
        for (const suffix of [
          "substitution",
          "identity-refusal",
          "wrong-physical-id",
          "replacement-empty",
          "outside-before-cleanup",
          "finished",
        ])
          expect(names).toContain(`chain-1-${depth}-${suffix}`)
      }
      for (const depth of [0, 1]) {
        for (const suffix of [
          "incomplete-parent-mutation",
          "reparse-observed",
          "identity-refusal",
          "outside-before-cleanup",
          "finished",
        ])
          expect(names).toContain(`chain-2-${depth}-${suffix}`)
        for (const suffix of [
          "complete-ordinary-refused",
          "complete-extended-refused",
          "full-identity",
          "witness-created",
          "finished",
        ])
          expect(names).toContain(`chain-3-${depth}-${suffix}`)
      }
      for (const name of [
        "chain-0-0-full-identity",
        "chain-0-0-witness-created",
        "chain-0-0-extended-positive",
        "chain-0-0-extended-observed",
        "chain-0-0-branch-witness",
        "chain-4-0-leaf-mutation",
        "chain-4-0-leaf-admission-refused",
        "chain-4-0-witness-local",
        "chain-4-0-outside-before-witness-cleanup",
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

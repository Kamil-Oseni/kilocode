import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Headless native experiment, not coverage of process launch, acquisition races, or recovery.
// The fixture is compiled separately; it is not shipped with the production helper.
const suite = process.platform === "win32" && process.env.RAYA_DIRECTORY_EXPERIMENT ? test : test.skip

async function remove(dir: string) {
  const target = path.resolve(dir)
  if (
    path.dirname(target) !== path.resolve(tmpdir()) ||
    !path.basename(target).startsWith("raya-directory-experiment-")
  )
    throw new Error("Native directory experiment cleanup escaped its disposable root")
  await rm(target, { recursive: true, force: true })
}

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
    throw new Error("Native directory experiment returned an invalid row")
  return { case: input.case, success: input.success, error: input.error }
}

suite(
  "delete-excluding directory pins preserve ordinary child operations and nonempty reparse refusals",
  async () => {
    const binary = process.env.RAYA_DIRECTORY_EXPERIMENT
    if (!binary) throw new Error("Native directory experiment requires its separately compiled fixture")
    const dir = await mkdtemp(path.join(tmpdir(), "raya-directory-experiment-"))
    try {
      const child = Bun.spawn([binary, dir], { stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => child.kill(), 10000)
      const output = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      expect(output[2]).toBe(0)
      expect(output[1]).toBe("")
      const rows = output[0]
        .trim()
        .split(/\r?\n/)
        .map((line) => parse(JSON.parse(line)))
      expect(rows).toHaveLength(37)
      expect(new Set(rows.map((row) => row.case)).size).toBe(37)
      const find = (name: string) => {
        const row = rows.find((row) => row.case === name)
        if (!row) throw new Error(`Native directory experiment omitted ${name}`)
        return row
      }
      for (const name of [
        "preopened-delete-pin",
        "base-rename",
        "ancestor-rename",
        "root-rename",
        "cwd-rename",
        "witness-rename",
        "witness-delete",
        "cwd-posix-unlink",
        "cwd-posix-rename",
        "empty-directory-posix-replace",
        "witness-posix-unlink",
        "witness-posix-rename",
        "witness-posix-replace",
      ]) {
        expect(find(name)).toEqual({ case: name, success: false, error: 32 })
      }
      for (const name of [
        "preopened-attributes-pin",
        "child-rename",
        "child-delete",
        "sibling-rename",
        "sibling-delete",
        "ancestor-child-rename",
        "ancestor-child-delete",
        "nested-create",
        "nested-delete",
        "empty-metadata-reparse",
        "empty-metadata-reparse-ex",
        "ordinary-posix-replace",
        "ordinary-posix-source-absent",
        "ordinary-posix-unlink",
        "ordinary-posix-target-absent",
        "ordinary-posix-retained-stream",
        "cwd-posix-identity",
        "empty-directory-posix-identity",
        "witness-posix-identity",
        "experiment-finished",
      ]) {
        expect(find(name)).toEqual({ case: name, success: true, error: 0 })
      }
      for (const name of [
        "witness-metadata-reparse",
        "nonempty-ancestor-reparse",
        "witness-metadata-reparse-ex",
        "nonempty-ancestor-reparse-ex",
      ]) {
        expect(find(name)).toEqual({ case: name, success: false, error: 145 })
      }
    } finally {
      await remove(dir)
    }
  },
  15000,
)

import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const suite = process.platform === "win32" && process.env.RAYA_LAUNCH_NAMESPACE_EXPERIMENT ? test : test.skip

function parse(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("case" in value) ||
    typeof value.case !== "string" ||
    !("success" in value) ||
    typeof value.success !== "boolean" ||
    !("error" in value) ||
    typeof value.error !== "number" ||
    !Number.isInteger(value.error)
  )
    throw new Error("Invalid private namespace experiment row")
  if (value.case.endsWith("-inspection")) {
    if (
      !("null" in value) ||
      typeof value.null !== "boolean" ||
      !("tag" in value) ||
      typeof value.tag !== "number" ||
      !Number.isInteger(value.tag) ||
      value.tag < 0 ||
      value.tag > 3 ||
      !("aligned" in value) ||
      typeof value.aligned !== "boolean" ||
      !("length" in value) ||
      typeof value.length !== "number" ||
      !Number.isInteger(value.length) ||
      value.length < 2 ||
      value.length > 8192 ||
      value.length % 2 !== 0 ||
      !("maximum" in value) ||
      typeof value.maximum !== "number" ||
      !Number.isInteger(value.maximum) ||
      value.maximum < value.length
    )
      throw new Error("Invalid private structural observation")
    return {
      case: value.case,
      success: value.success,
      error: value.error,
      null: value.null,
      tag: value.tag,
      aligned: value.aligned,
      length: value.length,
      maximum: value.maximum,
    }
  }
  return { case: value.case, success: value.success, error: value.error }
}

async function remove(dir: string) {
  const target = path.resolve(dir)
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("raya-launch-namespace-"))
    throw new Error("Private namespace cleanup escaped its disposable root")
  await rm(target, { recursive: true, force: true })
}

async function rescue(binary: string, dir: string, uuid: string) {
  // Runs even after controller termination; removes only the two exact fixture-owned definitions.
  const child = Bun.spawn([binary, "--cleanup", dir, uuid], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const timer = setTimeout(() => child.kill(), 3000)
  const output = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer))
  if (output[2] !== 0 || output[1] !== "") throw new Error(`Private exact alias rescue failed: ${output[1]}`)
  expect(parse(JSON.parse(output[0].trim()))).toEqual({ case: "rescue-alias-absent", success: true, error: 0 })
}

suite(
  "measure private DOS alias launch binding and stable volume path compatibility",
  async () => {
    const binary = process.env.RAYA_LAUNCH_NAMESPACE_EXPERIMENT
    if (!binary) throw new Error("Private native fixture path required")
    if (!path.isAbsolute(binary)) throw new Error("Private native fixture requires an absolute executable path")
    const dir = await mkdtemp(path.join(tmpdir(), "raya-launch-namespace-"))
    const uuid = randomUUID()
    try {
      const child = Bun.spawn([binary, dir, uuid], { stdout: "pipe", stderr: "pipe", windowsHide: true })
      const timer = setTimeout(() => child.kill(), 16000)
      const output = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      if (output[2] !== 0) throw new Error(`Private namespace fixture failed: ${output[1].trim()}\n${output[0]}`)
      expect(output[1]).toBe("")
      const rows = output[0]
        .trim()
        .split(/\r?\n/)
        .map((line) => parse(JSON.parse(line)))
      console.info(JSON.stringify(rows))
      expect(new Set(rows.map((row) => row.case)).size).toBe(rows.length)
      expect(
        [0, 1, 2].some(
          (index) =>
            rows.find((row) => row.case === `alias-${index}-open-a`)?.success &&
            rows.find((row) => row.case === `alias-${index}-open-b`)?.success,
        ),
      ).toBe(true)
      for (const name of [
        "plain-create",
        "plain-job-empty",
        "pinned-a-unchanged",
        "alias-exact-removed",
        "controller-handle-loss-gone",
        "controller-handle-loss-no-nonce",
        "experiment-finished",
      ])
        expect(rows.find((row) => row.case === name)).toEqual({ case: name, success: true, error: 0 })
      for (const row of rows) {
        if (row.case.endsWith("-inspection")) {
          expect(row.success).toBe(false)
          expect(row.error).not.toBe(0)
          continue
        }
        if (row.case.endsWith("-create")) {
          expect(row.success ? row.error === 0 : row.error !== 0).toBe(true)
          continue
        }
        if (row.case.startsWith("alias-") && (row.case.includes("-open-") || row.case.endsWith("-suspended-match")))
          continue
        expect(row.success).toBe(true)
      }
      for (let index = 0; index < 3; index++) {
        const name = `removed-${index}-create`
        expect(rows.find((row) => row.case === name)?.success).toBe(false)
      }
    } finally {
      await rescue(binary, dir, uuid)
      await remove(dir)
    }
  },
  20000,
)

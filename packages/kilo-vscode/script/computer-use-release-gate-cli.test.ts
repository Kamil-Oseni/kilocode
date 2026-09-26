import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { describe, expect, test } from "bun:test"

const script = join(import.meta.dir, "computer-use-release-gate.ts")

async function run(report: unknown, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "raya-release-gate-"))
  if (!resolve(dir).startsWith(resolve(tmpdir()) + sep))
    throw new Error("Temporary gate directory escaped the OS temp root")
  try {
    const path = join(dir, "report.json")
    await writeFile(path, JSON.stringify(report))
    for (const [name, data] of Object.entries(files)) await writeFile(join(dir, name), data)
    const child = Bun.spawn([process.execPath, script, path], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function report(path: string, sha256: string) {
  return {
    format: "raya.autonomous-desktop-benchmark",
    version: 2,
    taskSetVersion: 1,
    mode: "installed-windows",
    hostEvidence: { path, sha256 },
    tasks: [],
  }
}

describe("installed Windows desktop release gate CLI", () => {
  test("hashes artifact bytes instead of trusting a report's digest", async () => {
    const data = JSON.stringify({ format: "raya.installed-desktop-host-probe", version: 3 })
    const result = await run(report("host.json", "a".repeat(64)), { "host.json": data })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("hostEvidence artifact SHA-256 does not match")
    expect(createHash("sha256").update(data).digest("hex")).not.toBe("a".repeat(64))
  })

  test("rejects a report-relative traversal before reading an artifact", async () => {
    const result = await run(report("../outside.json", "a".repeat(64)))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Evidence artifact path escapes the report directory")
  })

  test("rejects an oversized artifact before parsing it", async () => {
    const data = "x".repeat(2_000_001)
    const result = await run(report("host.json", createHash("sha256").update(data).digest("hex")), {
      "host.json": data,
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Evidence artifact exceeds the two-megabyte limit")
  })
})

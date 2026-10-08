import { expect, test } from "bun:test"
import path from "node:path"
import { status } from "../../src/second-brain/index-status"

test("original authenticated cold index inspection is accepted by the host projection", async () => {
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe",
      "-B",
      path.join(process.cwd(), "script/memory/index_http_test.py"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, output + error).toBe(0)
  expect(error).toContain("Ran 6 tests")
  const proof = JSON.parse(output)
  expect(status(proof.index)).toEqual(proof.index)
  expect(status(proof.index).status).toBe("synced")
}, 30_000)

test("cached flags, unavailable outcomes and incomplete digests cannot restore index readiness", () => {
  expect(status({ status: "unchecked" })).toEqual({ status: "unchecked" })
  expect(status({ status: "policy_disabled", digest: "a".repeat(64) }).status).toBe("policy_disabled")
  for (const value of [
    null,
    true,
    { ready: true },
    { status: "synced" },
    { status: "synced", digest: "ABC" },
    { status: "uncertain", digest: "a".repeat(64) },
    { status: "synced", digest: "a".repeat(64), cached: true },
  ])
    expect(() => status(value)).toThrow()
})

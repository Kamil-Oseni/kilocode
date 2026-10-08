import { expect, test } from "bun:test"
import path from "node:path"
import { parse } from "../../src/second-brain/operation"

test("authenticated original capture response is accepted by the actual host parser", async () => {
  const child = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe",
      "-B",
      path.join(process.cwd(), "script/memory/capture_http_test.py"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, output + error).toBe(0)
  const proof = JSON.parse(output)
  const bytes = new TextEncoder().encode(proof.response)
  const value = parse(bytes, proof.selected, "response")
  expect(value.operation).toMatchObject({ kind: "capture", operation_outcome: "completed", downstream: [] })
  expect(value.result).toMatchObject({ status: "committed", duplicate: false })
  expect(() => parse(bytes, { ...proof.selected, digest: "0".repeat(64) }, "response")).toThrow()
  expect(() => parse(bytes, { ...proof.selected, kind: "search" }, "response")).toThrow()
}, 30_000)

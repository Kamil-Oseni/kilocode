import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { select, stage } from "../../src/services/update-artifact"

const bytes = new TextEncoder().encode("test update archive bytes")
const asset = {
  name: "raya-win32-x64.vsix",
  url: "https://api.github.com/repos/owner/raya/releases/assets/42",
  state: "uploaded" as const,
  size: bytes.length,
  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
}

test("selects only an exact supported platform with verifiable metadata", () => {
  expect(select([asset], "win32-x64")).toEqual(asset)
  expect(select([asset], "darwin-arm64")).toBeUndefined()
  expect(select([asset], "freebsd-x64")).toBeUndefined()
  expect(select([{ ...asset, name: "raya-win32-x64-unrelated.vsix" }], "win32-x64")).toBeUndefined()
  expect(() => select([asset, asset], "win32-x64")).toThrow("ambiguous")
  for (const fields of [{ digest: null }, { size: -1 }, { state: "new" }, { size: 2 ** 31 }])
    expect(() => select([{ ...asset, ...fields }], "win32-x64")).toThrow("valid SHA-256")
})

test("only verified streamed bytes reach installation and staging is removed afterward", async () => {
  let path = ""
  await stage(
    asset,
    "owner/raya",
    "test-token",
    async (file) => {
      path = file
      expect(new Uint8Array(await readFile(file))).toEqual(bytes)
    },
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 4))
            controller.enqueue(bytes.slice(4))
            controller.close()
          },
        }),
      ),
  )
  expect(path).not.toBe("")
  await expect(stat(dirname(path))).rejects.toThrow()
})

test.each(["truncated", "oversized", "checksum", "revoked"])(
  "blocks %s downloads before installation",
  async (mode) => {
    let installed = false
    await expect(
      stage(
        asset,
        "owner/raya",
        "test-token",
        async () => {
          installed = true
        },
        async () => {
          if (mode === "revoked") return new Response(null, { status: 401 })
          if (mode === "truncated") return new Response(bytes.slice(1))
          if (mode === "oversized") return new Response(new Uint8Array(bytes.length + 1))
          return new Response(new Uint8Array(bytes.length))
        },
      ),
    ).rejects.toThrow()
    expect(installed).toBe(false)
  },
)

test("rejects foreign asset URLs and strips credentials on an approved signed redirect", async () => {
  let calls = 0
  await expect(
    stage(
      { ...asset, url: "https://example.com/asset" },
      "owner/raya",
      "test-token",
      async () => undefined,
      async () => {
        calls++
        return new Response(bytes)
      },
    ),
  ).rejects.toThrow("configured GitHub repository")
  expect(calls).toBe(0)
  await stage(
    asset,
    "owner/raya",
    "test-token",
    async () => undefined,
    async (_url, init) => {
      calls++
      if (calls === 1) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token")
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/signed" },
        })
      }
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
      return new Response(bytes)
    },
  )
  expect(calls).toBe(2)
})

test("cleans staging after installer failure without exposing underlying error details", async () => {
  let path = ""
  await expect(
    stage(
      asset,
      "owner/raya",
      "test-token",
      async (file) => {
        path = file
        throw new Error("sensitive installer details")
      },
      async () => new Response(bytes),
    ),
  ).rejects.toThrow("could not be downloaded, verified, or installed")
  await expect(stat(dirname(path))).rejects.toThrow()
})

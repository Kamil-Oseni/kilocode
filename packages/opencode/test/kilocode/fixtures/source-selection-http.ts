import assert from "node:assert/strict"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { SourceSelection } from "@opencode-ai/core/kilocode/source-selection-schema"
import { ConfigIntent } from "@opencode-ai/core/kilocode/config-intent"
import { Server } from "../../../src/server/server"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Storage } from "../../../src/storage/storage"
import { selected } from "../../../src/kilocode/migration/storage-scope"
import { selection } from "../../../src/kilocode/migration/source-selection"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
assert(root && path.isAbsolute(root))
const file = process.env.RAYA_DB
assert(file && path.isAbsolute(file))
const content = { identity: "owned-selected-json", revision: 7 }
const password = process.env.RAYA_SERVER_PASSWORD
const username = process.env.RAYA_SERVER_USERNAME
assert(password && username)
const headers = { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
const app = Server.Default().app
let proof: typeof SourceSelection.Type | undefined
let stage = "unauthenticated"
let status: number | undefined
let body: { text: string; errors: string[] } | undefined
let direct: { freshRead: true; sameStateAuthority: false; status: string; name?: string; message?: string } | undefined
async function bounded(reply: Response) {
  const result = { text: "", errors: [] as string[] }
  const reader = reply.body?.getReader()
  if (!reader) return result
  const bytes = new Uint8Array(2048)
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.byteLength > bytes.length - size) {
        result.errors.push("ResponseDiagnosticCapacity")
        await reader.cancel()
        return result
      }
      bytes.set(next.value, size)
      size += next.value.byteLength
    }
    result.text = new TextDecoder()
      .decode(bytes.subarray(0, size))
      .replaceAll(password!, "[redacted]")
      .replaceAll(Buffer.from(`${username}:${password}`).toString("base64"), "[redacted]")
  } catch (err) {
    result.errors.push(err instanceof Error ? err.name : "unknown")
  } finally {
    try {
      reader.releaseLock()
    } catch (err) {
      result.errors.push(err instanceof Error ? err.name : "unknown")
    }
  }
  return result
}
const request = async (url: string, opts?: Parameters<typeof app.request>[1]) => {
  const reply = await app.request(url, opts)
  status = reply.status
  body = reply.status >= 400 ? await bounded(reply) : undefined
  return reply
}
try {
  assert.equal((await request("/global/source-export-selection")).status, 401)
  stage = "wrong-auth"
  assert.equal(
    (
      await request("/global/source-export-selection", {
        headers: { authorization: `Basic ${Buffer.from(`${username}:wrong fixture password`).toString("base64")}` },
      })
    ).status,
    401,
  )
  stage = "selected-storage"
  const dir = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.replace(["selection", "owned"], content)
      assert.deepEqual(yield* storage.read(["selection", "owned"]), content)
      return selected(storage)
    }),
  )
  const before = await readFile(path.join(dir, "selection", "owned.json"))
  stage = "cold-selection"
  const cold = await request("/global/source-export-selection", { headers })
  assert.equal(cold.status, 200)
  const initial = Schema.decodeUnknownSync(SourceSelection)(await cold.json(), { onExcessProperty: "error" })
  assert.equal(initial.completeProfileCoverage, false)
  assert.equal(initial.portableCaptureAuthorized, false)
  assert.equal(initial.preferences, "authenticated-capture-only")
  stage = "authenticated-config"
  const response = await request("/global/config", { headers })
  assert.equal(response.status, 200)
  assert.throws(() => ConfigIntent.snapshot(), /Configuration origin closure is incomplete/)
  stage = "authenticated-selection"
  const metadata = await request("/global/source-export-selection", { headers })
  if (metadata.status === 400) {
    direct = await AppRuntime.runPromise(selection()).then(
      () => ({ freshRead: true as const, sameStateAuthority: false as const, status: "passed" }),
      (err: unknown) => ({
        freshRead: true as const,
        sameStateAuthority: false as const,
        status: "failed",
        name: err instanceof Error ? err.name : "unknown",
        message:
          err instanceof Error
            ? err.message
                .slice(0, 1024)
                .replaceAll(password, "[redacted]")
                .replaceAll(Buffer.from(`${username}:${password}`).toString("base64"), "[redacted]")
            : "unknown",
      }),
    )
  }
  assert.equal(metadata.status, 200)
  proof = Schema.decodeUnknownSync(SourceSelection)(await metadata.json(), { onExcessProperty: "error" })
  assert.deepEqual(proof, initial)
  assert.equal(path.normalize(proof.profile.database).toLowerCase(), path.normalize(file).toLowerCase())
  assert.equal(path.normalize(proof.profile.storage).toLowerCase(), path.normalize(dir).toLowerCase())
  assert.equal(proof.preferences, "authenticated-capture-only")
  assert.equal(proof.completeProfileCoverage, false)
  assert.equal(proof.portableCaptureAuthorized, false)
  assert.equal(proof.restartRequired, true)
  assert.deepEqual(await readFile(path.join(dir, "selection", "owned.json")), before)
  stage = "selection-readback"
  const second = await request("/global/source-export-selection", { headers })
  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), proof)
} catch (err) {
  process.exitCode = 1
  const message = err instanceof Error ? err.message.slice(0, 1024).replaceAll(password, "[redacted]") : "unknown"
  await writeFile(
    path.join(root, "source-selection-failure.json"),
    JSON.stringify({ stage, status, body, direct, name: err instanceof Error ? err.name : "unknown", message }),
  ).catch((failure) => {
    process.stderr.write(
      `SOURCE_SELECTION_FAILURE_PUBLICATION ${failure instanceof Error ? failure.name : "unknown"}\n`,
    )
  })
  process.stderr.write(`SOURCE_SELECTION_FIXTURE ${err instanceof Error ? err.name : "unknown"}\n`)
} finally {
  await finish([() => HttpApiApp.webHandler().dispose(), () => AppRuntime.dispose()], async () => {
    assert(proof)
    await writeFile(path.join(root, "source-selection-proof.json"), JSON.stringify(proof))
  })
}

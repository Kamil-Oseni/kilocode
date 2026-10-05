import assert from "node:assert/strict"
import { mkdirSync, readdirSync, unlinkSync, watch } from "node:fs"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { CredentialPublication } from "@opencode-ai/core/kilocode/credential-publication"
import { Auth } from "../../../src/auth"

const [mode, dir] = process.argv.slice(2) as [string, string]
Global.Path.data = dir
const file = path.join(dir, "auth.json")
await writeFile(file, mode === "read" ? "{" : "{}")
let changed = false
const watcher =
  mode === "rename"
    ? watch(dir, () => {
        if (changed || !readdirSync(dir).some((name) => name.startsWith("auth.json.") && name.endsWith(".tmp"))) return
        unlinkSync(file)
        mkdirSync(file)
        changed = true
      })
    : undefined
try {
  const caught = await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      return yield* (
        mode === "read" ? auth.remove("synthetic") : auth.set("synthetic", { type: "api", key: "test-only" })
      ).pipe(Effect.catch((err) => Effect.succeed(err)))
    }).pipe(Effect.provide(Auth.defaultLayer)),
  )
  assert.ok(caught instanceof Auth.AuthError, "A typed-error-only consumer must catch publication failure")
  assert.ok(caught.cause)
  const one = CredentialPublication.retire()
  assert.equal(CredentialPublication.retire(), one)
  const failure = await one.then(
    () => undefined,
    (err: unknown) => err,
  )
  assert.ok(failure instanceof AggregateError)
  assert.equal(failure.errors.length, 1)
  const raw = Cause.squash(failure.errors[0])
  if (mode === "read") assert.equal(raw, caught)
  if (mode === "rename") {
    assert.equal(changed, true)
    assert.equal(raw, caught.cause, "Retirement must retain the exact native aggregate beneath AuthError")
    assert.ok(raw instanceof AggregateError)
    assert.ok(raw.errors.some((err: unknown) => err && typeof err === "object" && "code" in err))
  }
  console.log(JSON.stringify({ typed: true, rawRetained: true, sticky: true, mode, changed }))
} finally {
  watcher?.close()
}

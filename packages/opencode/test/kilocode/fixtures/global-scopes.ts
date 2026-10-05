import assert from "node:assert/strict"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { closeProcessProfile, sourceScopes } from "@opencode-ai/core/kilocode/process-profile"
import { Global } from "@opencode-ai/core/global"
import { ProfileParticipants, participantScopes } from "@/kilocode/cli/profile-participants"
import { workerScopes } from "@/kilocode/cli/worker-scopes"
import { namespaceScopes, stateScopes } from "@/kilocode/migration/profile-scope"
import { validatePolicy } from "@opencode-ai/core/kilocode/source-policy"
import * as tui from "@/kilocode/cli/cmd/tui/worker-identity"
import * as exporting from "@/kilocode/session-export/worker-identity"
import * as indexing from "@/kilocode/indexing-retirement"
import { observation } from "@/kilocode/cli/profile-retirement"

const root = process.argv[2]
assert.ok(root)
Global.make({ data: path.join(root, "injected", "data") })
const policy = await validatePolicy({ version: 1, directories: [root], files: [] })
let confirmed = 0
const incomplete: { value?: ReturnType<typeof ProfileParticipants.snapshot>[number] } = {}
for (const plan of ["worker", "session-export-worker", "indexing-worker", "uncertain"] as const) {
  const role = plan === "uncertain" ? "worker" : plan
  const selected =
    role === "worker"
      ? {
          role,
          request: tui.request(
            tui.identity({ KILO_RUN_ID: crypto.randomUUID(), KILO_WORKER_GENERATION: crypto.randomUUID() }),
          ),
        }
      : role === "session-export-worker"
        ? { role, request: exporting.request(exporting.spawn(crypto.randomUUID())) }
        : {
            role,
            request: { runID: crypto.randomUUID(), generation: crypto.randomUUID(), requestID: crypto.randomUUID() },
          }
  const request = selected.request
  const folder = path.join(root, plan)
  await mkdir(folder)
  const worker = new Worker(new URL("./worker-global-scopes.ts", import.meta.url).href)
  const ack = Promise.withResolvers<
    ReturnType<typeof tui.validate> | ReturnType<typeof exporting.validate> | indexing.Receipt
  >()
  const ready = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  worker.addEventListener(
    "message",
    (
      event: MessageEvent<
        ReturnType<typeof tui.validate> | ReturnType<typeof exporting.validate> | indexing.Receipt | { ready: true }
      >,
    ) => {
      if (event.data && typeof event.data === "object" && "ready" in event.data) return ready.resolve()
      ack.resolve(event.data)
    },
  )
  worker.addEventListener("error", (event) => {
    const err = new Error(event.message || "Actual Worker failed", { cause: event.error })
    ready.reject(err)
    ack.reject(err)
    closed.reject(err)
  })
  worker.addEventListener("close", (event: Event) => {
    if (!("code" in event) || event.code !== 0 || !("wasClean" in event) || event.wasClean !== true)
      return closed.reject(new Error("Worker did not close cleanly"))
    closed.resolve()
  })
  await ready.promise
  worker.postMessage({ role, root: folder, request, uncertain: plan === "uncertain" })
  const input = await ack.promise
  const value = (() => {
    if (selected.role === "worker") return tui.validate(input, selected.request)
    if (selected.role === "session-export-worker") return exporting.validate(input, selected.request)
    assert.equal(input.role, "indexing-worker")
    if (input.role !== "indexing-worker") throw new Error("Indexing reply came from another Worker role")
    return indexing.validate(input, selected.request)
  })()
  await closed.promise
  assert.equal(value.scopes?.version, 4)
  const scopes = workerScopes(value.scopes, value.receipt.roots)
  assert.ok(scopes && scopes.version === 4)
  if (plan === "uncertain") {
    assert.equal(scopes.configStatus, "uncertain")
    assert.equal(scopes.configReason, "unsupported-fields")
    assert.equal(scopes.configs.length, 0)
    incomplete.value = { ...request, role, receipt: value.receipt, scopes }
    continue
  }
  assert.equal(scopes.configStatus, "complete")
  assert.equal(scopes.configs.length, 1)
  assert.equal(scopes.configs[0].documents[0].safe.model, `provider/${role}`)
  assert.equal(
    scopes.configs[0].documents[0].excluded.find((item) => item.field === "provider")?.reason,
    "credential-or-execution",
  )
  assert.ok(!JSON.stringify(scopes).includes("SYNTHETIC_CONFIG_SENTINEL"))
  assert.ok(Object.isFrozen(scopes.configs[0].documents[0].safe))
  const foreign = {
    ...scopes,
    configs: scopes.configs.map((graph) => ({
      ...graph,
      documents: graph.documents.map((document) => ({ ...document, path: path.join(root, "foreign.json") })),
    })),
  }
  assert.throws(() => workerScopes(foreign, value.receipt.roots), /historical ownership/)
  const graph = {
    ...scopes,
    configs: scopes.configs.map((graph) => ({
      ...graph,
      roots: { ...graph.roots, data: path.join(root, "foreign-data") },
    })),
  }
  assert.throws(() => workerScopes(graph, value.receipt.roots), /realized Global tuple/)
  assert.ok(scopes.globals.some((roles) => roles.data.toLowerCase() === path.join(folder, "data").toLowerCase()))
  await stateScopes(scopes, value.receipt.roots, policy, true)
  const namespaces = await namespaceScopes(scopes, value.receipt.roots, policy)
  assert.deepEqual(namespaces.globals, scopes.globals)
  assert.deepEqual(
    new Set(namespaces.roots.map((item) => item.path)),
    new Set(scopes.globals.flatMap((roles) => Object.values(roles))),
  )
  assert.ok(Object.isFrozen(namespaces) && Object.isFrozen(namespaces.globals[0]))
  const altered = { ...scopes, globals: scopes.globals.map((roles) => ({ ...roles })) }
  altered.globals[0].data = path.join(root, "unowned")
  const key = (roles: (typeof altered.globals)[number]) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(roles).map(([role, file]) => [role, process.platform === "win32" ? file.toLowerCase() : file]),
      ),
    )
  altered.globals.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  assert.throws(() => workerScopes(altered, value.receipt.roots), /historical ownership/)
  await assert.rejects(
    stateScopes(scopes, value.receipt.roots, { version: 1, directories: [folder], files: [] }, true),
    /policy/,
  )
  ProfileParticipants.remember({ ...request, role, receipt: value.receipt, scopes })
  confirmed++
}
const combined = participantScopes(true)
assert.equal(combined.version, 4)
assert.ok(combined.version === 4 && combined.globals.length >= 4)
const own = sourceScopes()
assert.equal(own.version, 4)
assert(incomplete.value)
ProfileParticipants.remember(incomplete.value)
assert.throws(() => participantScopes(true), /configuration origin/)
const partial = participantScopes(false)
assert(partial.version === 4)
assert.equal(partial.configStatus, "uncertain")
assert.equal(partial.configs.length, 0)
const legacy = { version: 1, states: own.states }
assert.ok(workerScopes(legacy, observation().roots))
await assert.rejects(stateScopes(legacy, observation().roots, policy, true), /full Global/)
await assert.rejects(namespaceScopes(legacy, observation().roots, policy), /full Global/)
const item = ProfileParticipants.snapshot()[0]
assert.ok(own.version === 4)
assert.ok(item.scopes && item.scopes.version === 4)
const previous = { version: 2 as const, states: item.scopes.states, globals: item.scopes.globals }
ProfileParticipants.remember({
  ...item,
  generation: crypto.randomUUID(),
  requestID: crypto.randomUUID(),
  scopes: workerScopes(previous, item.receipt.roots),
})
assert.throws(() => participantScopes(true), /configuration origin/)
assert.equal(participantScopes(false).version, 2)
ProfileParticipants.remember({
  ...item,
  generation: crypto.randomUUID(),
  requestID: crypto.randomUUID(),
  scopes: workerScopes(legacy, item.receipt.roots),
})
assert.throws(() => participantScopes(true), /configuration origin/)
assert.equal(participantScopes(false).version, 1)
await closeProcessProfile()
console.log(JSON.stringify({ passed: true, confirmed, completeProfileCoverage: false, portable: false }))

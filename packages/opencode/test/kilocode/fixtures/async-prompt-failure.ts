import assert from "node:assert/strict"
import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = process.env.RAYA_ASYNC_PROFILE
if (!root) throw new Error("Missing private failure profile")
const { Global } = await import("@opencode-ai/core/global")
const { Server } = await import("../../../src/server/server")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { GlobalBus } = await import("../../../src/bus/global")
const { scheduler, schedulerQuiesce } = await import("../../../src/kilocode/task/admission")
const { KiloSessions } = await import("../../../src/kilo-sessions/kilo-sessions")
const { SessionExport } = await import("../../../src/kilocode/session-export")
const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
const { RuntimeRegistry } = await import("@opencode-ai/core/kilocode/runtime-registry")
const folder = join(Global.Path.state, "locks")
assert.ok(resolve(folder).startsWith(resolve(root) + "/") || resolve(folder).startsWith(resolve(root) + "\\"))
const errors: {
  sessionID?: string
  messageID?: string
  error?: { name?: string; data?: { message?: string; ref?: string } }
}[] = []
const diagnostic = (event: { payload?: { type?: string; properties?: (typeof errors)[number] } }) => {
  if (event.payload?.type === "session.error" && event.payload.properties) errors.push(event.payload.properties)
}
GlobalBus.on("event", diagnostic)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const headers = { "x-kilo-directory": root, "content-type": "application/json" }
const request = (route: string, body?: object) =>
  fetch(new URL(route, listener.url), {
    method: body ? "POST" : "GET",
    headers,
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
let blocked = false
try {
  const created = await request("/session", { title: "Private pre-intake failure" })
  assert.equal(created.status, 200)
  const session = await created.json()
  await mkdir(folder, { recursive: true })
  await rename(folder, folder + "-prior")
  await writeFile(folder, "Private deterministic ENOTDIR fault; never a user profile", { flag: "wx" })
  blocked = true
  const messageID = "msg_000000000001failureoriginal"
  const response = await request(`/session/${session.id}/prompt_async`, {
    messageID,
    agent: "build",
    parts: [{ type: "text", text: "Never reach inference" }],
  })
  assert.equal(response.status, 204)
  const deadline = Date.now() + 10_000
  while (!errors.length || scheduler.snapshot().active) {
    assert.ok(Date.now() < deadline, "Original async failure did not settle")
    await Bun.sleep(10)
  }
  assert.equal(errors.length, 1)
  assert.equal(errors[0].sessionID, session.id)
  assert.equal(errors[0].messageID, messageID)
  assert.equal(errors[0].error?.name, "UnknownError")
  assert.match(errors[0].error?.data?.ref ?? "", /^err_[0-9a-f-]{8}$/)
  assert.equal(errors[0].error?.data?.message, "Unexpected session failure. Check server logs for details.")
  const rows = await request(`/session/${session.id}/message`)
  assert.equal(rows.status, 200)
  assert.deepEqual(await rows.json(), [])
  await Bun.write(
    join(root, "failure.json"),
    JSON.stringify({
      passed: true,
      sessionID: session.id,
      messageID,
      errors,
      active: scheduler.snapshot().active,
      inputAccepted: false,
      inferenceAllowed: false,
    }),
  )
} finally {
  if (blocked) {
    await unlink(folder)
    await rename(folder + "-prior", folder)
  }
  await listener.stop(true)
  // The one injected failure remains an admission failure; disposal must still join it.
  await Promise.allSettled([schedulerQuiesce()])
  if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
  await KiloSessions.drainIngestForShutdown()
  await SessionExport.shutdown()
  await InstanceRuntime.disposeAllInstances()
  await RuntimeRegistry.drain()
  GlobalBus.off("event", diagnostic)
}

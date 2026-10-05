import { expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"
import { parentStop } from "../../src/kilocode/cli/cmd/tui/parent-stop"
import * as WorkerIdentity from "../../src/kilocode/cli/cmd/tui/worker-identity"
import type { rpc } from "./fixtures/parent-stop-worker"
import type { rpc as held } from "./fixtures/tui-worker-identity"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"
import { withTimeout } from "../../src/util/timeout"
import fs from "node:fs/promises"
import { ProfileParticipants } from "../../src/kilocode/cli/profile-participants"

for (const mode of [
  "generation",
  "request",
  "run",
  "version",
  "malformed",
  "missing",
  "scope",
  "roots",
  "portable",
  "global",
])
  test(`actual worker refuses unbound shutdown receipt: ${mode}`, async () => {
    await using dir = await tmpdir()
    const env = { ...process.env, KILO_RUN_ID: crypto.randomUUID(), [WorkerIdentity.GENERATION]: crypto.randomUUID() }
    const request = WorkerIdentity.request(WorkerIdentity.identity(env))
    const records = () => ProfileParticipants.snapshot().filter((record) => record.generation === request.generation)
    expect(records()).toHaveLength(0)
    const worker = new Worker(new URL("./fixtures/parent-stop-worker.ts", import.meta.url).href, { env })
    const client = Rpc.client<typeof rpc>(worker)
    const ready = Promise.withResolvers<void>()
    client.on("ready", () => ready.resolve())
    const stop = parentStop({
      worker,
      request,
      shutdown: () => client.call("shutdown", request),
      detach: () => undefined,
      timeout: 2_000,
    })
    try {
      await ready.promise
      await client.call("init", { file: path.join(dir.path, "actual.db"), mode })
      const first = stop()
      const failure = await first.catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain("timed out")
      expect(stop()).toBe(first)
      expect(await stop().catch((err: unknown) => err)).toBe(failure)
      expect(records()).toHaveLength(0)
    } finally {
      worker.terminate()
    }
  }, 5_000)

test("captured worker identity refuses malformed UUIDs and later different retirement requests", () => {
  const owner = WorkerIdentity.identity({
    KILO_RUN_ID: "existing-run",
    [WorkerIdentity.GENERATION]: crypto.randomUUID(),
  })
  const accept = WorkerIdentity.bind(owner)
  const request = WorkerIdentity.request(owner)
  expect(accept(request)).toEqual(request)
  expect(accept(request)).toBe(accept(request))
  expect(() => accept(WorkerIdentity.request(owner))).toThrow("changed after retirement")
  expect(() => WorkerIdentity.accept({ ...request, requestID: "-".repeat(36) }, owner)).toThrow("identity")
  expect(() =>
    WorkerIdentity.identity({ KILO_RUN_ID: "existing-run", [WorkerIdentity.GENERATION]: "-".repeat(36) }),
  ).toThrow("invalid")
})

test("real worker joins the exact held retirement request and refuses another before cached reply", async () => {
  await using dir = await tmpdir()
  const env = { ...process.env, KILO_RUN_ID: crypto.randomUUID(), [WorkerIdentity.GENERATION]: crypto.randomUUID() }
  const owner = WorkerIdentity.identity(env)
  const request = WorkerIdentity.request(owner)
  const worker = new Worker(new URL("./fixtures/tui-worker-identity.ts", import.meta.url).href, { env })
  const client = Rpc.client<typeof held>(worker)
  const ready = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const requests: number[] = []
  client.on("ready", () => ready.resolve())
  client.on("held", () => started.resolve())
  client.on<number>("requested", (count) => requests.push(count))
  try {
    await withTimeout(ready.promise, 1_000, "fixture readiness")
    const release = path.join(dir.path, "release")
    await withTimeout(
      client.call("init", { file: path.join(dir.path, "held.db"), release }),
      1_000,
      "fixture initialization",
    )
    const first = client.call("shutdown", request)
    await withTimeout(started.promise, 1_000, "held finalizer")
    const failure = await withTimeout(
      client.call("shutdown", WorkerIdentity.request(owner)),
      1_000,
      "changed request refusal",
    ).catch((err: unknown) => err)
    expect(String(failure)).toContain("changed after retirement")
    const repeated = client.call("shutdown", request)
    await fs.writeFile(release, "release")
    const reply = WorkerIdentity.validate(await withTimeout(first, 1_000, "initial acknowledgment"), request)
    expect(WorkerIdentity.validate(await withTimeout(repeated, 1_000, "repeated acknowledgment"), request)).toEqual(
      reply,
    )
    expect(requests).toEqual([1])
    expect(Object.isFrozen(reply.receipt.roots)).toBe(true)
  } finally {
    worker.terminate()
  }
}, 5_000)

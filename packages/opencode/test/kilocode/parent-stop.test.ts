import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { parentStop } from "../../src/kilocode/cli/cmd/tui/parent-stop"
import { Rpc } from "../../src/util/rpc"
import type { rpc } from "./fixtures/parent-stop-worker"
import { tmpdir } from "../fixture/fixture"
import * as WorkerIdentity from "../../src/kilocode/cli/cmd/tui/worker-identity"
import { ProfileParticipants } from "../../src/kilocode/cli/profile-participants"

for (const mode of ["held", "failed", "noexit", "noack", "badexit", "timeout"])
  test(`parent worker stop requires joined acknowledgment and natural exit: ${mode}`, async () => {
    await using dir = await tmpdir()
    const file = join(dir.path, "worker.db")
    const env = { ...process.env, KILO_RUN_ID: crypto.randomUUID(), [WorkerIdentity.GENERATION]: crypto.randomUUID() }
    const request = WorkerIdentity.request(WorkerIdentity.identity(env))
    const records = () => ProfileParticipants.snapshot().filter((record) => record.generation === request.generation)
    expect(records()).toHaveLength(0)
    const worker = new Worker(new URL("./fixtures/parent-stop-worker.ts", import.meta.url).href, { env })
    const client = Rpc.client<typeof rpc>(worker)
    const ready = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const exited = Promise.withResolvers<Event>()
    const requested: number[] = []
    const broken = Promise.withResolvers<never>()
    worker.addEventListener("close", (event) => exited.resolve(event))
    worker.onerror = (event) => broken.reject(event.error ?? new Error(event.message))
    client.on("ready", () => ready.resolve())
    client.on("held", () => held.resolve())
    client.on<number>("requested", (count) => requested.push(count))
    let detached = 0
    const stop = parentStop({
      worker,
      request,
      shutdown: () => client.call("shutdown", request),
      detach: () => {
        detached += 1
      },
      timeout: mode === "held" || mode === "failed" ? 2_000 : 100,
    })
    const timer = setTimeout(() => broken.reject(new Error("Parent stop test did not settle")), 10_000)
    const exercise = async () => {
      await ready.promise
      await client.call("init", { file, mode })
      const first = stop()
      const result = first.catch((err: unknown) => err)
      expect(stop()).toBe(first)
      if (mode === "held" || mode === "timeout") {
        await held.promise
        let settled = false
        void result.then(() => {
          settled = true
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        expect(records()).toHaveLength(0)
        if (mode === "held") worker.postMessage("fixture.release")
      }
      const err = await result
      const close = await exited.promise
      expect(requested).toEqual([1])
      expect(detached).toBe(1)
      expect(stop()).toBe(first)
      expect(await stop().catch((err: unknown) => err)).toBe(err)
      expect(records()).toHaveLength(mode === "held" ? 1 : 0)
      if (mode === "held") {
        const reply = WorkerIdentity.validate(err, request)
        expect(reply.receipt.roots).toEqual([{ kind: "sqlite", path: file }])
        expect(reply.generation).toBe(request.generation)
        expect("code" in close && close.code).toBe(0)
        expect("wasClean" in close && close.wasClean).toBe(true)
        expect(records()[0].receipt).toEqual(reply.receipt)
        await stop()
        expect(records()).toHaveLength(1)
      } else {
        expect(err).toBeInstanceOf(Error)
        expect(String(err)).toContain(
          mode === "failed"
            ? "TUI worker shutdown failed"
            : mode === "badexit"
              ? "exited without clean confirmation"
              : "forced termination cannot confirm cleanup",
        )
      }
      using db = new Database(file, { readonly: true })
      expect(db.query("SELECT value FROM parent_stop ORDER BY rowid").all()).toEqual(
        mode === "timeout" ? [{ value: "before" }] : [{ value: "before" }, { value: "finalized" }],
      )
    }
    try {
      await Promise.race([exercise(), broken.promise])
    } finally {
      clearTimeout(timer)
      worker.terminate()
    }
  }, 15_000)

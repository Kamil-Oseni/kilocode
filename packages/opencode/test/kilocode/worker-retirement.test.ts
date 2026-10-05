import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { Rpc } from "../../src/util/rpc"
import type { rpc } from "./fixtures/worker-retirement"
import { tmpdir } from "../fixture/fixture"

for (const failed of [false, true])
  test(`real worker retires Core native owners after accepted writes${failed ? " despite a cleanup failure" : ""}`, async () => {
    await using dir = await tmpdir()
    const file = join(dir.path, "worker.db")
    const worker = new Worker(new URL("./fixtures/worker-retirement.ts", import.meta.url).href)
    const client = Rpc.client<typeof rpc>(worker)
    const ready = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const native = Promise.withResolvers<{ phase: string; instances: string[]; events: string[] }>()
    const refusal = Promise.withResolvers<string>()
    const broken = Promise.withResolvers<never>()
    worker.onerror = (event) => broken.reject(event.error ?? new Error(event.message))
    client.on("ready", () => ready.resolve())
    client.on("held", () => held.resolve())
    client.on<Awaited<typeof native.promise>>("native", (value) => native.resolve(value))
    client.on<string>("failure", (value) => refusal.resolve(value))
    const timer = setTimeout(() => broken.reject(new Error("Worker retirement did not settle")), 20_000)
    const exercise = async () => {
      await ready.promise
      await client.call("init", { file, failed })
      const accepted = client.call("hold", undefined)
      await held.promise
      const first = client.call("shutdown", undefined)
      const second = client.call("shutdown", undefined)
      const results = Promise.allSettled([first, second])
      let retired = false
      void native.promise.then(() => {
        retired = true
      })
      await Promise.resolve()
      expect(retired).toBe(false)
      worker.postMessage("fixture.release")
      expect(await accepted).toBe("joined")
      const outcomes = await results
      const snapshot = await native.promise
      expect(snapshot.instances).toEqual([])
      expect(snapshot.phase).toBe("closed")
      expect(snapshot.events).toEqual(["ingest", "instances", "server", "handler"])
      for (const result of outcomes) {
        if (failed) {
          expect(result.status).toBe("rejected")
          if (result.status === "rejected") expect(String(result.reason)).toContain("TUI worker shutdown failed")
          continue
        }
        expect(result.status).toBe("fulfilled")
        if (result.status === "fulfilled")
          expect(result.value).toEqual([{ value: "before" }, { value: "joined" }, { value: "cleanup" }])
      }
      if (failed) expect(await refusal.promise).toContain("actual worker heap finalizer failed")
      using db = new Database(file, { readonly: true })
      expect(db.query("SELECT value FROM worker_retirement ORDER BY rowid").all()).toEqual([
        { value: "before" },
        { value: "joined" },
        { value: "cleanup" },
      ])
    }
    try {
      await Promise.race([exercise(), broken.promise])
    } finally {
      clearTimeout(timer)
      worker.terminate()
    }
  }, 30_000)

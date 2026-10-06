import { expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { BackgroundJob } from "@/background/job"
import { RayaGoal } from "@/kilocode/goal"
import { Server } from "@/server/server"
import { withTimeout } from "@/util/timeout"
import { tmpdir } from "../../fixture/fixture"

const closed = (error: unknown) => error instanceof TypeError && "code" in error && error.code === "ECONNRESET"

test("production listener retires open workspace and global SSE with a blocked Goal", async () => {
  await using dir = await tmpdir()
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
  const outcome = await Promise.allSettled([
    (async () => {
      const id = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          const ctx = yield* store.load({ directory: dir.path })
          return yield* Effect.gen(function* () {
            const sessions = yield* Session.Service
            const storage = yield* Storage.Service
            const background = yield* BackgroundJob.Service
            const session = yield* sessions.create()
            const goals = RayaGoal.make({ sessions, storage, background })
            yield* goals.create(session.id, "Verify the saved fixture before completion")
            const blocked = yield* goals.update(session.id, {
              status: "blocked",
              reason: "Exact saved-file verification failed",
            })
            expect(blocked.status).toBe("blocked")
            return session.id
          }).pipe(Effect.provideService(InstanceRef, ctx))
        }),
      )
      expect(id).toStartWith("ses_")
      for (const route of ["/event", "/global/event"]) {
        const url = new URL(route, listener.url)
        url.searchParams.set("directory", dir.path)
        const response = await fetch(url)
        expect(response.status).toBe(200)
        const reader = response.body!.getReader()
        readers.push(reader)
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
      }
      await listener.quiesce()
      const started = performance.now()
      await withTimeout(listener.stop(true), 10_000, "Original workspace listener did not retire")
      expect(performance.now() - started).toBeLessThan(10_000)
      await listener.stop(true)
      for (const reader of readers) {
        const result = await Promise.allSettled([reader.read()])
        expect(result[0].status === "rejected" ? closed(result[0].reason) : result[0].value.done).toBe(true)
        if (process.platform === "win32") {
          expect(result[0].status).toBe("rejected")
          if (result[0].status === "rejected") expect(closed(result[0].reason)).toBe(true)
        }
      }
    })(),
  ])
  // Only after the original stop assertion: clients cannot make shutdown pass by closing first.
  const cancelled = await Promise.allSettled(readers.map((reader) => reader.cancel()))
  for (const row of cancelled) {
    if (row.status === "rejected" && !closed(row.reason)) outcome.push(row)
  }
  const cleanup = await Promise.allSettled([listener.stop(true)])
  const errors = [...outcome, ...cleanup].flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
  if (errors.length) throw new AggregateError(errors, "Original workspace listener or cleanup failed")
}, 30_000)

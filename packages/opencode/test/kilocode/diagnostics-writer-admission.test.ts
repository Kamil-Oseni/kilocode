import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { HeapSnapshot } from "@/kilocode/cli/heap-snapshot"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { createTrace, publish } from "@/cli/cmd/run/trace"
import { tmpdir } from "../fixture/fixture"

const id = "profile.log.diagnostics"

async function registry() {
  const registry = ProfileWriterRegistry.make([id])
  await Effect.runPromise(registry.register(id))
  return { registry, admission: ProfileWriterLive.from(registry, id) }
}

describe("process-local diagnostics writer admission", () => {
  test("heap roots resolve inside admission and native writes receive unique diagnostic paths", async () => {
    await using tmp = await tmpdir()
    const item = await registry()
    const roots = [path.join(tmp.path, "first"), path.join(tmp.path, "second")]
    const files: string[] = []
    let index = 0
    const deps: HeapSnapshot.Deps = {
      admission: item.admission,
      root() {
        return roots[index]
      },
      write(file) {
        files.push(file)
        return file
      },
      now: () => new Date("2026-09-15T12:34:56.789Z"),
      pid: () => 42,
      role: () => "main",
    }

    const first = await HeapSnapshot.write({ role: "http api" }, deps)
    index = 1
    const second = await Effect.runPromise(HeapSnapshot.generate({ role: "http api" }, deps))
    expect(first).toStartWith(roots[0])
    expect(second).toStartWith(roots[1])
    expect(files).toHaveLength(2)
    expect(path.basename(files[0])).toMatch(/^heap-http-api-42-2026-09-15T123456789Z-\d{4}\.heapsnapshot$/)
    expect(files[1]).not.toBe(files[0])
    expect((await Effect.runPromise(item.registry.snapshot)).active).toEqual([])
  })

  test("closed admission rejects a heap before resolving its root or invoking V8", async () => {
    const item = await registry()
    const entered = await Effect.runPromise(Deferred.make<void>())
    const owner = Effect.runFork(
      item.registry.quiesce(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
    )
    await Effect.runPromise(Deferred.await(entered))
    let roots = 0
    let writes = 0
    const result = await Effect.runPromise(
      HeapSnapshot.generate(
        {},
        {
          admission: item.admission,
          root: () => {
            roots++
            return "outside"
          },
          write: (file) => {
            writes++
            return file
          },
          now: () => new Date(0),
          pid: () => 1,
          role: () => "test",
        },
      ).pipe(Effect.exit),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(roots).toBe(0)
    expect(writes).toBe(0)
    await Effect.runPromise(Fiber.interrupt(owner))
  })

  test("automatic monitor suppresses overlap and stop awaits the active write", async () => {
    let scheduled: (() => void) | undefined
    let cleared = false
    let writes = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const monitor = HeapSnapshot.monitor({
      enabled: true,
      interval: 5,
      limit: 10,
      memory: () => 11,
      schedule(run) {
        scheduled = run
        return { clear: () => (cleared = true) }
      },
      write: async () => {
        writes++
        await gate
        return "heap"
      },
      warn: () => undefined,
    })

    scheduled?.()
    await Promise.resolve()
    scheduled?.()
    expect(writes).toBe(1)
    let stopped = false
    const stop = monitor.stop().then(() => (stopped = true))
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await stop
    expect(cleared).toBe(true)
    await monitor.tick()
    expect(writes).toBe(1)
  })

  test("automatic monitor retries a failed admitted write while RSS stays high", async () => {
    let writes = 0
    let warnings = 0
    const monitor = HeapSnapshot.monitor({
      enabled: false,
      interval: 5,
      limit: 10,
      memory: () => 11,
      schedule: () => ({ clear: () => undefined }),
      write: async () => {
        writes++
        if (writes === 1) throw new Error("admission closed")
        return "heap"
      },
      warn: () => warnings++,
    })
    await monitor.tick()
    await monitor.tick()
    expect(writes).toBe(2)
    expect(warnings).toBe(1)
  })

  test("automatic lifecycle shares stop, forbids restart during drain, then restarts", async () => {
    let creates = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const lifecycle = HeapSnapshot.lifecycle(() => {
      creates++
      return {
        tick: async () => undefined,
        stop: () => gate,
      }
    })
    lifecycle.start()
    const first = lifecycle.stop()
    const second = lifecycle.stop()
    lifecycle.start()
    expect(first).toBe(second)
    expect(creates).toBe(1)
    release()
    await first
    lifecycle.start()
    expect(creates).toBe(2)
  })

  test("atomic latest publisher removes its temporary file when rename fails", () => {
    const files = new Set<string>()
    expect(() =>
      publish("latest.json", "value", {
        pid: 42,
        id: () => "test",
        write(file) {
          files.add(file)
        },
        rename() {
          throw new Error("rename failed")
        },
        exists: (file) => files.has(file),
        remove: (file) => {
          files.delete(file)
        },
      }),
    ).toThrow("rename failed")
    expect(files.size).toBe(0)
  })

  test("trace publishes a generation only after its first append succeeds", () => {
    const writes: string[] = []
    const latest: string[] = []
    let fail = true
    const trace = createTrace({
      admission: { run: (body) => body },
      enabled: () => true,
      root: () => "root",
      now: () => new Date("2026-09-15T12:34:56.789Z"),
      pid: () => 42,
      cwd: () => "project",
      argv: () => ["run"],
      mkdir: () => undefined,
      append(file) {
        if (fail) throw new Error("append failed")
        writes.push(file)
      },
      publish: (file) => latest.push(file),
      warn: () => undefined,
    })
    expect(latest).toEqual([])
    fail = false
    trace?.write("retry")
    expect(writes).toHaveLength(1)
    expect(latest).toEqual([path.join("root", "direct", "latest.json")])
  })

  test("trace rotates after root changes and drops closed admission without touching a path", () => {
    let active = 0
    let open = true
    const admission: ProfileWriterLive.Admission = {
      run: (body) =>
        open
          ? Effect.acquireUseRelease(
              Effect.sync(() => active++),
              () => body,
              () => Effect.sync(() => active--),
            )
          : Effect.die(new Error("admission closed")),
    }
    let root = "first"
    const files: string[] = []
    const latest: string[] = []
    const warnings: unknown[] = []
    const trace = createTrace({
      admission,
      enabled: () => true,
      root: () => {
        expect(active).toBe(1)
        return root
      },
      now: () => new Date("2026-09-15T12:34:56.789Z"),
      pid: () => 42,
      cwd: () => "project",
      argv: () => ["run"],
      mkdir: () => undefined,
      append: (file) => files.push(file),
      publish: (file) => latest.push(file),
      warn: (err) => warnings.push(err),
    })
    expect(trace).toBeDefined()
    trace?.write("first")
    root = "second"
    trace?.write("second")
    expect(new Set(files.map((file) => path.dirname(path.dirname(file))))).toEqual(new Set(["first", "second"]))
    expect(latest).toEqual([path.join("first", "direct", "latest.json"), path.join("second", "direct", "latest.json")])
    const before = files.length
    open = false
    trace?.write("closed")
    trace?.write("closed-again")
    expect(files).toHaveLength(before)
    expect(warnings).toHaveLength(1)
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { EventV2 } from "../../src/event"
import { Location } from "../../src/location"
import { Pty } from "../../src/pty"
import { SessionSchema } from "../../src/session/schema"
import { AbsolutePath } from "../../src/schema"
import { KiloPtyLifecycle, type Request, type Identity } from "../../src/kilocode/pty/lifecycle"
import { NativeProcess } from "../../src/kilocode/process-host"
import * as Registry from "../../src/kilocode/pty/registry"
import { location } from "../fixture/location"

const suite = process.platform === "win32" ? describe : describe.skip
const command = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

async function wait(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 60000
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error("Contained PTY fixture timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fixture(paused = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-core-pty-"))
  const entries: Array<{ request: Request; token: string; control: string; identity?: Identity; retired: boolean }> = []
  let resume: () => void = () => undefined
  const gate = paused
    ? new Promise<void>((resolve) => {
        resume = resolve
      })
    : Promise.resolve()
  const adapter = Layer.succeed(
    KiloPtyLifecycle.Service,
    KiloPtyLifecycle.Service.of({
      admission: (request, body) =>
        Effect.gen(function* () {
          const token = randomUUID()
          const control = path.join(dir, token)
          const row = { request, token, control, identity: undefined as Identity | undefined, retired: false }
          entries.push(row)
          const save = (phase: string) =>
            Effect.promise(() =>
              writeFile(
                `${control}.owner`,
                JSON.stringify({ version: 1, request, token, identity: row.identity, phase }),
                { mode: 0o600 },
              ),
            )
          yield* save("reserved")
          return yield* body({
            token,
            control,
            dispatch: () => save("dispatched"),
            admit: (identity) =>
              Effect.gen(function* () {
                row.identity = identity
                yield* save("admitted")
                yield* Effect.promise(() => gate)
              }),
            retire: (proof) =>
              Effect.gen(function* () {
                expect(proof).toEqual({ version: 2, token, proof: "windows-job", empty: true })
                yield* save("retired")
                row.retired = true
              }),
          })
        }),
    }),
  )
  const target = Location.Ref.make({ directory: AbsolutePath.make(dir) })
  const layer = (bound = true) =>
    AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location(target)))],
      ...(bound ? [[KiloPtyLifecycle.node, adapter] as const] : []),
    ])
  return {
    dir,
    entries,
    resume: () => resume(),
    layer,
    async run(
      body: (
        pty: Pty.Interface,
        run: <A, E>(value: Effect.Effect<A, E>, opts?: { signal?: AbortSignal }) => Promise<A>,
        seen: string[],
      ) => Promise<void>,
      bound = true,
    ) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const pty = yield* Pty.Service
          const events = yield* EventV2.Service
          const seen: string[] = []
          const off = yield* events.listen((event) => {
            if (event.type === Pty.Event.Created.type || event.type === Pty.Event.Exited.type) seen.push(event.type)
            return Effect.void
          })
          const context = yield* Effect.context()
          yield* Effect.promise(() => body(pty, Effect.runPromiseWith(context), seen)).pipe(Effect.ensuring(off))
        }).pipe(Effect.provide(layer(bound)), Effect.scoped),
      )
    },
    async close() {
      resume()
      await Registry.shutdown()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

suite("contained core PTY lifecycle", () => {
  test("attempts every owned actor when the first durable retirement refuses", async () => {
    const cfg = await fixture()
    const owner = SessionSchema.ID.make("ses_drain_all_owned")
    try {
      await cfg.run(async (pty, run) => {
        const actors = []
        for (let i = 0; i < 5; i++) {
          actors.push(
            await run(
              pty.create({
                command,
                args: ["-NoProfile", "-Command", "while($true){Start-Sleep -Milliseconds 50}"],
                cwd: cfg.dir,
                ownerSessionID: owner,
              }),
            ),
          )
        }
        const row = cfg.entries[0]!
        const file = `${row.control}.owner`
        const saved = await readFile(file)
        await rm(file)
        await mkdir(file)
        try {
          await expect(run(pty.stopOwner(owner))).rejects.toThrow()
          expect(Registry.sessions.has(actors[0]!.id)).toBe(true)
          expect(row.retired).toBe(false)
          for (const actor of actors.slice(1)) {
            expect(Registry.sessions.has(actor.id)).toBe(false)
            expect(await NativeProcess.inspect(actor.pid)).toMatchObject({ status: "gone" })
          }
          expect(cfg.entries.slice(1).every((entry) => entry.retired)).toBe(true)
          expect(await NativeProcess.inspect(actors[0]!.pid)).toMatchObject({ status: "gone" })
        } finally {
          await rm(file, { recursive: true })
          await writeFile(file, saved, { mode: 0o600 })
        }
        await run(pty.stopOwner(owner))
        expect(Registry.sessions.has(actors[0]!.id)).toBe(false)
        expect(row.retired).toBe(true)
      })
    } finally {
      await cfg.close()
    }
  }, 90000)

  test("cancels an interrupted creation before resume without replay", async () => {
    const cfg = await fixture(true)
    const output = path.join(cfg.dir, "unexpected.txt")
    try {
      await cfg.run(async (pty, run) => {
        const abort = new AbortController()
        const pending = run(
          pty.create({
            command,
            args: [
              "-NoProfile",
              "-Command",
              `[IO.File]::WriteAllText('${output.replaceAll("'", "''")}', 'unexpected')`,
            ],
            cwd: cfg.dir,
          }),
          { signal: abort.signal },
        ).then(
          () => false,
          () => true,
        )
        await wait(() => !!cfg.entries[0]?.identity)
        const row = cfg.entries[0]!
        const contained = Registry.sessions.get(row.request.id)!.containment!
        abort.abort()
        expect(await pending).toBe(true)
        await wait(() => row.retired)
        expect(contained.outcome).toBe("cancelled")
        expect(
          await readFile(`${row.control}.go`, "utf8").then(
            () => true,
            () => false,
          ),
        ).toBe(false)
        expect(
          await readFile(output, "utf8").then(
            () => true,
            () => false,
          ),
        ).toBe(false)
        cfg.resume()
        await wait(() => !Registry.sessions.has(row.request.id))
        expect(Registry.sessions.has(row.request.id)).toBe(false)
      })
    } finally {
      await cfg.close()
    }
  }, 90000)

  test("settles an immediate target exit with exact code and ordered events", async () => {
    const cfg = await fixture()
    try {
      await cfg.run(async (pty, run, seen) => {
        const info = await run(
          pty.create({
            command,
            args: ["-NoProfile", "-Command", "exit 7"],
            cwd: cfg.dir,
          }),
        )
        await wait(() => info.status === "exited")
        expect(info.exitCode).toBe(7)
        expect(Registry.sessions.get(info.id)!.containment!.outcome).toBe("confirmed")
        expect(cfg.entries[0]!.retired).toBe(true)
        await wait(() => seen.length === 2)
        expect(seen).toEqual([Pty.Event.Created.type, Pty.Event.Exited.type])
        await run(pty.remove(info.id))
      })
    } finally {
      await cfg.close()
    }
  }, 90000)

  test("refuses a missing authoritative adapter before native spawn", async () => {
    const cfg = await fixture()
    try {
      await expect(
        cfg.run(async (pty, run) => {
          await run(pty.create({ command, args: ["-NoProfile", "-Command", "exit 0"], cwd: cfg.dir }))
        }, false),
      ).rejects.toThrow("authoritative lifecycle adapter")
      expect([...Registry.sessions.values()].filter((row) => row.location.directory === cfg.dir)).toHaveLength(0)
    } finally {
      await cfg.close()
    }
  }, 90000)

  test("blocks input until running and preserves immutable owner after viewed session changes", async () => {
    const cfg = await fixture(true)
    const script = path.join(cfg.dir, "input.ps1")
    const output = path.join(cfg.dir, "input.txt")
    await writeFile(
      script,
      `$line=[Console]::ReadLine(); [IO.File]::WriteAllText('${output.replaceAll("'", "''")}', $line); while($true){Start-Sleep -Milliseconds 50}`,
    )
    const owner = SessionSchema.ID.make("ses_owned")
    const viewed = SessionSchema.ID.make("ses_viewed")
    try {
      await cfg.run(async (pty, run) => {
        const pending = run(
          pty.create({ command, args: ["-NoProfile", "-File", script], cwd: cfg.dir, ownerSessionID: owner }),
        )
        await wait(() => !!cfg.entries[0]?.identity)
        const row = cfg.entries[0]!
        expect(Registry.sessions.has(row.request.id)).toBe(true)
        expect(Registry.sessions.get(row.request.id)!.containment!.writable).toBe(false)
        await run(pty.write(row.request.id, "before\r"))
        cfg.resume()
        const info = await pending
        expect(info.pid).toBe(row.identity!.pid)
        await expect(Registry.sessions.get(info.id)!.containment!.start()).rejects.toThrow("already attempted")
        await run(pty.update(info.id, { sessionID: viewed }))
        await run(pty.stopOwner(viewed))
        expect(Registry.sessions.has(info.id)).toBe(true)
        await run(pty.write(info.id, "after\r"))
        await wait(() =>
          readFile(output, "utf8").then(
            (value) => value === "after",
            () => false,
          ),
        )
        await run(pty.stopOwner(owner))
        expect(Registry.sessions.has(info.id)).toBe(false)
        expect(row.retired).toBe(true)
      })
    } finally {
      await cfg.close()
    }
  }, 90000)

  test("retains a detached descendant after leader exit until directory drain", async () => {
    const cfg = await fixture()
    const script = path.join(cfg.dir, "parent.ps1")
    const leaf = path.join(cfg.dir, "leaf.ps1")
    const output = path.join(cfg.dir, "leaf.txt")
    await writeFile(
      leaf,
      `[IO.File]::WriteAllText('${output.replaceAll("'", "''")}', [string]$PID); while($true){Start-Sleep -Milliseconds 50}`,
    )
    await writeFile(
      script,
      `Start-Process -WindowStyle Hidden -FilePath '${command}' -ArgumentList '-NoProfile','-File','"${leaf}"'; exit 0`,
    )
    try {
      await cfg.run(async (pty, run) => {
        const info = await run(pty.create({ command, args: ["-NoProfile", "-File", script], cwd: cfg.dir }))
        await wait(() =>
          readFile(output, "utf8").then(
            (value) => /^\d+$/.test(value),
            () => false,
          ),
        )
        const pid = Number(await readFile(output, "utf8"))
        await wait(() =>
          NativeProcess.inspect(info.pid).then(
            (value) => typeof value === "object" && value !== null && "status" in value && value.status === "gone",
          ),
        )
        expect((await run(pty.get(info.id))).status).toBe("running")
        expect(cfg.entries[0]!.retired).toBe(false)
        await run(pty.removeDirectory(cfg.entries[0]!.request.location))
        expect(Registry.sessions.has(info.id)).toBe(false)
        expect(await NativeProcess.inspect(pid)).toMatchObject({ status: "gone" })
        expect(cfg.entries[0]!.retired).toBe(true)
      })
    } finally {
      await cfg.close()
    }
  }, 90000)
})

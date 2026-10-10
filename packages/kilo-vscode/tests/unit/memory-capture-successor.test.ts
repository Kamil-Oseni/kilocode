import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { lstat, readFile, writeFile, rm } from "node:fs/promises"
import { command } from "../../src/second-brain/control/command"
import { image, observe } from "../../src/second-brain/control/identity"
import { packaged } from "../../src/second-brain/control/index"
import { BrainSettings, parse } from "../../src/second-brain/settings"
import { associate, fresh, linked } from "../../src/second-brain/managed/capture-upgrade"
import { descriptor, selection } from "../../src/second-brain/managed/descriptor"
import { successors } from "../../src/second-brain/managed/capture-lineage"
import { launch } from "../../src/second-brain/managed/restart"
import { generation } from "../../src/second-brain/managed/generation"
import { Pair } from "../../src/second-brain/managed/pair"
import { Pipes, publish } from "../../src/second-brain/managed/owner"
import { spawn } from "../../src/util/process"

const native = process.platform === "win32" ? test : test.skip
type Entry = Parameters<typeof successors>[0]
const body = `import sys,json
print(json.dumps({'format':'raya.memory.disposable.supervisor.phase','phase':'launch-selected'}),flush=True)
assert sys.stdin.buffer.readline(8)==b'START\\n'
print(json.dumps({'format':'raya.memory.disposable.supervisor.phase','phase':'uvicorn-started'}),flush=True)
assert sys.stdin.buffer.readline(8) in (b'STOP\\n',b'')
print(json.dumps({'format':'raya.memory.disposable.supervisor.closed','passed':True,'errors':[],'control_joined':True}),flush=True)
`

native(
  "original committed capture admits only actual closed same-setup namespace successors",
  async () => {
    const produced = await command(
      process.execPath,
      [path.resolve("tests/unit/fixtures/committed-capture-producer.ts"), "--runtime"],
      { cwd: process.cwd() },
    )
    const fixture = JSON.parse(produced.stdout) as { root: string; file: string; turn: unknown }
    expect(produced.receipt).toMatchObject({ code: 0, originalJoined: true, readersJoined: true, forced: false })
    try {
      const saved = JSON.parse(await readFile(fixture.file, "utf8")) as Record<string, unknown>
      const previous = saved["raya.secondBrain.setup"] as Entry
      const storage = {
        get<T>(key: string) {
          return (JSON.parse(readFileSync(fixture.file, "utf8")) as Record<string, unknown>)[key] as T | undefined
        },
        async update(key: string, value: unknown) {
          const rows = JSON.parse(await readFile(fixture.file, "utf8")) as Record<string, unknown>
          if (value === undefined) delete rows[key]
          if (value !== undefined) rows[key] = value
          await writeFile(fixture.file, JSON.stringify(rows))
        },
      }
      const settings = new BrainSettings(storage, {
        async get() {
          return "synthetic"
        },
        async store() {},
        async delete() {},
      })
      const reviewed = await settings.recoverCapture(process.cwd(), fixture.turn, async () => true)
      if (!reviewed) throw new Error("Actual capture recovery required")
      expect(reviewed.capture).toBeDefined()
      const cfg = descriptor(previous.managed)
      const setup = parse(previous.setup)
      const prior = previous.launch as { history?: unknown[] }
      const closed = {
        ...previous,
        launch: {
          phase: "closed",
          receipt: reviewed.closure.closed,
          ...(prior.history ? { history: prior.history } : {}),
        },
      }
      await storage.update("raya.secondBrain.setup", closed)
      const initial = await settings.reviewCapture(process.cwd(), fixture.turn)
      await fresh(initial, storage)
      expect((await successors(previous, closed, reviewed.closure.closed)).generations).toBe(0)
      const context = await launch(cfg, setup, reviewed.closure.closed)
      const before = await selection(cfg, setup)
      const current = await generation(cfg, context, before.files)
      const inputs = await selection(current, setup)
      const root = await lstat(cfg.root, { bigint: true })
      const selected = await publish(path.join(context.root, "managed-reservation.json"), {
        format: "raya.memory.managed.pair.selected",
        version: 2,
        descriptor: current,
        rootIdentity: [root.dev, root.ino, root.birthtimeNs].map(String),
        images: inputs.files.map((item, index) => ({
          ref: [current.python, current.supervisor, current.plan, current.retrieval][index],
          sha256: item.digest,
          tuple: item.tuple,
        })),
        containment: "Actual controlled nonmodel original processes and their pipes only",
        predecessor: reviewed.closure.closed,
      })
      expect(
        (
          await successors(
            previous,
            {
              ...previous,
              managed: current,
              launch: {
                phase: "selected",
                receipt: selected,
                history: [...(prior.history ?? []), reviewed.closure.closed],
              },
            },
            reviewed.closure.closed,
          )
        ).generations,
      ).toBe(1)
      const helper = await packaged(process.cwd())
      const pair = new Pair()
      const originals: Record<string, unknown> = {}
      let original!: Awaited<ReturnType<typeof publish>>
      try {
        await pair.start(
          async (kind) => {
            const child = spawn(cfg.python.path, ["-I", "-S", "-B", "-u", "-c", body], {
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            })
            const pipes = new Pipes(child)
            pair.hold(kind, pipes)
            await pipes.ready("launch-selected")
            const identity = await observe(child, cfg.python.path, helper.helper, cfg.python.sha256)
            originals[kind] = await publish(path.join(context.root, `managed-${kind}-original.json`), {
              format: "raya.memory.managed.pair.original",
              version: 2,
              kind,
              selected,
              identity,
              imageObservation: "Actual selected native process image",
              nativeFamilyRetirement: false,
            })
            await pipes.start()
            await pipes.ready("uvicorn-started")
          },
          async () => {
            original = await publish(path.join(context.root, "managed-original.json"), {
              format: "raya.memory.managed.pair.originals",
              version: 2,
              selected,
              originals,
            })
            const running = {
              ...previous,
              managed: current,
              launch: {
                phase: "running",
                receipt: original,
                history: [...(prior.history ?? []), reviewed.closure.closed],
              },
            }
            await storage.update("raya.secondBrain.setup", running)
            await expect(fresh(initial, storage)).rejects.toThrow()
            const rebound = await settings.reviewCapture(process.cwd(), fixture.turn)
            expect({ ...rebound, producer: undefined }).toEqual({ ...initial, producer: undefined })
            await fresh(rebound, storage)
            const proof = await successors(previous, running, reviewed.closure.closed)
            expect(proof.descriptors).toEqual([cfg, current])
            expect(Object.isFrozen(proof.descriptors)).toBe(true)
            expect(Object.isFrozen(proof.descriptors[1].namespaces)).toBe(true)
            expect(
              (
                await successors(
                  previous,
                  {
                    ...previous,
                    managed: current,
                    launch: {
                      phase: "running",
                      receipt: original,
                      history: [...(prior.history ?? []), reviewed.closure.closed],
                    },
                  },
                  reviewed.closure.closed,
                )
              ).generations,
            ).toBe(1)
          },
        )
      } finally {
        const closures = await pair.close()
        for (const value of Object.values(closures))
          expect(value).toMatchObject({
            code: 0,
            eof: { stdout: true, stderr: true },
            originalJoined: true,
            readersJoined: true,
            forced: false,
          })
        const ended = await publish(path.join(context.root, "managed-closed.json"), {
          format: "raya.memory.managed.pair.closed",
          version: 2,
          selected,
          original,
          closures,
          qualification: "Actual controlled nonmodel original processes/streams only; no cold settlement authority",
        })
        const next: Entry = {
          ...previous,
          managed: current,
          launch: { phase: "closed", receipt: ended, history: [...(prior.history ?? []), reviewed.closure.closed] },
        }
        await storage.update("raya.secondBrain.setup", next)
        const cold = (JSON.parse(await readFile(fixture.file, "utf8")) as Record<string, Entry>)[
          "raya.secondBrain.setup"
        ]
        expect(await successors(previous, cold, reviewed.closure.closed)).toMatchObject({
          generations: 1,
          anchor: reviewed.closure.closed,
          requestSettlement: false,
          replay: false,
        })
        await expect(successors(previous, { ...cold, credential: "foreign" }, reviewed.closure.closed)).rejects.toThrow(
          "setup or credential",
        )
        await expect(
          successors(
            previous,
            { ...cold, setup: { ...setup, origin: "http://127.0.0.1:58743" } },
            reviewed.closure.closed,
          ),
        ).rejects.toThrow("setup or credential")
        await expect(
          successors(
            previous,
            { ...cold, launch: { phase: "uncertain", receipt: original, history: [reviewed.closure.closed] } },
            reviewed.closure.closed,
          ),
        ).rejects.toThrow("lineage phase")
        await expect(
          successors(previous, { ...cold, launch: { phase: "closed", receipt: ended } }, reviewed.closure.closed),
        ).rejects.toThrow("history prefix")
        await expect(
          successors(
            previous,
            { ...cold, launch: { phase: "closed", receipt: ended, history: [ended, reviewed.closure.closed] } },
            reviewed.closure.closed,
          ),
        ).rejects.toThrow()
        await expect(successors(previous, { ...cold, managed: cfg }, reviewed.closure.closed)).rejects.toThrow(
          "successor projection",
        )
        await expect(successors(previous, cold, ended)).rejects.toThrow("another original launch")
        const final = await settings.reviewCapture(process.cwd(), fixture.turn)
        expect({ ...final, producer: undefined }).toEqual({ ...initial, producer: undefined })
        await associate(storage, previous, cold, final)
        expect(linked(final, storage)).toBeUndefined()
        await fresh(final, storage)
        await expect(fresh({ ...final }, storage)).rejects.toThrow("qualification was not retained")
        const raw = await readFile(current.plan.path)
        await writeFile(current.plan.path, Buffer.concat([raw, Buffer.from(" ")]))
        await expect(successors(previous, cold, reviewed.closure.closed)).rejects.toThrow()
        await writeFile(current.plan.path, raw)
        await expect(fresh(final, storage)).rejects.toThrow("selected images changed")
        // Restored bytes do not restore the original selected native tuple.
        await expect(successors(previous, cold, reviewed.closure.closed)).rejects.toThrow("selected images changed")
        const retained = await readFile(reviewed.closure.closed.path)
        await writeFile(reviewed.closure.closed.path, Buffer.concat([retained, Buffer.from(" ")]))
        await expect(fresh(final, storage)).rejects.toThrow("Original capture lineage receipt changed")
      }
    } finally {
      expect(path.dirname(fixture.root)).toBe(path.resolve(tmpdir()))
      expect(path.basename(fixture.root).startsWith("raya-namespace-test-")).toBe(true)
      await rm(fixture.root, { recursive: true })
    }
  },
  90000,
)

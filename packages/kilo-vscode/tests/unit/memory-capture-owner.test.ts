import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { BrainSettings } from "../../src/second-brain/settings"
import { OperationOwner } from "../../src/second-brain/operation-owner"
import type { Publication } from "../../src/second-brain/client-v2"
import { BrainService } from "../../src/second-brain/service"
import { BrainControl } from "../../src/second-brain/control"
import { Control, parseCatalog } from "../../src/second-brain/control/index"
import { bridge } from "../../src/second-brain/control/catalog-capture"
import { failure } from "../../src/second-brain/capture-failure"

for (const mode of ["owner", "control"] as const)
  test(`original localhost ${mode} capture settles its real host journal`, async () => {
    const child = Bun.spawn(
      [
        "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe",
        "-B",
        path.resolve("script/memory/capture_owner_fixture.py"),
        ...(mode === "control" ? ["--indexed-empty"] : []),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const reader = child.stdout.getReader()
    const stderr = new Response(child.stderr).text()
    let prefix = ""
    let owner: OperationOwner | undefined
    let control: BrainControl | undefined
    let service: BrainService | undefined
    let stdout: Promise<string> | undefined
    try {
      while (!prefix.includes("\n")) {
        const next = await reader.read()
        if (next.done) throw new Error("Original capture fixture closed before preparation")
        prefix += new TextDecoder().decode(next.value)
      }
      const index = prefix.indexOf("\n")
      const fixture = JSON.parse(prefix.slice(0, index)) as {
        root: string
        temporary: string
        key: string
        origin: string
        body: Publication
        policy_sha256: string
        source_sha256: Record<string, string>
      }
      stdout = (async () => {
        let text = prefix.slice(index + 1)
        while (true) {
          const next = await reader.read()
          if (next.done) break
          text += new TextDecoder().decode(next.value)
        }
        reader.releaseLock()
        return text
      })()
      const file = path.join(fixture.temporary, "host-state.json")
      await writeFile(file, "{}")
      const keys = new Map<string, string>()
      const settings = new BrainSettings(
        {
          get<T>(key: string) {
            return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
          },
          async update(key, value) {
            const state = JSON.parse(await readFile(file, "utf8"))
            if (value === undefined) delete state[key]
            if (value !== undefined) state[key] = value
            await writeFile(file, JSON.stringify(state))
          },
        },
        {
          async get(key) {
            return keys.get(key)
          },
          async store(key, value) {
            keys.set(key, value)
          },
          async delete(key) {
            keys.delete(key)
          },
        },
      )
      await settings.save(
        {
          format: "raya.memory.setup",
          version: 2,
          protocol: "raya.memory.operation.v2",
          root: fixture.root,
          origin: fixture.origin,
          source_sha256: fixture.source_sha256,
        },
        fixture.key,
      )
      const cfg = (await settings.load())!
      if (mode === "control") {
        service = new BrainService(settings)
        const catalog = parseCatalog({
          format: "raya.memory.control.catalog",
          version: 2,
          python: "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
          python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
          source: path.resolve("script/memory/service"),
          bridge: path.resolve("script/memory/control.py"),
          bridge_sha256: bridge,
          source_sha256: fixture.source_sha256,
        })
        control = new BrainControl(service, settings, (setup) => Control.open(setup.root, catalog, process.cwd()))
        await expect(service.captureSelection(new AbortController().signal, "0".repeat(64))).rejects.toThrow(
          "exact current derived index",
        )
        const binding = await service.captureSelection(new AbortController().signal, fixture.policy_sha256)
        expect(binding.digest).toBe(fixture.policy_sha256)
        expect(binding.index).toBe("synced")
        const original = await control
          .capture(fixture.body, () => {
            if (!service!.captureCurrent(binding)) throw new Error("Original test binding changed")
          })
          .then(
            () => undefined,
            (err: unknown) => err,
          )
        expect(failure(original)).toEqual({ stage: "index", errors: ["service_error", "retirement_unconfirmed"] })
        const policy = JSON.parse(await readFile(path.join(fixture.root, "System/general-admission.json"), "utf8"))
        expect(policy.revision).toBe(2)
        expect(policy.files).toHaveLength(1)
        expect(settings.pending()?.request).toHaveProperty("op", "sync")
        return
      }
      service = new BrainService(settings)
      await expect(service.captureSelection(new AbortController().signal, fixture.policy_sha256)).rejects.toThrow(
        "exact current derived index",
      )
      owner = new OperationOwner(settings, cfg.key, cfg.setup)
      const result = await owner.capture(fixture.body, fixture.policy_sha256, {
        id: crypto.randomUUID().replaceAll("-", ""),
      })
      expect(result.id).toBe(fixture.body.id)
      expect(result.status).toBe("committed")
      expect(result.duplicate).toBe(false)
      expect(settings.pending()).toBeUndefined()
      expect(owner.retired()).toBe(true)
      const health = await owner.health()
      expect(health.index?.status).toBe("approved")
      const note = await readFile(path.join(fixture.root, "Preferences/Raya.md"), "utf8")
      expect(note.match(/## Raya capture /g)).toHaveLength(1)
    } finally {
      const closed = owner?.dispose()
      const cleanup = await Promise.allSettled([control?.dispose(), service?.dispose()])
      child.stdin.end()
      const drained =
        stdout ??
        (async () => {
          while (!(await reader.read()).done) {
            /* Drain the original pipe after preparation failure. */
          }
          reader.releaseLock()
          return ""
        })()
      const [code, output, error] = await Promise.all([child.exited, drained, stderr, closed])
      expect(code, String(error)).toBe(0)
      expect(output).toBe("")
      expect(error).toBe("")
      if (mode === "owner") expect(cleanup.every((row) => row.status === "fulfilled")).toBe(true)
    }
  }, 30_000)

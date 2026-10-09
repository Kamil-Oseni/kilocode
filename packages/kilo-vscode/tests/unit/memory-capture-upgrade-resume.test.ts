import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { exec } from "../../src/util/process"
import { sha } from "../../src/second-brain/control/frames"
import { release } from "../../src/second-brain/control/catalog-capture"
import { cohort } from "../../src/second-brain/managed/reuse-catalog"
import { publish, anchor, guard, inspectAncestor } from "../../src/second-brain/managed/upgrade-publish"
import { descriptor } from "../../src/second-brain/managed/descriptor"
import { BrainSettings, parse } from "../../src/second-brain/settings"
import { linked, ancestry, historical } from "../../src/second-brain/managed/capture-upgrade"
import { review, rebind } from "../../src/second-brain/committed-capture"
import { CaptureIntake } from "../../src/second-brain/capture-intake"
import { fingerprint } from "../../src/second-brain/failed-repair"

test("direct capture upgrade authenticates an actual old intermediate and resumes every publication prefix", async () => {
  const parent = path.resolve("../../.tmp")
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(path.join(parent, "raya-capture-resume-"))
  const modules = path.join(dir, "recipe")
  const extension = path.join(dir, "extension")
  const base = path.join(extension, "script/memory")
  const names = [
    "src/second-brain/managed/materialize.ts",
    "src/second-brain/managed/upgrade.ts",
    "src/second-brain/managed/upgrade-observe.ts",
    "src/second-brain/managed/catalog.ts",
    "src/second-brain/managed/reuse-catalog.ts",
    "tests/unit/fixtures/native-memory-runtime.ts",
    "tests/unit/fixtures/committed-capture-producer.ts",
  ]
  const archive = async (name: string) => {
    const result = await exec("git", ["show", "9bb63c24a2:packages/kilo-vscode/" + name], {
      maxBuffer: 1048576,
      timeout: 10000,
    })
    return Buffer.from(result.stdout)
  }
  const mapped = new Map(names.map((name) => [path.resolve(name), path.join(modules, path.basename(name))]))
  const witness: Record<string, unknown> = { failed: false }
  await mkdir(modules)
  const pins = cohort("42e505128a3bfbba2346e76031424d0805e3608e2582ec4932ed68c8792b8610")
  try {
    await cp(path.resolve("script/memory"), base, { recursive: true })
    await mkdir(path.join(extension, "bin"))
    for (const name of ["raya-process-host.exe", "raya-process-host.pdb", "raya-process-host.json"])
      await cp(path.resolve("bin", name), path.join(extension, "bin", name))
    for (const [name, digest] of [
      ...Object.entries(release).map(([name, digest]) => ["service/" + name, digest]),
      ...Object.entries(pins),
      ["supervise.py", "baed8f707876f323d4dac18492ac35a2af304f91fcc7a60422013b5c368d45c2"],
    ]) {
      const raw = await archive("script/memory/" + name)
      expect(sha(raw)).toBe(digest)
      const target = path.join(base, name)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, raw)
    }
    for (const name of names) {
      const raw = name.endsWith("committed-capture-producer.ts")
        ? await readFile(path.resolve(name))
        : await archive(name)
      // Run the actual historical recipe; bind unchanged dependencies to the current implementation.
      const bound = raw.toString().replace(/from "([^"]+)"/g, (match, spec: string) => {
        if (!spec.startsWith(".")) return match
        const original = path.resolve(path.dirname(name), spec + ".ts")
        return "from " + JSON.stringify(mapped.get(original) ?? original)
      })
      await writeFile(mapped.get(path.resolve(name))!, bound)
    }
    const child = Bun.spawn([process.execPath, path.join(modules, "committed-capture-producer.ts"), "--runtime"], {
      cwd: extension,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, errors).toBe(0)
    const fixture = JSON.parse(output) as { root: string; file: string; turn: { id: string } }
    witness.fixture = fixture
    const state = "raya.secondBrain.setup"
    const fence = "raya.secondBrain.committedCaptureRecovery.pending"
    const storage = (file: string, fail?: string) => ({
      get<T>(key: string) {
        return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
      },
      async update(key: string, value: unknown) {
        const data = JSON.parse(await readFile(file, "utf8"))
        if (value === undefined) delete data[key]
        if (value !== undefined) data[key] = value
        await writeFile(file, JSON.stringify(data))
        if (key === fail) throw new Error("Actual physical write acknowledgement lost")
      },
    })
    const settings = (saved: ReturnType<typeof storage>) =>
      new BrainSettings(saved, {
        async get() {
          return "synthetic"
        },
        async store() {},
        async delete() {},
      })
    const saved = storage(fixture.file)
    try {
      const original = await settings(saved).recoverCapture(process.cwd(), fixture.turn, async () => true)
      expect(original).toBeDefined()
      witness.closure = original!.closure
      const key = `raya.secondBrain.committedCaptureRecovery.${fixture.turn.id}`
      const recovery = saved.get<{
        previous: Parameters<typeof review>[1]
        debt: Parameters<typeof review>[2]
        turn: Parameters<typeof review>[3]
      }>(key)!
      witness.recovery = recovery
      // This tests durable confirmation provenance; the synthetic binding claims no model/index qualification.
      await new CaptureIntake(saved).confirmRecovery(
        original!,
        {
          root: original!.root,
          release: fingerprint(parse(recovery.previous.setup).source_sha256),
          owner: "synthetic-confirmation-input",
          generation: {},
          index: "synced",
          digest: original!.policySHA,
        },
        () => {},
      )
      const input = saved.get<unknown[]>("raya.secondBrain.personalCapture.turns")![0]
      const confirmation = saved.get(`${key}.confirmation`)
      const effects = await readFile(original!.evidence.operations[0].path)
      const entry = saved.get<{ setup: unknown; managed: unknown }>(state)!
      const recipe = (await import(
        pathToFileURL(path.join(modules, "materialize.ts")).href
      )) as typeof import("../../src/second-brain/managed/materialize")
      const first = await recipe.materialize(descriptor(entry.managed), parse(entry.setup), extension, "a".repeat(32))
      expect(first.version).toBe(1)
      expect(first.next.managed.supervisor.sha256).toBe(
        "baed8f707876f323d4dac18492ac35a2af304f91fcc7a60422013b5c368d45c2",
      )
      await publish(saved, first.receipt)
      expect(settings(saved).upgrading()).toBe(true)
      expect(saved.get<{ launch?: unknown }>(state)!.launch).toBeUndefined()
      const baseline = await readFile(fixture.file)
      const cases = [fence, state, "raya.secondBrain.control.catalog", "raya.secondBrain.personalCapture"]
      for (const [stage, fail] of cases.entries()) {
        const file = path.join(dir, "prefix-" + stage + ".json")
        witness.file = file
        witness.stage = stage
        await writeFile(file, baseline)
        const faulty = storage(file, fail)
        await expect(settings(faulty).upgradeCapture(process.cwd(), input)).rejects.toThrow("acknowledgement lost")
        const current = storage(file)
        const held = current.get<{ audit: { artifact: Parameters<typeof anchor>[1] } }>(fence)!
        expect(held).toBeDefined()
        const grant = await anchor(current, held.audit.artifact)
        // Optional catalog/consent slots are absent on both sides, so the setup write completes the exact prefix.
        expect(grant.stage).toBe(stage === 0 ? 0 : 3)
        const ancestor = await inspectAncestor(current, first.receipt, grant)
        expect(ancestor.publication.phase).toBe("applied")
        expect(() => guard(current, JSON.parse(JSON.stringify(grant)))).toThrow("Fresh pending")
        if (stage === 1) {
          const value = rebind(await review(process.cwd(), recovery.previous, recovery.debt, recovery.turn), recovery)
          await ancestry(current, recovery.previous, value, grant)
          expect(linked(value)).toBeUndefined()
          expect(() => linked(value, current)).toThrow("Pending capture ancestor")
          await expect(
            new CaptureIntake(current).confirmRecovery(
              value,
              {
                root: value.root,
                release: fingerprint(parse(grant.saved.setup).source_sha256),
                owner: "synthetic-confirmation-input",
                generation: {},
                index: "synced",
                digest: value.policySHA,
              },
              () => {},
            ),
          ).rejects.toThrow("Pending capture ancestor")
          const before = current.get<Record<string, unknown>>(state)!
          await current.update(state, { ...before, credential: "raya.secondBrain.key." + "1".repeat(36) })
          expect(() => historical(value, undefined)).toThrow("anchor changed")
          await current.update(state, before)
          const older = `raya.secondBrain.runtimeUpgrade.${first.id}`
          const audit = current.get(older)
          await current.update(older, undefined)
          await expect(settings(current).upgradeCapture(process.cwd(), input)).rejects.toThrow(
            "runtime upgrade required",
          )
          await current.update(older, audit)
        }
        const reviewed = await settings(current).upgradeCapture(process.cwd(), input)
        expect(reviewed).toBeDefined()
        expect(linked(reviewed!)?.version).toBe(2)
        expect(current.get(fence)).toBeUndefined()
        expect(current.get(key)).toEqual(recovery)
        expect(current.get(`${key}.confirmation`)).toEqual(confirmation)
        expect(await readFile(original!.evidence.operations[0].path)).toEqual(effects)
      }
    } catch (err) {
      witness.failed = true
      const errors = (value: unknown): unknown => {
        if (!(value instanceof Error)) return String(value)
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
          ...(Object.hasOwn(value, "receipt") ? { receipt: (value as Error & { receipt: unknown }).receipt } : {}),
          ...(value instanceof AggregateError ? { errors: value.errors.map(errors) } : {}),
          ...(value.cause === undefined ? {} : { cause: errors(value.cause) }),
        }
      }
      const file = typeof witness.file === "string" ? witness.file : fixture.file
      const retained = JSON.parse(await readFile(file, "utf8"))
      const failure = path.join(dir, "failure.json")
      await writeFile(
        failure,
        JSON.stringify({
          format: "raya.test.capture-upgrade.failure.v1",
          observed: Date.now(),
          witness,
          retained,
          error: errors(err),
          stderrRetainedByBoundary: false,
          qualification: "Failed isolated fixture; no inferred cause or retry authority",
        }),
      )
      throw new Error("Actual isolated failure witnesses retained: " + failure, { cause: err })
    } finally {
      expect(path.dirname(fixture.root)).toBe(path.resolve(os.tmpdir()))
      expect(path.basename(fixture.root).startsWith("raya-namespace-test-")).toBe(true)
      if (!witness.failed) await rm(fixture.root, { recursive: true })
    }
  } finally {
    expect(path.dirname(dir)).toBe(parent)
    if (!witness.failed) await rm(dir, { recursive: true })
  }
}, 180000)

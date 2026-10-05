import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { unseal } from "../../../src/kilocode/migration/profile-bundle"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { identity } from "../../../src/kilocode/migration/profile-workspaces"
import type { ConfigEvidence } from "../../../src/kilocode/migration/profile-config"
import type { disposition } from "../../../src/kilocode/migration/profile-disposition"
import type { memory } from "../../../src/kilocode/migration/profile-memory"
import type z from "zod"
import type { StorageComponents } from "../../../src/kilocode/migration/profile-storage-correspondence"
import type { voice } from "../../../src/kilocode/migration/profile-voice-reconciliation-schema"
import type { composers } from "../../../src/kilocode/migration/profile-composers"
import { validateComposer } from "../../../src/kilocode/migration/profile-composer-correspondence"
import type { operational } from "../../../src/kilocode/migration/profile-operational-schema"
import type { payload } from "../../../src/kilocode/migration/profile-bundle"

export async function roundtrip(
  config: z.output<typeof ConfigEvidence>,
  restored: Awaited<ReturnType<typeof restore>>,
  base: string,
  password: string,
  ledger?: z.output<typeof disposition>,
  memories: readonly z.output<typeof memory>[] = [],
  storage: StorageComponents["json"] = [],
  voices?: z.output<typeof voice>,
  drafts?: z.output<typeof composers>,
  policies?: z.output<typeof operational>,
  prior?: z.output<typeof payload>,
) {
  const quarantines = memories.some((item) => item.quarantine?.length)
    ? await (await import("./source-memory-quarantine-assert")).restored(restored.path, memories)
    : []
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !/^(RAYA|KILO|OPENCODE|OTEL)_/i.test(entry[0]) &&
        !/TOKEN|SECRET|API_KEY|PASSWORD/i.test(entry[0]),
    ),
  )
  Object.assign(env, restored.env, {
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_VSCODE: "1",
    KILO_DISABLE_DEFAULT_PLUGINS: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    RAYA_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
  })
  await mkdir(restored.env.HOME, { recursive: true })
  await mkdir(restored.env.LOCALAPPDATA, { recursive: true })
  const executable = await realpath(process.execPath)
  const sum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const native = path.join(base, "second-hop-native")
  await mkdir(native)
  const helper = path.join(native, "raya-process-host.exe")
  await copyFile(
    process.env.RAYA_TEST_DIRECTORY_HELPER ??
      path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe"),
    helper,
  )
  const session = await launch({
    executable,
    digest: sum(await readFile(executable)),
    cwd: path.resolve(import.meta.dir, "../../.."),
    env,
    roots: [{ kind: "json", path: restored.path }],
    policy: { version: 1, directories: [base], files: [] },
    helper: { executable: helper, digest: sum(await readFile(helper)) },
    args: [
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../../src/kilocode/cli/entry.ts"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    timeout: 60000,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  session.child.stdout?.on("data", (bytes: Buffer) => stdout.push(bytes))
  session.child.stderr?.on("data", (bytes: Buffer) => stderr.push(bytes))
  try {
    await session.start()
    const stop = Date.now() + 45000
    const address = async (): Promise<string> => {
      const match = Buffer.concat(stdout)
        .toString()
        .match(/kilo server listening on (http:\/\/[^\s]+)/)?.[1]
      if (match) return match
      if (session.child.exitCode !== null || Date.now() > stop)
        throw new Error("Second-hop actual Source startup refused")
      await Bun.sleep(25)
      return address()
    }
    const url = await address()
    const profile = { database: path.join(restored.path, "raya.db"), storage: path.join(restored.path, "storage") }
    const response = await fetch(`${url}/config?directory=${encodeURIComponent(restored.path)}`, {
      headers: { "x-kilo-directory": restored.path },
    })
    assert.equal(response.status, 200)
    const output = path.join(os.tmpdir(), `raya-config-second-export-${crypto.randomUUID()}.raya`)
    const result = await exportSource(session, { profile, password, output })
    assert.equal(result.result.status, "exported")
    assert.equal(result.code, 0)
    assert.equal(result.family.familyZeroObserved, true)
    assert.equal((await session.sourceExit).code, 0)
    assert.equal((await session.exit).code, 0)
    const text = await readFile(output, "utf8")
    const bundle = await unseal(text, password)
    const ready = await Bun.file(`${session.ticket.control}.source-handoff-ready`).json()
    const ack = await Bun.file(path.join(ready.value.successor.control, "ack.json")).json()
    assert.equal(bundle.disposition?.directoryCoverage, "verified")
    const graph = bundle.disposition?.globals.find((entry) => entry.data.toLowerCase() === restored.path.toLowerCase())
    assert(graph)
    assert(
      !ack.value.roots.roots.some(
        (entry: { path: string }) => path.basename(entry.path).toLowerCase() === "models.json",
      ),
      "This restored source does not acknowledge a models cache path",
    )
    for (const [dir, name] of [
      [graph.data, "auth.json"],
      [graph.data, "auth.json.raya-intent.json"],
    ]) {
      assert(
        ack.value.roots.roots.some(
          (entry: { kind: string; path: string }) =>
            entry.kind === "json" && entry.path.toLowerCase() === path.join(dir, name).toLowerCase(),
        ),
      )
      const evidence = bundle.disposition?.directories?.find((entry) => entry.path.toLowerCase() === dir.toLowerCase())
      assert(evidence, "Actual held parent directory required")
      assert(
        !evidence.children.some((entry) => entry.name.toLowerCase() === name.toLowerCase()),
        "Actual held child inventory must prove acknowledged absence",
      )
    }
    const integrated = await (
      await import("./source-integrated-correspondence-assert")
    ).assertIntegratedSource(bundle, prior, restored.path)
    if (policies) {
      assert(bundle.archives.some((value) => JSON.stringify(value.operational) === JSON.stringify(policies)))
      assert.deepEqual(
        JSON.parse(await readFile(path.join(restored.path, "restore-operational.json"), "utf8")),
        policies,
      )
    }
    const derived = await (await import("./source-memory-derived-assert")).assertMemoryDerivedSource(bundle)
    if (drafts) {
      assert(bundle.archives.some((value) => JSON.stringify(value.composers) === JSON.stringify(drafts)))
      assert(bundle.composers)
      assert.deepEqual(
        bundle.composers.entries.map((entry) => entry.content),
        drafts.entries.map((entry) => entry.content),
      )
      const claims = bundle.disposition.files.filter((entry) => entry.disposition.kind === "composer-json")
      assert.equal(claims.length, 2)
      for (const entry of claims) {
        if (entry.disposition.kind !== "composer-json") throw new Error("Second-hop composer correspondence missing")
        validateComposer(entry.disposition, bundle)
        assert.equal(entry.disposition.relation, "current-content")
      }
    }
    if (voices) {
      assert(bundle.archives.some((value) => JSON.stringify(value.voice) === JSON.stringify(voices)))
      assert.equal(
        bundle.voice,
        undefined,
        "Held imported voice reconciliation must not become an active source writer",
      )
      assert(!bundle.disposition.files.some((entry) => entry.disposition.kind === "voice-reconciliation"))
    }
    const gitMetadata = await (await import("./source-git-metadata-assert")).assertGitMetadataSource(bundle)
    if (storage.length) {
      assert(bundle.archives.some((value) => JSON.stringify(value.json) === JSON.stringify(storage)))
      const claims = bundle.disposition.files.filter((entry) => entry.disposition.kind === "storage-json")
      assert.equal(claims.length, 5)
      assert.equal(
        new Set(
          claims.map((entry) =>
            entry.disposition.kind === "storage-json" ? entry.disposition.selector.role : "invalid",
          ),
        ).size,
        5,
      )
    }
    if (memories.length) {
      if (quarantines.length)
        (await import("./source-memory-quarantine-assert")).historical(bundle, memories, quarantines)
      assert(bundle.archives?.some((value) => JSON.stringify(value.memory) === JSON.stringify(memories)))
      assert.equal(bundle.memory.length, memories.length)
      for (const item of memories) {
        const value = bundle.memory.find((value) => JSON.stringify(value.sources) === JSON.stringify(item.sources))
        assert(value)
        assert.deepEqual(value.sessions, item.sessions)
        assert.equal(value.decisions, item.decisions)
        for (const record of item.lineage?.records ?? [])
          assert(value.lineage?.records.some((current) => JSON.stringify(current) === JSON.stringify(record)))
      }
    }
    assert(bundle.archives?.some((value) => JSON.stringify(value.config) === JSON.stringify(config)))
    if (ledger) {
      assert.deepEqual(JSON.parse(await readFile(path.join(restored.path, "restore-disposition.json"), "utf8")), ledger)
      assert(bundle.archives.some((value) => JSON.stringify(value.disposition) === JSON.stringify(ledger)))
      const counters = (await import("./source-sql-allocator-assert")).assertAllocatorSource({ disposition: ledger })
      const regenerated = (await import("./source-sql-allocator-assert")).assertAllocatorSource(bundle)
      assert(counters.rows.some((row) => row.seq > 0))
      assert.notDeepEqual(regenerated.rows, counters.rows)
      assert.equal(bundle.disposition?.scope, "selected-held-files")
      assert.equal(bundle.disposition?.portableCaptureAuthorized, false)
    }
    assert(!JSON.stringify(bundle.config).includes("SYNTHETIC_CONFIG_SENTINEL"))
    const target = path.join(base, "second-restored-profile")
    const mappings: Record<string, string> = {}
    const primaries: string[] = []
    for (const [index, workspace] of bundle.workspaces.entries()) {
      const tree = bundle.artifacts?.worktrees.find((tree) => identity(tree.workspace) === identity(workspace))
      if (tree) {
        mappings[workspace] = path.join(target, "data", "kilo", "worktree", tree.project, tree.name)
        continue
      }
      const destination = path.join(base, "second-workspaces", String(index))
      await mkdir(destination, { recursive: true })
      mappings[workspace] = await realpath(destination)
      if (
        bundle.artifacts?.repositories.some(
          (repository) => repository.workspace && identity(repository.workspace) === identity(workspace),
        )
      )
        primaries.push(workspace)
    }
    const next = await restore(text, password, target, mappings, { primaries })
    if (drafts) {
      assert(bundle.composers)
      await (await import("./composer-restored")).verifyComposers(next.path, bundle.composers, mappings)
    }
    if (memories.length) await (await import("./memory-restored")).verify(next.path, bundle.memory)
    const quarantine = quarantines.length
      ? await (await import("./source-memory-quarantine-assert")).restored(next.path, bundle.memory)
      : []
    if (storage.length) await (await import("./storage-restored")).verifyStorage(bundle.json, next.path)
    assert.equal(next.reviewed, false)
    const saved = await unseal(text, password)
    const evidence = JSON.parse(await readFile(path.join(next.path, "restore-source.json"), "utf8"))
    if (ledger) {
      const source = (await import("./source-sql-allocator-assert")).assertAllocatorSource({ disposition: ledger })
      const archived = evidence.archives.find(
        (entry: { disposition?: unknown }) => JSON.stringify(entry.disposition) === JSON.stringify(ledger),
      )
      assert(archived)
      assert.deepEqual((await import("./source-sql-allocator-assert")).assertAllocatorSource(archived), source)
      const metadata = JSON.parse(await readFile(path.join(next.path, "restore-sql-metadata.json"), "utf8"))
      assert.equal(metadata.installation, false)
      assert.notDeepEqual(metadata.entries[0].allocator.rows, source.rows)
    }
    if (policies) {
      assert(
        evidence.archives.some(
          (value: { operational?: unknown }) => JSON.stringify(value.operational) === JSON.stringify(policies),
        ),
      )
      if (bundle.operational)
        assert.deepEqual(
          JSON.parse(await readFile(path.join(next.path, "restore-operational.json"), "utf8")),
          bundle.operational,
        )
      if (!bundle.operational)
        assert.equal(await Bun.file(path.join(next.path, "restore-operational.json")).exists(), false)
    }
    if (voices) {
      assert(
        evidence.archives.some((value: { voice?: unknown }) => JSON.stringify(value.voice) === JSON.stringify(voices)),
      )
      assert.equal(
        await Bun.file(path.join(next.path, "storage/raya/voice/usage-reconciliation/v1.json")).exists(),
        false,
      )
      assert.equal(await Bun.file(path.join(next.path, "storage/raya/voice-reconciliation")).exists(), false)
      assert.equal(
        JSON.parse(await readFile(path.join(next.path, "storage/raya/restore-hold.json"), "utf8")).state,
        "held",
      )
    }
    assert.deepEqual(evidence.archives, saved.archives)
    if (ledger)
      assert(
        evidence.archives.some(
          (value: { disposition?: unknown }) => JSON.stringify(value.disposition) === JSON.stringify(ledger),
        ),
      )
    assert(
      evidence.archives.some((value: { config?: unknown }) => JSON.stringify(value.config) === JSON.stringify(config)),
    )
    for (const name of ["kilo.json", "kilo.jsonc", "explicit.json"]) {
      assert.equal(await Bun.file(path.join(next.env.XDG_CONFIG_HOME, "kilo", name)).exists(), false)
      assert.equal(await Bun.file(path.join(next.env.XDG_CONFIG_HOME, name)).exists(), false)
    }
    for (const pid of [session.ticket.header.pid, session.ticket.header.helper, result.result.receiver.pid])
      assert.throws(() => process.kill(pid, 0))
    assert(
      !Buffer.concat([...stdout, ...stderr])
        .toString()
        .includes(password),
    )
    return {
      passed: true,
      integrated,
      gitMetadata,
      derived,
      quarantine: { first: quarantines, second: quarantine, activeBackups: false },
      composerHistorical: !!drafts,
      operationalHistorical: !!policies,
      voiceHistorical: !!voices,
      voiceActiveWriter: false,
      sourceCode: result.code,
      familyZero: true,
      restored: next.path,
      configHistorical: true,
      configActivated: false,
      compiled: false,
    }
  } catch (err) {
    if (session.child.exitCode === null) {
      const errors: unknown[] = [err, new Error("Second-hop Source required forced fixture cleanup")]
      await session.abort().catch((failure: unknown) => errors.push(failure))
      // eslint-disable-next-line preserve-caught-error -- AggregateError receives cause in its third constructor argument.
      throw new AggregateError(errors, "Second-hop Source fixture failed with forced cleanup", { cause: err })
    }
    throw err
  } finally {
    await writeFile(path.join(base, "second-source-stdout.log"), Buffer.concat(stdout))
    await writeFile(path.join(base, "second-source-stderr.log"), Buffer.concat(stderr))
  }
}

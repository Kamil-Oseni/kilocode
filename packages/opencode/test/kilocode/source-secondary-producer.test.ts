import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { SourceScopes } from "@opencode-ai/core/kilocode/source-scopes"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { payload, snapshot, unseal } from "../../src/kilocode/migration/profile-bundle"
import { identity } from "../../src/kilocode/migration/profile-workspaces"

const sum = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
function environment(root: string) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !/^(RAYA|KILO|OPENCODE|OTEL)_/i.test(entry[0]) &&
          !/TOKEN|SECRET|API_KEY|PASSWORD/i.test(entry[0]),
      ),
    ),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    KILO_TEST_HOME: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "local"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    RAYA_DB: path.join(root, "data", "kilo", "raya.db"),
    KILO_DB: path.join(root, "data", "kilo", "raya.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    KILO_VSCODE: "1",
    KILO_PURE: "1",
    KILO_DISABLE_DEFAULT_PLUGINS: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    RAYA_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
  }
}
async function prepare(root: string) {
  for (const dir of ["home", "local", "data/kilo/storage", "config", "cache", "state"])
    await mkdir(path.join(root, dir), { recursive: true })
}
async function command(root: string, env: Record<string, string>, args: string[], secret?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/kilocode/cli/entry.ts"),
      ...args,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      windowsHide: true,
      stdin: secret ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (secret && child.stdin) {
    await child.stdin.write(JSON.stringify({ password: secret }))
    await child.stdin.end()
  }
  const state = { forced: false }
  const timer = setTimeout(() => {
    state.forced = true
    child.kill()
  }, 60000)
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await writeFile(path.join(root, "import-stdout.log"), out)
    await writeFile(path.join(root, "import-stderr.log"), err)
    assert.equal(state.forced, false)
    assert.equal(code, 0, err)
    assert.throws(() => process.kill(child.pid, 0))
    assert(!secret || !(out + err).includes(secret))
    return z
      .object({ path: z.string(), env: z.record(z.string(), z.string()), reviewed: z.literal(false) })
      .passthrough()
      .parse(JSON.parse(out))
  } finally {
    clearTimeout(timer)
  }
}
async function exported(
  root: string,
  env: Record<string, string>,
  helper: { executable: string; digest: string },
  entry: string,
  output: string,
  password: string,
  directory: string,
  create: boolean,
) {
  const executable = await realpath(process.execPath)
  const source = await launch({
    executable,
    digest: sum(await readFile(executable)),
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    roots: [{ kind: "json", path: root }],
    policy: { version: 1, directories: [root], files: [] },
    helper,
    args: ["run", "--conditions=browser", entry, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    timeout: 60000,
  })
  const out: Buffer[] = [],
    err: Buffer[] = []
  source.child.stdout?.on("data", (bytes: Buffer) => out.push(bytes))
  source.child.stderr?.on("data", (bytes: Buffer) => err.push(bytes))
  try {
    await source.start()
    const end = Date.now() + 45000
    const address = async (): Promise<string> => {
      const url = Buffer.concat(out)
        .toString()
        .match(/kilo server listening on (http:\/\/[^\s]+)/)?.[1]
      if (url) return url
      if (source.child.exitCode !== null || Date.now() > end) throw new Error("Secondary Source startup refused")
      await Bun.sleep(25)
      return address()
    }
    const url = await address()
    if (create) {
      const response = await fetch(`${url}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-kilo-directory": directory },
        body: JSON.stringify({ title: "secondary actual Source session" }),
      })
      assert.equal(response.status, 200)
    }
    const result = await exportSource(source, {
      profile: { database: env.RAYA_DB, storage: path.join(path.dirname(env.RAYA_DB), "storage") },
      output,
      password,
    })
    assert.equal(result.result.status, "exported")
    assert.equal(result.code, 0)
    assert.equal(result.family.familyZeroObserved, true)
    assert.equal((await source.sourceExit).code, 0)
    assert.equal((await source.exit).code, 0)
    const ready = JSON.parse(await readFile(`${source.ticket.control}.source-handoff-ready`, "utf8"))
    const ack = JSON.parse(await readFile(path.join(ready.value.successor.control, "ack.json"), "utf8"))
    const scopes = SourceScopes.parse(ack.value.scopes)
    assert.equal(ack.value.source.pid, source.ticket.header.pid)
    assert.equal(scopes.version, 4)
    for (const pid of [source.ticket.header.pid, source.ticket.header.helper, result.result.receiver.pid]) {
      const end = Date.now() + 2000
      while (Date.now() < end) {
        const alive = (() => {
          try {
            process.kill(pid, 0)
            return true
          } catch (err) {
            if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") return false
            throw err
          }
        })()
        if (!alive) break
        await Bun.sleep(25)
      }
      assert.throws(() => process.kill(pid, 0))
    }
    return {
      bundle: await unseal(await readFile(output, "utf8"), password),
      scopes,
      pids: [source.ticket.header.pid, source.ticket.header.helper, result.result.receiver.pid],
      owners: {
        source: { pid: source.ticket.header.pid, birth: source.ticket.header.birth },
        guardian: { pid: source.ticket.header.helper, birth: source.ticket.header.helperBirth },
        receiver: result.result.receiver,
      },
    }
  } catch (err) {
    if (source.child.exitCode === null) {
      const errors: unknown[] = [err, new Error("Forced secondary fixture cleanup")]
      await source.abort().catch((failure: unknown) => errors.push(failure))
      // eslint-disable-next-line preserve-caught-error -- AggregateError retains the original cause in its third argument.
      throw new AggregateError(errors, "Secondary Source fixture failed", { cause: err })
    }
    throw err
  } finally {
    await writeFile(path.join(root, "source-stdout.log"), Buffer.concat(out))
    await writeFile(path.join(root, "source-stderr.log"), Buffer.concat(err))
  }
}

test.skipIf(process.platform !== "win32")(
  "signed Source graphs preserve distinct secondary data through public inactive import and re-export",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-secondary-source-")))
    await prepare(root)
    const env = environment(root)
    const workspace = path.join(root, "workspace")
    await mkdir(workspace)
    const native = path.join(root, "private-native")
    await mkdir(native)
    const executable = path.join(native, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), executable)
    const helper = { executable, digest: sum(await readFile(executable)) }
    const directories = [path.join(root, "graph-one", "kilo"), path.join(root, "graph-two", "kilo")]
    const memory = MemoryPaths.identity({ ctx: { directory: workspace, worktree: workspace } })
    const archives: z.output<typeof snapshot>[] = []
    for (const [index, directory] of directories.entries()) {
      const dir = path.join(directory, "memory", memory.folder)
      await mkdir(path.join(dir, "sessions"), { recursive: true })
      await mkdir(path.join(directory, "storage"))
      await MemoryFiles.writeManifest(dir, memory)
      await MemoryFiles.writeState(dir, MemorySchema.create())
      for (const name of ["project.md", "environment.md", "corrections.md"])
        await writeFile(path.join(dir, name), `# Graph ${index} café 日本語 😀\n`)
      await writeFile(path.join(dir, "sessions", "actual.md"), `Graph ${index} session café 日本語 😀\n`)
      const archive = snapshot.parse({
        format: "raya.profile-data",
        version: 1,
        id: crypto.randomUUID(),
        createdAt: index + 1,
        schema: "a".repeat(64),
        workspaces: [],
        sql: [],
        json: [],
        review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
      })
      archives.push(archive)
      await writeFile(path.join(directory, "restore-source.json"), JSON.stringify(payload.parse(archive)))
      const repo = path.join(
        directory,
        "snapshot",
        `graph-${index}`,
        createHash("sha1").update(workspace).digest("hex"),
      )
      await mkdir(path.dirname(repo), { recursive: true })
      const child = Bun.spawn(["git", "init", "--bare", repo], {
        env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "absent-git-config") },
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, , stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      assert.equal(code, 0, stderr)
      await writeFile(path.join(repo, "refs", "graph.txt"), `Graph ${index} café 日本語 😀`)
      const seed = Bun.spawn(
        [
          process.execPath,
          "run",
          "--conditions=browser",
          path.join(import.meta.dir, "fixtures/store-content-seed.ts"),
          workspace,
          String(index),
        ],
        {
          cwd: path.resolve(import.meta.dir, "../.."),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
          env: {
            ...env,
            XDG_DATA_HOME: path.dirname(directory),
            RAYA_DB: path.join(directory, "raya.db"),
            KILO_DB: path.join(directory, "raya.db"),
          },
        },
      )
      const [status, stdout, errors] = await Promise.all([
        seed.exited,
        new Response(seed.stdout).text(),
        new Response(seed.stderr).text(),
      ])
      await writeFile(path.join(root, `seed-${index}.log`), stdout + errors)
      assert.equal(status, 0, errors)
      assert.throws(() => process.kill(seed.pid, 0))
    }
    const before = await Promise.all(directories.map((dir) => readFile(path.join(dir, "restore-source.json"))))
    const originals = await Promise.all(
      directories.map(async (dir) => {
        const seed = JSON.parse(await readFile(path.join(dir, "seed-content.json"), "utf8"))
        const files = [
          seed.output,
          path.join(dir, "plans/same.md"),
          path.join(dir, "plans/same.plan.json"),
          path.join(dir, "raya/revert-note/ses_shared.json"),
          path.join(dir, "storage/raya/composer-drafts.json"),
        ]
        return { files, hashes: await Promise.all(files.map(async (file) => sum(await readFile(file)))) }
      }),
    )
    const password = `private-secondary-${crypto.randomUUID()}`
    const output = path.join(os.tmpdir(), `raya-secondary-${crypto.randomUUID()}.raya`)
    const first = await exported(
      root,
      { ...env, RAYA_TEST_SECONDARY_ROOT: root },
      helper,
      path.join(import.meta.dir, "fixtures/source-secondary-entry.ts"),
      output,
      password,
      workspace,
      true,
    )
    assert(first.scopes.version === 4)
    expect(
      first.scopes.globals.filter((item) => directories.some((dir) => identity(item.data) === identity(dir))),
    ).toHaveLength(2)
    expect(first.bundle.secondary?.namespaces).toHaveLength(2)
    const stores = first.bundle.stores?.filter((item) => item.kind === "raya")
    expect(stores).toHaveLength(2)
    for (const [index, data] of directories.entries()) {
      const store = stores!.find((item) => identity(path.dirname(item.source)) === identity(data))!
      assert(store.kind === "raya" && store.content)
      expect(store.content.composers?.entries[0].content?.text).toBe(`Graph ${index} draft café 日本語 😀`)
      expect(store.content.notes.reverts[0].session).toBe("ses_shared")
      expect(store.content.outputs.bindings[0].call).toBe("call_shared")
      expect(store.content.outputs.files[0].classification).toBe("referenced")
      expect(store.content.outputs.files[0].text).toBe(`Graph ${index} output café 日本語 😀\n`.repeat(3000))
      expect(store.content.notes.plans[0].markdown.text).toContain(`Graph ${index}`)
      expect(store.sql.find((table) => table.table === "session_input")!.rows).toHaveLength(0)
    }
    for (const [index, dir] of directories.entries()) {
      const item = first.bundle.secondary!.namespaces.find((item) => identity(item.source.data) === identity(dir))!
      expect(item.memory[0].sources["project.md"]).toBe(`# Graph ${index} café 日本語 😀\n`)
      expect(item.archives).toEqual([archives[index].id])
      expect(
        item.artifacts?.repositories
          .find((repo) => repo.id === item.artifacts?.snapshots[0].repository)
          ?.files.find((file) => file.path === "refs/graph.txt")?.bytes,
      ).toBe(Buffer.from(`Graph ${index} café 日本語 😀`).toString("base64"))
      expect(await readFile(path.join(dir, "restore-source.json"))).toEqual(before[index])
    }
    await writeFile(
      path.join(root, "first-evidence.json"),
      JSON.stringify({
        workspaces: first.bundle.workspaces,
        secondary: first.bundle.secondary,
        archives: first.bundle.archives,
        scopes: first.scopes,
        bundle: first.bundle,
      }),
    )
    const imported = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-secondary-import-")))
    await prepare(imported)
    const mapped = path.join(imported, "mapped-workspace")
    await mkdir(mapped)
    const target = path.join(imported, "destination")
    const mapping = path.join(imported, "mapping.json")
    const mappings: Record<string, string> = {}
    for (const [index, value] of first.bundle.workspaces.entries()) {
      const dir = identity(value) === identity(workspace) ? mapped : path.join(imported, `mapped-${index}`)
      await mkdir(dir, { recursive: true })
      mappings[value] = dir
    }
    await writeFile(mapping, JSON.stringify({ workspaces: mappings }))
    const restored = await command(
      imported,
      environment(imported),
      ["profile-import", output, target, "--mapping", mapping, "--sha256", sum(await readFile(output))],
      password,
    )
    expect(JSON.parse(await readFile(path.join(restored.path, "restore-secondary.json"), "utf8"))).toEqual(
      first.bundle.secondary,
    )
    const independent = JSON.parse(await readFile(path.join(restored.path, "restore-stores.json"), "utf8"))
    expect(independent.stores).toHaveLength(2)
    for (const store of independent.stores) {
      expect(store.content.activation).toBe("held")
      expect(store.content.composers.entries[0].identity.workspace).toBe(mapped)
      expect(
        await Bun.file(path.join(restored.path, "restore-store-content", store.id, "plans", "same.md")).exists(),
      ).toBe(true)
    }
    const second = path.join(os.tmpdir(), `raya-secondary-next-${crypto.randomUUID()}.raya`)
    await mkdir(restored.env.HOME, { recursive: true })
    await mkdir(restored.env.LOCALAPPDATA, { recursive: true })
    const next = await exported(
      imported,
      { ...environment(imported), ...restored.env, RAYA_AUTH_CONTENT: "{}", KILO_AUTH_CONTENT: "{}" },
      helper,
      path.resolve(import.meta.dir, "../../src/kilocode/cli/entry.ts"),
      second,
      password,
      mapped,
      false,
    )
    expect(
      next.bundle.archives.some((item) => JSON.stringify(item.secondary) === JSON.stringify(first.bundle.secondary)),
    ).toBe(true)
    expect(
      next.bundle.archives.some((item) => JSON.stringify(item.stores) === JSON.stringify(first.bundle.stores)),
    ).toBe(true)
    for (const item of originals)
      expect(await Promise.all(item.files.map(async (file) => sum(await readFile(file))))).toEqual(item.hashes)
    expect(next.bundle.archives.filter((item) => archives.some((archive) => archive.id === item.id))).toHaveLength(2)
    await writeFile(
      path.join(root, "receipt.json"),
      JSON.stringify({
        passed: true,
        helper,
        firstPids: first.pids,
        secondPids: next.pids,
        firstOwners: first.owners,
        secondOwners: next.owners,
        duplicateLogicalIdentities: true,
        independentContentScopes: 2,
        writerFilesUnchanged: true,
        seededWithActualWriters: [
          "Core database",
          "Truncate",
          "PlanArtifact",
          "RayaRevertNote",
          "typed legacy composer codec",
        ],
        twoSignedGraphs: true,
        publicSourceImport: true,
        compiled: false,
        secondaryInactive: true,
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
      }),
    )
  },
  180000,
)

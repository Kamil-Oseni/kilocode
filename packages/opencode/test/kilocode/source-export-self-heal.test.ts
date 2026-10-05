import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { unseal } from "../../src/kilocode/migration/profile-bundle"

test("actual Source producer preserves nonempty self-heal journals and required snapshot/Git evidence", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-source-self-heal-")))
  const home = path.join(root, "producer")
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  for (const key of Object.keys(env))
    if (/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|(?:TOKEN|SECRET|API_KEY)$/.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    KILO_TEST_HOME: home,
    LOCALAPPDATA: path.join(home, "local"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    RAYA_DB: path.join(home, "source.db"),
    KILO_DB: path.join(home, "source.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    RAYA_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
  })
  await mkdir(home)
  await mkdir(path.join(home, "local"))
  async function child(args: string[], input?: string, overrides = env) {
    const proc = Bun.spawn([process.execPath, "run", "--conditions=browser", ...args], {
      cwd: home,
      env: overrides,
      stdin: input ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    if (input && proc.stdin) {
      await proc.stdin.write(input)
      await proc.stdin.end()
    }
    const timer = setTimeout(() => proc.kill(), 60000)
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    clearTimeout(timer)
    await writeFile(path.join(root, path.basename(args[0]) + path.basename(args[2] ?? "") + "-stdout.log"), out)
    await writeFile(path.join(root, path.basename(args[0]) + path.basename(args[2] ?? "") + "-stderr.log"), err)
    expect({ root, code, err: err.slice(-1600) }).toMatchObject({ code: 0 })
    assert.throws(() => process.kill(proc.pid, 0))
  }
  for (const mode of ["setup", "writers"])
    await child([path.join(import.meta.dir, "fixtures/profile-self-heal.ts"), root, mode])
  const writer = await Bun.file(path.join(root, "writer-results.json")).json()
  const runs = path.join(writer.data, "raya", "verification", "runs")
  const checkout = (await readdir(runs))[0]
  const extra = "uncaptured-checkout-private.txt"
  await writeFile(path.join(runs, checkout, extra), "Historical checkout extra café 日本語 😀")
  const database = path.join(writer.data, "raya.db")
  await copyFile(path.join(home, "source.db"), database)
  env.RAYA_DB = database
  env.KILO_DB = database
  const native = path.join(root, "native")
  await mkdir(native)
  const helper = path.join(native, "raya-process-host.exe")
  await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  const session = await launch({
    executable: process.execPath,
    digest: hash(await Bun.file(process.execPath).bytes()),
    helper: { executable: helper, digest: hash(await readFile(helper)) },
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    roots: [{ kind: "json", path: root }],
    policy: { version: 1, directories: [root], files: [] },
    args: [
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/index.ts"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    timeout: 60000,
  })
  const stdout: Buffer[] = [],
    stderr: Buffer[] = []
  session.child.stdout?.on("data", (data: Buffer) => stdout.push(data))
  session.child.stderr?.on("data", (data: Buffer) => stderr.push(data))
  const password = `private-self-heal-${crypto.randomUUID()}`
  const output = path.join(os.tmpdir(), `raya-self-heal-source-${crypto.randomUUID()}.raya`)
  const errors: unknown[] = []
  try {
    await session.start()
    const end = Date.now() + 60000
    while (!Buffer.concat(stdout).toString().includes("kilo server listening on")) {
      if (Date.now() > end) throw new Error("Private actual Serve startup deadline")
      await Bun.sleep(25)
    }
    const result = await exportSource(session, {
      profile: { database, storage: path.join(writer.data, "storage") },
      password,
      output,
    })
    expect(result.result.status).toBe("exported")
    expect(result.code).toBe(0)
    expect((await session.sourceExit).code).toBe(0)
    expect((await session.exit).code).toBe(0)
    expect(result.family.familyZeroObserved).toBe(true)
    const value = await unseal(await Bun.file(output).text(), password)
    expect(value.selfHeal?.records.some((record) => record.path.startsWith("repair/"))).toBe(true)
    expect(
      value.selfHeal?.records.some(
        (record) => record.path.startsWith("verification/") && record.path.endsWith("result.json"),
      ),
    ).toBe(true)
    expect(value.selfHeal?.files.some((file) => file.kind === "snapshot-blob")).toBe(true)
    expect(value.selfHeal?.files.some((file) => file.kind === "snapshot-manifest")).toBe(true)
    expect(value.artifacts?.worktrees.length).toBeGreaterThan(0)
    expect(JSON.stringify(value.selfHeal)).not.toContain(writer.token)
    expect(JSON.stringify(value.selfHeal)).not.toContain(writer.owner)
    expect(value.artifacts?.worktrees.some((tree) => tree.files.some((file) => file.path === extra))).toBe(false)
    expect(value.selfHeal?.files.some((file) => file.original.endsWith(extra))).toBe(false)
    expect(value.selfHeal?.checkouts?.some((row) => row.files.some((file) => file.path === extra))).toBe(true)
    const checkout = value.selfHeal?.checkouts?.find((row) => row.original === writer.checkout)
    expect(checkout?.changes.some((row) => row.path === "proof.txt" && row.status === "modified")).toBe(true)
    expect(
      checkout?.changes.some((row) => row.path === "packages/kilo-vscode/package.json" && row.status === "missing"),
    ).toBe(true)
    expect(result.result.completeProfileCoverage).toBe(false)
    const destination = path.join(root, "restore")
    await mkdir(destination)
    await child(
      [path.join(import.meta.dir, "fixtures/source-export-self-heal.ts"), output, destination],
      JSON.stringify({ password }),
      {
        ...env,
        HOME: destination,
        USERPROFILE: destination,
        KILO_TEST_HOME: destination,
        LOCALAPPDATA: path.join(destination, "local"),
        XDG_DATA_HOME: path.join(destination, "data"),
        XDG_CONFIG_HOME: path.join(destination, "config"),
        XDG_STATE_HOME: path.join(destination, "state"),
        XDG_CACHE_HOME: path.join(destination, "cache"),
        RAYA_DB: path.join(destination, "unused.db"),
        KILO_DB: path.join(destination, "unused.db"),
      },
    )
    for (const pid of [session.ticket.header.pid, session.ticket.header.helper, result.result.receiver.pid])
      assert.throws(() => process.kill(pid, 0))
    await writeFile(
      path.join(root, "receipt.json"),
      JSON.stringify({
        passed: true,
        records: value.selfHeal?.records.length,
        files: value.selfHeal?.files.length,
        workspaces: value.workspaces,
        familyZeroObserved: true,
        completeProfileCoverage: false,
        verificationCheckoutBytesCovered: true,
      }),
    )
  } catch (err) {
    errors.push(err)
  } finally {
    await writeFile(path.join(root, "serve-stdout.log"), Buffer.concat(stdout))
    await writeFile(path.join(root, "serve-stderr.log"), Buffer.concat(stderr))
    if (errors.length && session.child.exitCode === null) await session.abort().catch((err) => errors.push(err))
  }
  if (errors.length) throw new AggregateError(errors, `Private Source self-heal failed; retained ${root}`)
}, 180000)

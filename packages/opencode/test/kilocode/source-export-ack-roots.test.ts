import assert from "node:assert/strict"
import { test } from "bun:test"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { validateObservation } from "@opencode-ai/core/kilocode/profile-observation"
import { observe } from "@opencode-ai/core/kilocode/source-observer"
import { unseal } from "../../src/kilocode/migration/profile-bundle"

test.skipIf(process.platform !== "win32")(
  "actual signed external JSON owner must not disappear from selected Source export",
  async () => {
    const helper =
      process.env.RAYA_TEST_DIRECTORY_HELPER ??
      path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe")
    const expected =
      process.env.RAYA_TEST_ACK_HELPER_SHA ??
      createHash("sha256")
        .update(await readFile(helper))
        .digest("hex")
    assert(helper && path.isAbsolute(helper) && expected, "Explicit accepted helper and digest required")
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    assert.equal(hash(await readFile(helper)), expected)
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-ack-external-"))
    const profile = path.join(root, "profile"),
      external = path.join(root, "external-index")
    const data = path.join(profile, "data", "kilo"),
      storage = path.join(data, "storage")
    for (const dir of [
      storage,
      external,
      path.join(profile, "home"),
      path.join(profile, "local"),
      path.join(profile, "workspace"),
      path.join(profile, "config", "kilo"),
    ])
      await mkdir(dir, { recursive: true })
    const copied = path.join(root, "raya-process-host.exe")
    await copyFile(helper, copied)
    assert.equal(hash(await readFile(copied)), expected)
    await writeFile(
      path.join(profile, "config", "kilo", "kilo.json"),
      JSON.stringify({ enabled_providers: [], permission: "deny", formatter: false, lsp: false }),
    )
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL/.test(entry[0]),
      ),
    )
    Object.assign(env, {
      HOME: path.join(profile, "home"),
      USERPROFILE: path.join(profile, "home"),
      KILO_TEST_HOME: path.join(profile, "home"),
      LOCALAPPDATA: path.join(profile, "local"),
      XDG_DATA_HOME: path.join(profile, "data"),
      XDG_CONFIG_HOME: path.join(profile, "config"),
      XDG_CACHE_HOME: path.join(profile, "cache"),
      XDG_STATE_HOME: path.join(profile, "state"),
      RAYA_DB: path.join(data, "raya.db"),
      KILO_DB: path.join(data, "raya.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      RAYA_TEST_ACK_EXTERNAL: external,
    })
    const source = await launch({
      executable: process.execPath,
      digest: hash(await readFile(process.execPath)),
      helper: { executable: copied, digest: expected },
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      roots: [{ kind: "json", path: data }],
      policy: { version: 1, directories: [profile, external].sort(), files: [] },
      args: [
        "run",
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/source-export-ack-roots.ts"),
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ],
      timeout: 60000,
    })
    const out: Buffer[] = [],
      err: Buffer[] = []
    source.child.stdout?.on("data", (bytes) => out.push(bytes))
    source.child.stderr?.on("data", (bytes) => err.push(bytes))
    const watchers = [
      observe({
        pid: source.ticket.header.pid,
        birth: source.ticket.header.birth,
        executable: process.execPath,
        timeout: 60000,
      }),
      observe({
        pid: source.ticket.header.helper,
        birth: source.ticket.header.helperBirth,
        executable: copied,
        timeout: 60000,
      }),
    ]
    const report: Record<string, unknown> = {
      root,
      external,
      helperSHA: expected,
      source: source.ticket.header.pid,
      birth: source.ticket.header.birth,
      scope:
        "Source fixture with actual process-profile registration and file writer, not shipped index writer or compiled acceptance",
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
    }
    const output = path.join(root, "capture.raya"),
      password = `private-${randomUUID()}`
    try {
      await Promise.all(watchers.map((watcher) => watcher.ready))
      await source.start()
      const deadline = Date.now() + 45000
      let url: string | undefined
      while (!url && Date.now() < deadline) {
        url = Buffer.concat(out)
          .toString()
          .match(/listening on (http:\/\/[^\s]+)/)?.[1]
        if (!url) await Bun.sleep(25)
      }
      assert(url, "Actual listener required")
      const response = await fetch(`${url}/config?directory=${encodeURIComponent(path.join(profile, "workspace"))}`, {
        signal: AbortSignal.timeout(15000),
      })
      assert.equal(response.status, 200)
      const value = await exportSource(source, { profile: { database: env.RAYA_DB, storage }, password, output })
      report.outcome = value.result
      report.family = {
        familyZeroObserved: value.family.familyZeroObserved,
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
      }
      report.receiverCode = value.code
      const ready = await Bun.file(`${source.ticket.control}.source-handoff-ready`).json()
      const raw = await readFile(path.join(ready.value.successor.control, "ack.json")),
        ack = JSON.parse(raw.toString())
      assert.equal(
        ready.signature,
        createHmac("sha256", source.ticket.token).update(JSON.stringify(ready.value)).digest("hex"),
      )
      assert.match(ack.digest, /^[a-f0-9]{64}$/)
      assert.equal(ready.value.successor.controller, value.result.receiver.pid)
      assert.equal(ready.value.successor.birth, value.result.receiver.birth)
      const refusal = await Bun.file(path.join(ready.value.successor.control, "result.json")).json()
      assert(
        refusal.failure.errors.some((item: { code?: string }) => item.code === "RAYA_SOURCE_STATE_SCOPE_UNCOVERED"),
      )
      report.failureCode = "RAYA_SOURCE_STATE_SCOPE_UNCOVERED"
      assert.equal(ack.value.source.pid, source.ticket.header.pid)
      assert.equal(ack.value.source.birth, source.ticket.header.birth)
      const roots = (await validateObservation(ack.value.roots)).roots
      assert(
        roots.some((item) => item.kind === "json" && path.resolve(item.path).toLowerCase() === external.toLowerCase()),
        "Actual signed ACK must include external directory",
      )
      report.ack = {
        file: path.join(ready.value.successor.control, "ack.json"),
        sha: hash(raw),
        externalAcknowledged: true,
      }
      report.codes = await Promise.all(watchers.map((watcher) => watcher.done))
      assert.deepEqual(report.codes, [0, 0])
      assert(value.family.familyZeroObserved)
      const owners = [
        { pid: source.ticket.header.pid, birth: source.ticket.header.birth },
        { pid: source.ticket.header.helper, birth: source.ticket.header.helperBirth },
        { pid: value.result.receiver.pid, birth: value.result.receiver.birth },
      ]
      const absent = await promisify(execFile)("powershell.exe", [
        "-NoProfile",
        "-Command",
        `$ids=@(${owners.map((item) => item.pid).join(",")}); @(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId }).Count`,
      ])
      assert.equal(absent.stdout.trim(), "0")
      report.owners = owners
      report.originalPIDsAbsent = true
      report.auxiliaryBirthNotRetained = true
      if (value.result.status === "exported") {
        const bundle = await unseal(await Bun.file(output).text(), password)
        report.externalSelected =
          bundle.disposition?.roots.some((item) => path.resolve(item.path).toLowerCase() === external.toLowerCase()) ??
          false
        report.externalMarkerCaptured =
          bundle.disposition?.files.some(
            (item) => path.resolve(item.path).toLowerCase() === path.join(external, "actual-index.json").toLowerCase(),
          ) ?? false
      }
      await writeFile(path.join(root, "receipt.json"), JSON.stringify(report, null, 2))
      assert.equal(
        value.result.status,
        "refused",
        "Unsupported acknowledged external root must refuse before publication",
      )
      assert.equal(await Bun.file(output).exists(), false)
      assert.equal(
        (await readdir(root)).some((file) => file.includes(".raya-export")),
        false,
      )
    } finally {
      await writeFile(path.join(root, "stdout.log"), Buffer.concat(out))
      await writeFile(path.join(root, "stderr.log"), Buffer.concat(err))
      if (source.child.exitCode === null) {
        report.forcedCleanup = true
        await source.abort()
      }
      await Promise.all(watchers.map((watcher) => watcher.close()))
      await writeFile(path.join(root, "receipt.json"), JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ root, receipt: path.join(root, "receipt.json") }))
    }
  },
  180000,
)

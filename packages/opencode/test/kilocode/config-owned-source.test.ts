import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { LineageIntent } from "@opencode-ai/core/kilocode/config-intent-schema"
import { unseal } from "../../src/kilocode/migration/profile-bundle"

test.skipIf(process.platform !== "win32")(
  "actual Source encrypts verified current config and original owned-write history",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-config-owned-source-"))
    for (const dir of ["home", "home/local", "state", "data/kilo/storage", "config/kilo", "cache", "workspace"])
      await mkdir(path.join(root, dir), { recursive: true })
    const file = path.join(root, "config/kilo/kilo.json")
    await writeFile(
      file,
      JSON.stringify({ enabled_providers: [], permission: "deny", formatter: false, lsp: false }, null, 2),
    )
    const unsupported = path.join(root, "config/kilo/unloaded-plugin-intent.json")
    const content = '{"privatePluginPreference":"nonempty-unaccounted-café-日本語"}'
    await writeFile(unsupported, content)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !/^(RAYA|KILO|OPENCODE|OTEL)_/.test(entry[0]) &&
          !/(TOKEN|SECRET|API_KEY)$/.test(entry[0]),
      ),
    )
    const database = path.join(root, "data/kilo/raya.db")
    Object.assign(env, {
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      LOCALAPPDATA: path.join(root, "home/local"),
      KILO_TEST_HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      RAYA_DB: database,
      KILO_DB: database,
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_DEFAULT_PLUGINS: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
    })
    const executable = path.join(root, "raya-process-host.exe")
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), executable)
    const digest = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex")
    const session = await launch({
      executable: process.execPath,
      digest: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
      helper: { executable, digest },
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
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    session.child.stdout?.on("data", (bytes: Buffer) => stdout.push(bytes))
    session.child.stderr?.on("data", (bytes: Buffer) => stderr.push(bytes))
    const password = `private-config-${randomUUID()}`
    const output = path.join(os.tmpdir(), `raya-config-current-${randomUUID()}.raya`)
    const state = { forced: false }
    try {
      await session.start()
      const end = Date.now() + 60000
      let url: string | undefined
      while (
        !(url = Buffer.concat(stdout)
          .toString()
          .match(/kilo server listening on (http:\/\/[^\s]+)/)?.[1])
      ) {
        if (Date.now() > end) throw new Error("Actual config Source startup deadline")
        await Bun.sleep(25)
      }
      const directory = path.join(root, "workspace")
      const headers = { "content-type": "application/json", "x-kilo-directory": directory }
      expect(
        (
          await fetch(`${url}/session`, {
            method: "POST",
            headers,
            body: JSON.stringify({ title: "config-current-no-replay" }),
          })
        ).status,
      ).toBe(200)
      const get = () => fetch(`${url}/config?directory=${encodeURIComponent(directory)}`, { headers })
      expect((await get()).status).toBe(200)
      const original = await readFile(file, "utf8")
      expect(
        (
          await fetch(`${url}/global/config`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ permission: { "*": "deny" }, model: "synthetic/current" }),
          })
        ).status,
      ).toBe(200)
      expect((await get()).status).toBe(200)
      const current = await readFile(file, "utf8")
      const result = await exportSource(session, {
        profile: { database, data: path.join(root, "data/kilo"), storage: path.join(root, "data/kilo/storage") },
        password,
        output,
      })
      expect(result.result.status).toBe("exported")
      expect(result.code).toBe(0)
      expect((await session.sourceExit).code).toBe(0)
      expect((await session.exit).code).toBe(0)
      expect(result.family.familyZeroObserved).toBe(true)
      const bundle = await unseal(await readFile(output, "utf8"), password)
      expect(bundle.config?.version).toBe(3)
      const docs = bundle.config!.graphs.flatMap((graph) =>
        LineageIntent.parse(graph).documents.filter((doc) => doc.path === file),
      )
      expect(docs.length).toBeGreaterThanOrEqual(2)
      expect(
        docs.every(
          (doc) =>
            doc.digest === createHash("sha256").update(current).digest("hex") && doc.safe.model === "synthetic/current",
        ),
      ).toBe(true)
      expect(
        docs.some((doc) =>
          doc.history?.some((old) => old.digest === createHash("sha256").update(original).digest("hex")),
        ),
      ).toBe(true)
      expect(bundle.config!.activation).toBe("held")
      expect(bundle.config!.completeProfileCoverage).toBe(false)
      expect(bundle.disposition!.files.filter((entry) => entry.disposition.kind === "config-semantic")).toHaveLength(1)
      expect(bundle.disposition!.incomplete).toContain("unclassified-files")
      const unknown = bundle.disposition!.files.find((entry) => entry.path.toLowerCase() === unsupported.toLowerCase())
      expect(unknown).toMatchObject({
        bytes: Buffer.byteLength(content),
        digest: createHash("sha256").update(content).digest("hex"),
        disposition: { kind: "unclassified", reason: "no-component-binding" },
      })
      for (const pid of [session.ticket.header.pid, session.ticket.header.helper, result.result.receiver.pid])
        expect(() => process.kill(pid, 0)).toThrow()
      await writeFile(
        path.join(root, "receipt.json"),
        JSON.stringify({
          passed: true,
          source: session.ticket.header.pid,
          guardian: session.ticket.header.helper,
          receiver: result.result.receiver.pid,
          codes: [0, 0, 0],
          forced: false,
          configVersion: 3,
          currentDigest: createHash("sha256").update(current).digest("hex"),
          originalDigest: createHash("sha256").update(original).digest("hex"),
          activeConfigPublished: false,
          completeProfileCoverage: false,
          portableCaptureAuthorized: false,
        }),
      )
    } finally {
      await Promise.all([
        writeFile(path.join(root, "stdout.log"), Buffer.concat(stdout).toString().replaceAll(password, "[redacted]")),
        writeFile(path.join(root, "stderr.log"), Buffer.concat(stderr).toString().replaceAll(password, "[redacted]")),
      ])
      if (session.child.exitCode === null) {
        state.forced = true
        await session.abort()
      }
      assert.equal(state.forced, false, `Retained config Source ${root}`)
    }
  },
  120000,
)

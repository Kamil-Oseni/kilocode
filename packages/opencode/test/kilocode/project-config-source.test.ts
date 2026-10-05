import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import z from "zod"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { exportSource } from "@opencode-ai/core/kilocode/source-export"
import { LineageIntent } from "@opencode-ai/core/kilocode/config-intent-schema"
import { unseal } from "../../src/kilocode/migration/profile-bundle"

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
for (const suffix of ["json", "jsonc"])
  test.skipIf(process.platform !== "win32")(
    `actual project ${suffix} update preserves authenticated Source lineage`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `raya-project-config-${suffix}-`))
      for (const dir of ["home/local", "state", "data/kilo/storage", "config/kilo", "cache", "workspace/.kilo"])
        await mkdir(path.join(root, dir), { recursive: true })
      await writeFile(
        path.join(root, "config/kilo/kilo.json"),
        JSON.stringify({
          $schema: "https://app.kilo.ai/config.json",
          enabled_providers: [],
          permission: "deny",
          formatter: false,
          lsp: false,
        }),
      )
      const file = path.join(root, "workspace/.kilo", `kilo.${suffix}`)
      const before = `${suffix === "jsonc" ? "// preserve café 日本語\n" : ""}${JSON.stringify({ $schema: "https://app.kilo.ai/config.json", model: "synthetic/before" }, null, 2)}`
      await writeFile(file, before)
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            !/^(RAYA|KILO|OPENCODE|OTEL)_/.test(entry[0]) &&
            !/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(entry[0]),
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
        KILO_DISABLE_MODELS_FETCH: "1",
        RAYA_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_DEFAULT_PLUGINS: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
      })
      const executable = path.join(root, "raya-process-host.exe")
      const helper =
        process.env.RAYA_PROJECT_CONFIG_HELPER ??
        path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe")
      await copyFile(helper, executable)
      const session = await launch({
        executable: process.execPath,
        digest: hash(await readFile(process.execPath)),
        helper: { executable, digest: hash(await readFile(executable)) },
        cwd: path.resolve(import.meta.dir, "../.."),
        env,
        roots: [{ kind: "json", path: path.join(root, "data/kilo") }],
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
      const password = `private-project-${randomUUID()}`
      const output = path.join(os.tmpdir(), `raya-project-source-${randomUUID()}.raya`)
      const evidence: { stage: string; [key: string]: unknown }[] = []
      let forced = false
      try {
        await session.start()
        const deadline = Date.now() + 60000
        let url: string | undefined
        while (
          !(url = Buffer.concat(stdout)
            .toString()
            .match(/kilo server listening on (http:\/\/[^\s]+)/)?.[1])
        ) {
          if (Date.now() > deadline) throw new Error("Project config Source startup deadline")
          await Bun.sleep(25)
        }
        const directory = path.join(root, "workspace")
        const headers = { "content-type": "application/json", "x-kilo-directory": directory }
        expect(
          (
            await fetch(`${url}/session`, {
              method: "POST",
              headers,
              body: JSON.stringify({ title: "project-config-no-model" }),
            })
          ).status,
        ).toBe(200)
        const get = () => fetch(`${url}/config?directory=${encodeURIComponent(directory)}`, { headers })
        expect((await get()).status).toBe(200)
        const response = await fetch(`${url}/config?directory=${encodeURIComponent(directory)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ model: "synthetic/after" }),
        })
        evidence.push({ stage: "actual-project-patch", code: response.status })
        expect(response.status).toBe(200)
        expect((await get()).status).toBe(200)
        const current = await readFile(file, "utf8")
        if (suffix === "jsonc") expect(current.startsWith("// preserve café 日本語\n")).toBe(true)
        const result = await exportSource(session, {
          profile: { database, data: path.join(root, "data/kilo"), storage: path.join(root, "data/kilo/storage") },
          password,
          output,
        })
        const ready = z
          .object({ value: z.object({ successor: z.object({ control: z.string() }) }) })
          .parse(JSON.parse(await readFile(`${session.ticket.control}.source-handoff-ready`, "utf8")))
        const ack = z
          .object({ value: z.object({ scopes: z.unknown().optional() }) })
          .parse(JSON.parse(await readFile(path.join(ready.value.successor.control, "ack.json"), "utf8")))
        const receiver = z
          .object({ status: z.string(), failure: z.unknown().optional() })
          .parse(JSON.parse(await readFile(path.join(ready.value.successor.control, "result.json"), "utf8")))
        evidence.push({
          stage: "actual-source-export",
          status: result.result.status,
          code: result.code,
          source: (await session.sourceExit).code,
          guardian: (await session.exit).code,
          familyZero: result.family.familyZeroObserved,
          ackScopesPresent: !!ack.value.scopes,
          receiverStatus: receiver.status,
          failure: receiver.failure,
          originalSHA: hash(before),
          currentSHA: hash(current),
        })
        expect(result.result.status, root).toBe("exported")
        expect(result.code).toBe(0)
        expect((await session.sourceExit).code).toBe(0)
        expect((await session.exit).code).toBe(0)
        expect(receiver.status).toBe("observed")
        expect(receiver.failure).toBeUndefined()
        expect(result.family.familyZeroObserved).toBe(true)
        const bundle = await unseal(await readFile(output, "utf8"), password)
        const docs =
          bundle.config?.graphs.flatMap((graph) =>
            LineageIntent.parse(graph).documents.filter((doc) => doc.path === file),
          ) ?? []
        expect(docs.length).toBeGreaterThan(0)
        expect(docs.every((doc) => doc.digest === hash(current) && doc.safe.model === "synthetic/after")).toBe(true)
        expect(docs.some((doc) => doc.history?.some((old) => old.digest === hash(before)))).toBe(true)
        expect(bundle.config?.activation).toBe("held")
        expect(bundle.config?.completeProfileCoverage).toBe(false)
        evidence.push({
          stage: "verified-lineage",
          originalSHA: hash(before),
          currentSHA: hash(current),
          documents: docs.length,
        })
      } finally {
        if (session.child.exitCode === null) {
          forced = true
          await session.abort()
        }
        await Promise.all([
          writeFile(path.join(root, "stdout.log"), Buffer.concat(stdout).toString().replaceAll(password, "[redacted]")),
          writeFile(path.join(root, "stderr.log"), Buffer.concat(stderr).toString().replaceAll(password, "[redacted]")),
          writeFile(
            path.join(root, "receipt.json"),
            JSON.stringify({
              root,
              suffix,
              sourceQualified: true,
              helperSHA: hash(await readFile(executable)),
              forced,
              output,
              evidence,
            }),
          ),
        ])
        expect(forced, root).toBe(false)
      }
    },
    120000,
  )

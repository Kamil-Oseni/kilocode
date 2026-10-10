import { expect, test } from "bun:test"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { start } from "../../src/services/cli-backend/managed-source"
import { correlated } from "../../src/profile/correlation"
import { archive } from "../../src/profile/archive"
import { environment } from "../fixtures/profile-source-env"
import { drain } from "../fixtures/profile-source-streams"

test.skipIf(process.platform !== "win32")(
  "actual archive admission refuses changed metadata, stale clients, private bounds, destination conflicts and retired native owners before capture",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-archive-admission-"))
    const executable = path.join(root, "bun.exe")
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(process.execPath, executable)
    await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
    await writeFile(
      path.join(root, "raya-process-host.json"),
      JSON.stringify({
        version: 1,
        exe: createHash("sha256")
          .update(await readFile(helper))
          .digest("hex"),
      }),
    )
    const source = await start({
      executable,
      helper,
      cwd: root,
      args: ["-e", "await Bun.sleep(8000); process.exit(0)"],
      env: await environment(root),
    })
    const readers = Promise.all([drain(source.session.child.stdout), drain(source.session.child.stderr)])
    let failure: unknown
    const ticket = source.session.ticket.header
    const review = {
      format: "raya.source-export-selection" as const,
      version: 1 as const,
      source: { pid: ticket.pid, birth: ticket.birth, executable: ticket.executable, digest: ticket.digest },
      profile: {
        database: path.join(root, "selected.db"),
        storage: path.join(root, "data", "kilo", "storage"),
        data: path.join(root, "data", "kilo"),
      },
      fingerprint: "a".repeat(64),
      preferences: "authenticated-capture-only" as const,
      completeProfileCoverage: false as const,
      portableCaptureAuthorized: false as const,
      restartRequired: true as const,
    }
    let selected: unknown = review
    let current = true
    let captured = 0
    let accepted = 0
    const requests: { url: string; method: string }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/global/source-export-selection")
        requests.push({ url: request.url, method: request.method })
        return Response.json(selected)
      },
    })
    const client = createKiloClient({ baseUrl: server.url.href })
    const connection: Parameters<typeof archive>[0] = {
      getClient: () => client,
      isClientCurrent: (value) => current && value === client,
      matchesSource: (value) => correlated(source, value),
      exportProfile: async () => {
        captured++
        throw new Error("Fixture must never request capture")
      },
    }
    const output = path.join(root, "partial.raya")
    const password = "private fixture archive password"
    const admit = () => {
      accepted++
    }
    try {
      await source.session.start()
      selected = { ...review, fingerprint: "b".repeat(64) }
      await expect(archive(connection, review, password, output, admit)).rejects.toThrow("selection changed")
      selected = { ...review, source: { ...review.source, birth: "1" } }
      await expect(archive(connection, review, password, output, admit)).rejects.toThrow("selection changed")
      selected = review
      current = false
      await expect(archive(connection, review, password, output, admit)).rejects.toThrow("selection changed")
      current = true
      const count = requests.length
      for (const invalid of ["short", "p".repeat(11), "p".repeat(1025), "😀".repeat(300)]) {
        await expect(archive(connection, review, invalid, output, admit)).rejects.toThrow("12–1024 UTF-8 bytes")
        expect(requests).toHaveLength(count)
        expect(accepted).toBe(0)
        expect(captured).toBe(0)
      }
      const large = { ...review, profile: { ...review.profile, database: path.join(root, "x".repeat(3500)) } }
      selected = large
      await expect(archive(connection, large, "p".repeat(1024), output, admit)).rejects.toThrow("private channel bound")
      selected = review
      await writeFile(output, "existing archive must remain untouched")
      await expect(archive(connection, review, password, output, admit)).rejects.toThrow("destination already exists")
      expect(await readFile(output, "utf8")).toBe("existing archive must remain untouched")
      await rm(output)
      expect((await source.session.sourceExit).code).toBe(0)
      await source.session.exit
      expect((await readers).every((value) => value.EOF && value.joined)).toBe(true)
      await expect(archive(connection, review, password, output, admit)).rejects.toThrow("selection changed")
      expect(captured).toBe(0)
      expect(accepted).toBe(0)
      expect(requests.every((value) => value.method === "GET" && !value.url.includes(password))).toBe(true)
      expect(await Bun.file(output).exists()).toBe(false)
    } catch (err) {
      failure = err
    } finally {
      const outcomes = await Promise.allSettled([server.stop(true), source.session.sourceExit, source.session.exit])
      const streams = await readers
      const errors = outcomes.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
      if (!streams.every((value) => value.EOF && value.joined))
        errors.push(new Error("Original source streams did not reach EOF"))
      if (failure !== undefined || errors.length) {
        const diagnostic = {
          root,
          original: failure instanceof Error ? failure.name : failure === undefined ? undefined : "unknown",
          outcomes: outcomes.map((value) =>
            value.status === "fulfilled"
              ? { status: value.status, exit: value.value }
              : { status: value.status, error: value.reason instanceof Error ? value.reason.name : "unknown" },
          ),
          streams: streams.map((value) => ({
            ...value,
            tail: value.tail.replaceAll("private fixture archive password", "[redacted]"),
          })),
          force: false,
        }
        await writeFile(path.join(root, "source-retirement-failure.json"), JSON.stringify(diagnostic)).catch((err) =>
          errors.push(err),
        )
        console.error("SOURCE_RETIREMENT_DIAGNOSTIC", root)
        throw new AggregateError(
          [...(failure === undefined ? [] : [failure]), ...errors],
          "Original source fixture failed; diagnostics retained",
        )
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

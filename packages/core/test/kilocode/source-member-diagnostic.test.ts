import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { finished } from "node:stream/promises"
import { launch } from "../../src/kilocode/source-launch"

const digest = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")

for (const mixed of [false, true])
  for (const enabled of [true, false]) {
    test(`original children publish bounded diagnostic enabled=${enabled} mixed=${mixed}`, async () => {
      const helper = process.env.RAYA_MEMBER_DIAGNOSTIC_HELPER
      if (process.platform !== "win32" || !helper) throw new Error("Reviewed Windows diagnostic helper required")
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-member-diagnostic-"))
      const profile = path.join(root, "profile")
      await mkdir(profile)
      const file = path.join(root, "source.ts")
      await Bun.write(
        file,
        `
if (process.argv[2] === "child") {
  await Bun.sleep(150)
  process.exit(Number(process.argv[3]))
} else {
  for (const code of ${JSON.stringify([0, 1, 128])} ${mixed ? "" : ".flatMap(() => [0, 0, 0, 0])"}) {
    const child = Bun.spawn([process.execPath, import.meta.path, "child", String(code)], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
    if (await child.exited !== code) throw new Error("Controlled original child failed")
  }
}
`,
      )
      const app = await launch({
        executable: process.execPath,
        digest: await digest(process.execPath),
        helper: { executable: helper, digest: await digest(helper) },
        cwd: root,
        args: [file],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
          ),
          RAYA_SOURCE_MEMBER_DIAGNOSTICS: enabled ? "1" : "0",
        },
        roots: [{ kind: "json", path: profile }],
        policy: { version: 1, directories: [root], files: [] },
      })
      const streams = Promise.allSettled(
        [app.child.stdout, app.child.stderr].map((stream) => {
          if (!stream) return Promise.reject(new Error("Original diagnostic stream missing"))
          const joined = finished(stream)
          stream.resume()
          return joined
        }),
      )
      const state = { joined: false }
      const failures: unknown[] = []
      try {
        await app.start()
        const closed = await Promise.allSettled([app.sourceExit, app.exit])
        state.joined = true
        const rejected = closed.flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
        if (rejected.length) throw new AggregateError(rejected, "Original diagnostic process join failed")
        expect((await streams).every((row) => row.status === "fulfilled")).toBe(true)
        expect(closed.every((row) => row.status === "fulfilled" && row.value.code === 0)).toBe(true)
        const family = await Bun.file(app.ticket.control + ".source-family-retired").json()
        expect(family.success).toBe(true)
        expect(family.forced).toBe(false)
        expect(family.memberObservationsOverflow).toBe(false)
        const count = mixed ? 3 : 12
        expect(family.totalProcesses).toBe(count * 2 + 1)
        expect(family.memberObservationsComplete).toBe(true)
        expect(family.rootExit).toBe(0)
        expect(family.members).toHaveLength(count * 2 + 1)
        expect(new Set(family.members.map((row: { pid: number }) => row.pid)).size).toBe(count * 2 + 1)
        expect(family.members.every((row: { code: number }) => row.code === 0)).toBe(!mixed)
        if (mixed)
          for (const code of [1, 128])
            expect(family.members.some((row: { code: number }) => row.code === code)).toBe(true)
        const diagnostic = Bun.file(app.ticket.control + ".source-members-diagnostic")
        expect(await diagnostic.exists()).toBe(enabled)
        if (enabled) {
          const data = await diagnostic.json()
          const image = path.basename(process.execPath).toLowerCase()
          const order = (a: (string | number)[], b: (string | number)[]) => String(a).localeCompare(String(b))
          expect(data.memberDropped).toBe(0)
          expect(data.memberConflicts).toBe(0)
          expect(data.members).toHaveLength(family.totalProcesses)
          expect(new Set(data.members.map((row: { pid: number; birth: string }) => `${row.pid}:${row.birth}`)).size).toBe(family.totalProcesses)
          for (const member of family.members) {
            const row = data.members.find((value: { pid: number; birth: string }) => value.pid === member.pid && value.birth === member.birth)
            expect(row).toBeDefined()
            expect(row.code).toBe(member.code)
            expect(row.image).toMatch(/^[a-z0-9._-]{1,128}$/)
            expect(row.parentImage).toMatch(/^[a-z0-9._-]{1,128}$/)
            if (row.parentBirth !== null) {
              expect(family.members.some((parent: { pid: number; birth: string }) => parent.pid === row.parentPID && parent.birth === row.parentBirth)).toBe(true)
              expect(BigInt(row.parentBirth)).toBeLessThanOrEqual(BigInt(row.birth))
            }
          }
          expect(data.diagnosticOnly).toBe(true)
          expect(data.retirementAuthority).toBe(false)
          expect(data.failed).toBe(false)
          expect(data.dropped).toBe(0)
          expect(data.observations).toBe(count * 2 + 1)
          expect(data.exitObserved).toBe(count * 2 + 1)
          expect(data.exitUnavailable).toBe(0)
          expect(data.exitDropped).toBe(0)
          expect(data.unavailable).toBe(1)
          expect(data.groups.length).toBeLessThanOrEqual(128)
          expect(
            data.groups
              .map((row: { image: string; parentImage: string; observations: number }) => [
                row.image,
                row.parentImage,
                row.observations,
              ])
              .sort(order),
          ).toEqual(
            [
              [image, image, count],
              [image, "unknown", 1],
              ["conhost.exe", image, count],
            ].sort(order),
          )
          const children = data.groups.find(
            (row: { image: string; parentImage: string }) => row.image === image && row.parentImage === image,
          )
          expect(children.exits).toEqual(
            mixed
              ? [
                  { code: 0, count: 1 },
                  { code: 1, count: 1 },
                  { code: 128, count: 1 },
                ]
              : [{ code: 0, count: 12 }],
          )
          expect(
            data.groups.reduce(
              (total: number, row: { exits: { count: number }[] }) =>
                total + row.exits.reduce((sum, exit) => sum + exit.count, 0),
              0,
            ),
          ).toBe(count * 2 + 1)
          expect(
            data.groups.every(
              (row: { image: string; parentImage: string }) =>
                /^[a-z0-9._-]+$/.test(row.image) && /^[a-z0-9._-]+$/.test(row.parentImage),
            ),
          ).toBe(true)
          expect((await diagnostic.text()).includes(root)).toBe(false)
          expect(diagnostic.size).toBeLessThan(65536)
        }
      } catch (err) {
        failures.push(err)
      } finally {
        if (!state.joined) {
          // Forced retirement of this failed fixture never becomes successful ordinary acceptance.
          const aborted = await Promise.allSettled([app.abort()])
          for (const row of aborted) if (row.status === "rejected") failures.push(row.reason)
        }
        const joined = await Promise.allSettled([app.sourceExit, app.exit, streams])
        for (const row of joined) {
          if (row.status === "rejected") failures.push(row.reason)
          if (row.status === "fulfilled" && Array.isArray(row.value))
            for (const stream of row.value) if (stream.status === "rejected") failures.push(stream.reason)
        }
      }
      if (failures.length) throw new AggregateError(failures, "Diagnostic fixture failed; original cleanup retained")
      await rm(root, { recursive: true, force: true })
    }, 30000)
  }

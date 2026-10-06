import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { launch } from "../../src/kilocode/source-launch"

const digest = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")

for (const capture of [false, true])
  for (const mode of ["sequential", "parallel", "large", "overflow"])
    test.skipIf(process.platform !== "win32" || process.env.RAYA_MEMBER_COVERAGE_TESTS !== "1")(
      `zero-delay ${mode} ${capture ? "capture" : "normal"} retains every original native birth and exit`,
      async () => {
        const helper = process.env.RAYA_MEMBER_COVERAGE_HELPER
        const fixture = process.env.RAYA_MEMBER_COVERAGE_FIXTURE
        const pin = process.env.RAYA_MEMBER_COVERAGE_HELPER_SHA256
        const sha = process.env.RAYA_MEMBER_COVERAGE_FIXTURE_SHA256
        if (process.platform !== "win32" || !helper || !fixture || !pin || !sha)
          throw new Error("Reviewed Windows helper and zero-delay fixture required")
        const checksum = await digest(helper)
        const image = await digest(fixture)
        expect(checksum).toBe(pin)
        expect(image).toBe(sha)
        const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-member-coverage-"))
        const profile = path.join(root, "profile")
        await mkdir(profile)
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) env[key] = value
        }
        env.RAYA_SOURCE_MEMBER_DIAGNOSTICS = "1"
        const app = await launch({
          executable: fixture,
          digest: image,
          helper: { executable: helper, digest: checksum },
          cwd: root,
          args: [mode],
          env,
          roots: [{ kind: "json", path: profile }],
          policy: { version: 1, directories: [root], files: [] },
        })
        const collect = async (stream: typeof app.child.stdout) => {
          if (!stream) throw new Error("Original fixture pipe unavailable")
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of stream) {
            if (!Buffer.isBuffer(chunk)) throw new Error("Original pipe encoding changed")
            size += chunk.length
            if (size > 1048576) throw new Error("Original fixture output exceeds bound")
            chunks.push(chunk)
          }
          return Buffer.concat(chunks).toString("utf8")
        }
        const output = [collect(app.child.stdout), collect(app.child.stderr)] as const
        const close = new Promise<void>((resolve) => app.child.once("close", () => resolve()))
        // Capture is armed before execution; normal mode exercises the same actual producer without it.
        const admission = await (capture ? app.capture() : Promise.resolve())
          .then(() => app.start())
          .then(
            () => ({ accepted: true as const }),
            (error: unknown) => ({ accepted: false as const, error }),
          )
        // Only a failed fixture admission is aborted; forced cleanup can never pass coverage.
        const cleanup = admission.accepted
          ? undefined
          : await app.abort().then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            )
        const joined = await Promise.allSettled([app.exit, app.sourceExit, close, ...output])
        await Bun.write(
          path.join(root, "original-settled.json"),
          JSON.stringify({
            mode,
            capture,
            accepted: admission.accepted,
            cleanup,
            statuses: joined.map((row) => row.status),
          }),
        )
        if (!admission.accepted)
          throw new AggregateError(
            [admission.error, ...(cleanup && "error" in cleanup ? [cleanup.error] : [])],
            "Fixture admission failed; any forced cleanup is not retirement acceptance",
          )
        const errors = joined.flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
        if (errors.length) throw new AggregateError(errors, "Original coverage fixture joins failed")
        const [exit, source, , stdout, stderr] = await Promise.all([app.exit, app.sourceExit, close, ...output])
        const family = await Bun.file(app.ticket.control + ".source-family-retired").json()
        const legacy = await Bun.file(app.ticket.control + ".source-retired").json()
        const diagnostic = await Bun.file(app.ticket.control + ".source-members-diagnostic").json()
        await Bun.write(
          path.join(root, "actual-original-joined.json"),
          JSON.stringify({
            mode,
            capture,
            exit,
            source,
            originalCloseJoined: true,
            stdout,
            stderr,
            family,
            legacy,
            diagnostic,
          }),
        )
        console.info(`Retained zero-delay ${mode} ${capture ? "capture" : "normal"} evidence at ${root}`)
        expect(exit).toEqual({ code: 0, signal: null })
        expect(source).toEqual({
          pid: app.ticket.header.pid,
          birth: app.ticket.header.birth,
          code: 0,
          completeProfileCoverage: false,
          portableCaptureAuthorized: false,
        })
        expect(stderr).toBe("")
        const actual: {
          count: number
          width: number
          intentionalDelayMs: number
          children: { pid: number; birth: string; code: number }[]
        } = JSON.parse(stdout)
        const count = mode === "overflow" ? 4097 : mode === "large" ? 1536 : mode === "parallel" ? 128 : 64
        expect(actual.count).toBe(count)
        expect(actual.width).toBe(mode === "parallel" ? 8 : 1)
        expect(actual.intentionalDelayMs).toBe(0)
        expect(actual.children).toHaveLength(count)
        expect(new Set(actual.children.map((row) => `${row.pid}:${row.birth}`)).size).toBe(count)
        expect(actual.children.every((row) => row.code === 0 && BigInt(row.birth) > 0n)).toBe(true)
        expect(family.success).toBe(true)
        expect(family.forced).toBe(false)
        // Windows may add console participants; exact Job accounting, not a guessed multiplier, is authority.
        expect(family.totalProcesses).toBeGreaterThanOrEqual(count + 1)
        expect(family.capture).toBe(capture)
        expect(legacy.capture).toBe(capture)
        expect(
          new Set(family.members.map((row: { pid: number; birth: string }) => `${row.pid}:${row.birth}`)).size,
        ).toBe(family.members.length)
        expect(family.members.every((row: { code: number }) => row.code === 0)).toBe(true)
        if (mode !== "overflow") {
          expect(family.memberObservationsComplete).toBe(true)
          expect(family.memberObservationsOverflow).toBe(false)
          expect(family.totalProcesses).toBe(family.members.length)
          expect(legacy.success).toBe(true)
          expect(family.members).toEqual(
            expect.arrayContaining([
              ...actual.children,
              { pid: app.ticket.header.pid, birth: app.ticket.header.birth, code: 0 },
            ]),
          )
        }
        if (mode === "overflow") {
          expect(family.memberObservationsComplete).toBe(false)
          expect(family.memberObservationsOverflow).toBe(true)
          expect(legacy.success).toBe(false)
          expect(family.members).toHaveLength(4096)
          expect(diagnostic.coverage.capacityRefused).toBeGreaterThan(0)
          expect(diagnostic.coverage.accountingMismatch).toBe(1)
        }
        expect(diagnostic.diagnosticOnly).toBe(true)
        expect(diagnostic.retirementAuthority).toBe(false)
        expect(diagnostic.failed).toBe(false)
        expect(diagnostic.coverage.openFailed).toBe(0)
        expect(diagnostic.coverage.queryFailed).toBe(0)
        expect(diagnostic.coverage.unassigned).toBe(0)
        expect(diagnostic.coverage.replacedBirth).toBe(0)
        expect(diagnostic.coverage.unsettled).toBe(0)
        if (mode !== "overflow") {
          expect(diagnostic.coverage.capacityRefused).toBe(0)
          expect(diagnostic.coverage.accountingMismatch).toBe(0)
          expect(diagnostic.observations).toBe(family.totalProcesses)
          expect(
            diagnostic.groups.reduce((sum: number, row: { observations: number }) => sum + row.observations, 0),
          ).toBe(family.totalProcesses)
          expect(
            diagnostic.groups.every((row: { image: string }) =>
              ["source-member-fixture.exe", "conhost.exe", "unknown"].includes(row.image),
            ),
          ).toBe(true)
        }
        expect(diagnostic.resources.available).toBe(true)
        expect(diagnostic.resources.retainedMembers).toBe(family.members.length)
        expect(diagnostic.resources.processHandles).toBeGreaterThanOrEqual(family.members.length)
        expect(BigInt(diagnostic.resources.peakWorkingSetBytes)).toBeGreaterThan(0n)
        expect(BigInt(diagnostic.resources.privateBytes)).toBeGreaterThan(0n)
      },
      180000,
    )

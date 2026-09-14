import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { copyFile, open, readFile, rename, mkdir, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { z } from "zod"
import { checksum, verify } from "../services/update-vsix"

const bytes = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() })
const replay = z.object({
  attemptID: z.string().min(1),
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  callID: z.string().min(1),
  completion: z.string().regex(/^[a-f0-9]{64}$/),
  report: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    category: z.enum(["ui", "chat", "routing", "goal", "browser", "settings", "build", "test", "docs", "other"]),
    severity: z.enum(["low", "medium", "high"]),
    approach: z.string().min(1),
    criteria: z.array(z.string().min(1)).min(1),
  }),
})
const evidence = z.object({
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  partID: z.string().min(1),
  callID: z.string().min(1),
  summary: z.string().min(1),
  record: z.object({
    version: z.literal(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    at: z.number().finite().nonnegative(),
  }),
})
const result = z.object({
  sessionID: z.string().min(1),
  goalRevision: z.string().min(1),
  summary: z.string().min(1),
  verifiedAt: z.number().finite().nonnegative(),
  reviewedAt: z.number().finite().nonnegative(),
  requirements: z.array(
    z.object({
      requirement: z.string().min(1),
      passed: z.literal(true),
      evidence: z.array(evidence).min(1),
    }),
  ),
})
const rollback = z.object({
  version: z.string().min(1),
  target: z.enum(["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]),
  source: z.string().min(1),
  package: z.string().min(1),
  artifact: bytes,
  binary: bytes,
})
const completion = z.object({
  version: z.literal(1),
  installationID: z.string().uuid(),
  itemID: z.string().min(1),
  approvalID: z.string().min(1),
  artifactID: z.string().min(1),
  repaired: z.string().min(1),
  previous: z.string().min(1),
  terminal: z.enum(["verified-active", "rollback-verified"]),
  artifact: bytes,
  binary: bytes,
  rollbackArtifact: bytes,
  rollbackBinary: bytes,
  replaySessionID: z.string().min(1).optional(),
  goalRevision: z.string().min(1).optional(),
  reviewedAt: z.number().finite().nonnegative().optional(),
  completedAt: z.number().finite().nonnegative(),
})
const schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  itemID: z.string().min(1),
  approvalID: z.string().min(1),
  artifactID: z.string().min(1),
  source: z.string().regex(/^[a-f0-9]{64}$/),
  head: z.string().min(1),
  extension: z.string().min(1),
  target: z.enum(["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]),
  output: z.string().min(1),
  package: z.string().min(1),
  artifact: bytes,
  binary: bytes,
  previous: z.string().min(1),
  rollback,
  replay,
  phase: z.enum([
    "validating",
    "installing",
    "awaiting-reload",
    "active",
    "replay-dispatching",
    "replay-submitted",
    "replay-unknown",
    "verification-publishing",
    "verification-unknown",
    "verified-active",
    "rollback-installing",
    "rollback-awaiting-reload",
    "rollback-unknown",
    "rollback-verified",
    "rollback-failed",
    "cleanup-pending",
    "failed",
  ]),
  terminal: z.enum(["verified-active", "rollback-verified"]).optional(),
  replaySessionID: z.string().min(1).optional(),
  verification: result.optional(),
  reason: z.string().optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
})

export type Record = z.infer<typeof schema>
export type Plan = Omit<
  Record,
  | "version"
  | "id"
  | "package"
  | "rollback"
  | "phase"
  | "terminal"
  | "replaySessionID"
  | "verification"
  | "reason"
  | "createdAt"
  | "updatedAt"
> & { rollback: Omit<Record["rollback"], "package"> }
export type Verification = NonNullable<Record["verification"]>
export type Completion = z.infer<typeof completion>

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

export class SelfHealInstallation {
  private readonly file: string
  private readonly completed: string
  private readonly locks: string

  constructor(private readonly root: string) {
    this.file = join(root, "installation.json")
    this.completed = join(root, "completed.json")
    this.locks = join(root, ".locks")
  }

  private lock<T>(work: () => Promise<T>) {
    return Flock.withLock("self-heal-installation", work, {
      dir: this.locks,
      staleMs: 2_000,
      timeoutMs: 30_000,
    })
  }

  private async read() {
    const raw = await readFile(this.file, "utf8").then(
      (value) => value,
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined
        throw err
      },
    )
    if (raw === undefined) return
    const record = schema.safeParse(JSON.parse(raw))
    if (!record.success) throw new Error("The saved self-heal installation record is invalid and was retained.")
    return record.data
  }

  private async write(record: Record) {
    await mkdir(this.root, { recursive: true })
    const tmp = join(this.root, `installation.${process.pid}.${randomUUID()}.tmp`)
    const file = await open(tmp, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify(record))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, this.file)
    if (process.platform === "win32") return
    const dir = await open(this.root, "r")
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }

  private async stage(source: string, destination: string, name: string) {
    const tmp = join(this.root, `${name}.${randomUUID()}.tmp`)
    await copyFile(source, tmp, constants.COPYFILE_EXCL)
    const file = await open(tmp, "r+")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, destination)
  }

  inspect() {
    return this.lock(() => this.read())
  }

  receipt() {
    return this.lock(async () => {
      const raw = await readFile(this.completed, "utf8").then(
        (value) => value,
        (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined
          throw err
        },
      )
      if (raw === undefined) return
      const saved = completion.safeParse(JSON.parse(raw))
      if (!saved.success) throw new Error("The saved self-heal completion receipt is invalid and was retained.")
      return saved.data
    })
  }

  run(plan: Plan, install: (path: string) => Promise<void>) {
    return this.lock(async () => {
      if (!isAbsolute(plan.output)) throw new Error("The approved self-heal artifact path is not absolute.")
      if (!isAbsolute(plan.rollback.source)) throw new Error("The rollback package path is not absolute.")
      if (plan.target !== `${process.platform}-${process.arch}`)
        throw new Error("The approved self-heal artifact does not target this computer.")
      if (plan.rollback.target !== plan.target || plan.rollback.version !== plan.previous)
        throw new Error("The rollback package does not match the active Raya version and platform.")
      const existing = await this.read()
      if (existing) {
        if (existing.approvalID === plan.approvalID) return { record: existing, dispatched: false }
        throw new Error("Another self-heal installation is retained. Resolve it before installing a different repair.")
      }
      const now = Date.now()
      const id = randomUUID()
      const record = schema.parse({
        ...plan,
        rollback: { ...plan.rollback, package: join(this.root, `rollback.${id}.vsix`) },
        version: 1,
        id,
        package: join(this.root, `approved.${id}.vsix`),
        phase: "validating",
        createdAt: now,
        updatedAt: now,
      })
      await this.write(record)
      try {
        await this.stage(record.output, record.package, `approved.${record.id}`)
        await verify(record.package, {
          name: "raya",
          publisher: "eden",
          version: record.extension,
          target: record.target,
          artifact: record.artifact,
          binary: record.binary,
        })
        await this.stage(record.rollback.source, record.rollback.package, `rollback.${record.id}`)
        await verify(record.rollback.package, {
          name: "raya",
          publisher: "eden",
          version: record.rollback.version,
          target: record.rollback.target,
          artifact: record.rollback.artifact,
          binary: record.rollback.binary,
        })
      } catch (err) {
        await this.write({ ...record, phase: "failed", reason: message(err), updatedAt: Date.now() })
        throw err
      }
      const installing = { ...record, phase: "installing" as const, updatedAt: Date.now() }
      await this.write(installing)
      await install(record.package)
      const complete = { ...record, phase: "awaiting-reload" as const, updatedAt: Date.now() }
      await this.write(complete)
      return { record: complete, dispatched: true }
    })
  }

  activate(version: string, binary: string) {
    return this.lock(async () => {
      const record = await this.read()
      if (!record) return
      if (record.phase === "cleanup-pending") return { record, changed: false }
      if (record.phase.startsWith("rollback-")) {
        if (record.phase === "rollback-verified" || record.phase === "rollback-failed" || record.previous !== version)
          return { record, changed: false }
        try {
          await checksum(binary, record.rollback.binary, 512 * 1024 * 1024)
        } catch (err) {
          const failed: Record = {
            ...record,
            phase: "rollback-failed",
            reason: `The restored bundled CLI does not match the retained rollback package. ${message(err)}`,
            updatedAt: Date.now(),
          }
          await this.write(failed)
          return { record: failed, changed: true }
        }
        const restored: Record = {
          ...record,
          phase: "rollback-verified",
          reason: undefined,
          updatedAt: Date.now(),
        }
        await this.write(restored)
        return { record: restored, changed: true }
      }
      if (record.phase === "validating") {
        const failed = {
          ...record,
          phase: "failed" as const,
          reason: "Validation was interrupted before installation dispatch.",
          updatedAt: Date.now(),
        }
        await this.write(failed)
        return { record: failed, changed: true }
      }
      if (record.extension !== version || record.phase === "failed") return { record, changed: false }
      try {
        await checksum(binary, record.binary, 512 * 1024 * 1024)
      } catch (err) {
        const failed = {
          ...record,
          phase: "failed" as const,
          reason: `The active bundled CLI does not match the approval. ${message(err)}`,
          updatedAt: Date.now(),
        }
        await this.write(failed)
        return { record: failed, changed: true }
      }
      if (
        record.phase === "active" ||
        record.phase === "verified-active" ||
        record.phase.startsWith("replay-") ||
        record.phase.startsWith("verification-")
      )
        return { record, changed: false }
      const active = { ...record, phase: "active" as const, reason: undefined, updatedAt: Date.now() }
      await this.write(active)
      return { record: active, changed: true }
    })
  }

  replay(dispatch: (input: Record["replay"], link: (session: string) => Promise<void>) => Promise<void>) {
    return this.lock(async () => {
      const record = await this.read()
      if (!record) throw new Error("No self-heal installation is retained for verification.")
      if (record.phase.startsWith("replay-")) return { record, dispatched: false }
      if (record.phase !== "active") throw new Error("The approved Raya version must be active before verification.")
      const pending: Record = {
        ...record,
        phase: "replay-dispatching",
        reason: undefined,
        updatedAt: Date.now(),
      }
      await this.write(pending)
      let session: string | undefined
      const link = async (id: string) => {
        if (!id.trim()) throw new Error("Verification session identity is empty.")
        if (session && session !== id) throw new Error("Verification session identity cannot change.")
        session = id
        await this.write({ ...pending, replaySessionID: id, updatedAt: Date.now() })
      }
      await dispatch(record.replay, link).catch(async (err) => {
        const unknown: Record = {
          ...pending,
          phase: "replay-unknown",
          replaySessionID: session,
          reason: `Verification dispatch could not be confirmed. ${message(err)}`,
          updatedAt: Date.now(),
        }
        await this.write(unknown)
        throw err
      })
      if (!session) {
        const unknown: Record = {
          ...pending,
          phase: "replay-unknown",
          reason: "Verification dispatch returned no session identity.",
          updatedAt: Date.now(),
        }
        await this.write(unknown)
        throw new Error(unknown.reason)
      }
      const submitted: Record = {
        ...pending,
        phase: "replay-submitted",
        replaySessionID: session,
        updatedAt: Date.now(),
      }
      await this.write(submitted)
      return { record: submitted, dispatched: true }
    })
  }

  accept(candidate: Verification, publish: (record: Record) => Promise<void>) {
    return this.lock(async () => {
      const record = await this.read()
      if (!record) throw new Error("No self-heal installation is retained for verification.")
      if (record.phase === "verified-active" || record.phase.startsWith("verification-"))
        return { record, published: false }
      if (record.phase !== "replay-submitted" || !record.replaySessionID)
        throw new Error("Installed repair verification has not completed an owned dispatch.")
      const receipt = result.parse(candidate)
      if (receipt.sessionID !== record.replaySessionID)
        throw new Error("Verification evidence belongs to a different session.")
      if (
        JSON.stringify(receipt.requirements.map((item) => item.requirement)) !==
        JSON.stringify(record.replay.report.criteria)
      )
        throw new Error("Verification evidence does not cover the retained acceptance criteria exactly.")
      const pending: Record = {
        ...record,
        phase: "verification-publishing",
        verification: receipt,
        reason: undefined,
        updatedAt: Date.now(),
      }
      await this.write(pending)
      await publish(pending).catch(async (err) => {
        const unknown: Record = {
          ...pending,
          phase: "verification-unknown",
          reason: `Verification evidence publication could not be confirmed. ${message(err)}`,
          updatedAt: Date.now(),
        }
        await this.write(unknown)
        throw err
      })
      const accepted: Record = {
        ...pending,
        phase: "verified-active",
        updatedAt: Date.now(),
      }
      await this.write(accepted)
      return { record: accepted, published: true }
    })
  }

  rollback(install: (path: string) => Promise<void>) {
    return this.lock(async () => {
      const record = await this.read()
      if (!record) throw new Error("No self-heal installation is retained for rollback.")
      if (record.phase.startsWith("rollback-")) return { record, dispatched: false }
      if (
        !["active", "replay-submitted", "replay-unknown", "verification-unknown", "verified-active", "failed"].includes(
          record.phase,
        )
      )
        throw new Error("This self-heal installation is not ready for rollback.")
      try {
        await verify(record.rollback.package, {
          name: "raya",
          publisher: "eden",
          version: record.rollback.version,
          target: record.rollback.target,
          artifact: record.rollback.artifact,
          binary: record.rollback.binary,
        })
      } catch (err) {
        const failed: Record = {
          ...record,
          phase: "rollback-failed",
          reason: `The retained rollback package could not be verified. ${message(err)}`,
          updatedAt: Date.now(),
        }
        await this.write(failed)
        throw err
      }
      const installing: Record = {
        ...record,
        phase: "rollback-installing",
        reason: undefined,
        updatedAt: Date.now(),
      }
      await this.write(installing)
      await install(record.rollback.package).catch(async (err) => {
        const unknown: Record = {
          ...installing,
          phase: "rollback-unknown",
          reason: `Rollback dispatch could not be confirmed. ${message(err)}`,
          updatedAt: Date.now(),
        }
        await this.write(unknown)
        throw err
      })
      const pending: Record = {
        ...installing,
        phase: "rollback-awaiting-reload",
        updatedAt: Date.now(),
      }
      await this.write(pending)
      return { record: pending, dispatched: true }
    })
  }

  cleanup() {
    return this.lock(async () => {
      const record = await this.read()
      if (!record) {
        const raw = await readFile(this.completed, "utf8").then(
          (value) => value,
          (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") return undefined
            throw err
          },
        )
        if (raw === undefined) throw new Error("No completed self-heal installation is retained for cleanup.")
        return { receipt: completion.parse(JSON.parse(raw)), cleaned: false }
      }
      const terminal = record.phase === "cleanup-pending" ? record.terminal : record.phase
      if (terminal !== "verified-active" && terminal !== "rollback-verified")
        throw new Error("Self-heal installation cleanup requires a verified repair or verified rollback.")
      const pending: Record =
        record.phase === "cleanup-pending"
          ? record
          : { ...record, phase: "cleanup-pending", terminal, reason: undefined, updatedAt: Date.now() }
      if (record.phase !== "cleanup-pending") await this.write(pending)
      const receipt = completion.parse({
        version: 1,
        installationID: pending.id,
        itemID: pending.itemID,
        approvalID: pending.approvalID,
        artifactID: pending.artifactID,
        repaired: pending.extension,
        previous: pending.previous,
        terminal,
        artifact: pending.artifact,
        binary: pending.binary,
        rollbackArtifact: pending.rollback.artifact,
        rollbackBinary: pending.rollback.binary,
        replaySessionID: pending.replaySessionID,
        goalRevision: pending.verification?.goalRevision,
        reviewedAt: pending.verification?.reviewedAt,
        completedAt: pending.updatedAt,
      })
      const existing = await readFile(this.completed, "utf8").then(
        (value) => completion.parse(JSON.parse(value)),
        (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined
          throw err
        },
      )
      if (existing && JSON.stringify(existing) !== JSON.stringify(receipt))
        throw new Error("A different self-heal completion receipt is already retained.")
      if (!existing) {
        const tmp = join(this.root, `completed.${process.pid}.${randomUUID()}.tmp`)
        const file = await open(tmp, "wx", 0o600)
        try {
          await file.writeFile(JSON.stringify(receipt))
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(tmp, this.completed)
      }
      await rm(pending.package, { force: true })
      await rm(pending.rollback.package, { force: true })
      await rm(this.file, { force: true })
      return { receipt, cleaned: true }
    })
  }
}

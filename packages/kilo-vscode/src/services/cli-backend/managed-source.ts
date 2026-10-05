import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { launch } from "@opencode-ai/core/kilocode/source-launch"
import { prepare } from "@opencode-ai/core/kilocode/source-profile"
import { startup } from "@opencode-ai/core/kilocode/source-offline"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"

export type ManagedSource = { session: Awaited<ReturnType<typeof launch>>; exited: boolean }
const stops = new WeakMap<ManagedSource, ReturnType<ManagedSource["session"]["abort"]>>()

async function image(file: string) {
  const resolved = await realpath(file)
  const info = await lstat(resolved)
  if (!info.isFile() || info.nlink !== 1) throw new Error("Managed source image is not a unique regular file")
  return {
    executable: resolved,
    digest: createHash("sha256")
      .update(await readFile(resolved))
      .digest("hex"),
  }
}

/** The producer binds profile boundaries before any source code is resumed. */
export async function start(input: {
  executable: string
  cwd: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  helper: string
}) {
  const target = await image(input.executable)
  const helper = await image(input.helper)
  const metadata: unknown = JSON.parse(
    await readFile(path.join(path.dirname(helper.executable), "raya-process-host.json"), "utf8"),
  )
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("version" in metadata) ||
    metadata.version !== 1 ||
    !("exe" in metadata) ||
    metadata.exe !== helper.digest
  )
    throw new Error("Managed source helper differs from its packaged fingerprint")
  await startup({ helper, env: input.env })
  const profile = await prepare({ home: os.homedir(), cwd: input.cwd, env: input.env })
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  const session = await launch({
    ...target,
    cwd: await realpath(input.cwd),
    args: input.args,
    env,
    roots: profile.roots,
    policy: profile.policy,
    helper,
  })
  const source: ManagedSource = { session, exited: false }
  void session.sourceExit.then(
    () => {
      source.exited = true
    },
    () => {
      source.exited = true
    },
  )
  return source
}

/** Forced disposal is recorded as forced; it never supplies capture authority. */
export function stop(source: ManagedSource) {
  const previous = stops.get(source)
  if (previous) return previous
  const result = source.session.abort()
  stops.set(source, result)
  return result
}

/** Joins only this producer's accepted native launches and owned families. */
export class Sources {
  private closed = false
  private capturing = false
  private capture: Promise<ManagedSource> | undefined
  private readonly pending = new Set<Promise<void>>()
  private readonly sources = new Set<ManagedSource>()
  private readonly errors: unknown[] = []
  private closing: Promise<void> | undefined
  private readonly cutoff = new Error("Raya source producer is retired")

  create(input: Parameters<typeof start>[0]): Promise<ManagedSource> {
    if (this.closed) return Promise.reject(this.cutoff)
    const job = (async () => {
      const source = await start(input)
      if (this.closed && !this.capturing) {
        await stop(source)
        throw this.cutoff
      }
      this.sources.add(source)
      void source.session.exit.then(
        () => this.sources.delete(source),
        (err: unknown) => this.errors.push(err),
      )
      return source
    })()
    const joined = job.then(
      () => undefined,
      (err: unknown) => {
        if (err !== this.cutoff) this.errors.push(err)
      },
    )
    this.pending.add(joined)
    void joined.then(() => this.pending.delete(joined))
    return job
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      if (this.capture) {
        const admission = await this.capture.then(
          (source) => ({ source }),
          (err: unknown) => ({ err }),
        )
        if ("source" in admission) {
          const result = await admission.source.session.exit
          if (result.code !== 0 || result.signal) throw new Error("Captured source family did not exit naturally zero")
          return
        }
        // A refused admission grants no capture. Cleanup remains explicitly forced.
        this.errors.push(admission.err)
      }
      await Promise.all([...this.pending])
      const results = await Promise.allSettled([...this.sources].map(stop))
      this.errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
      if (this.errors.length) throw new AggregateError([...this.errors], "Raya source producer cleanup failed")
    })()
    return this.closing
  }

  /** Terminal natural handoff of one actual owned family; this never forces a source to retire. */
  captureSource(): Promise<ManagedSource> {
    if (this.capture) return this.capture
    if (this.closed) return Promise.reject(new Error("Raya source producer was already disposed"))
    this.closed = true
    this.capturing = true
    this.capture = (async () => {
      await Promise.all([...this.pending])
      if (this.errors.length) throw new AggregateError([...this.errors], "Raya source admission failed")
      const sources = [...this.sources]
      if (sources.length !== 1 || sources[0].exited) throw new Error("Capture requires one live owned source family")
      const source = sources[0]
      await source.session.start()
      const ticket = source.session.ticket
      for (const item of [
        {
          pid: ticket.header.pid,
          birth: ticket.header.birth,
          executable: ticket.header.executable,
          digest: ticket.header.digest,
        },
        { pid: ticket.header.helper, birth: ticket.header.helperBirth, ...ticket.image },
      ]) {
        const actual = z
          .object({ status: z.literal("owned"), birth: z.string(), parent: z.number().int().nonnegative() })
          .strict()
          .parse(await NativeProcess.inspect(item.pid, ticket.image.executable))
        if (actual.birth !== item.birth) throw new Error("Capture source kernel identity changed")
        if ((await image(item.executable)).digest !== item.digest) throw new Error("Capture source image pin changed")
      }
      if (source.exited) throw new Error("Capture source exited before handoff admission")
      return source
    })()
    return this.capture
  }
}

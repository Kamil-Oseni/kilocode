import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, lstat, unlink } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { check, document, object, sha } from "../control/frames"
import { directory, image, normalize } from "../control/identity"
import { publish } from "../managed/owner"
import { descriptor, type Descriptor } from "../managed/descriptor"
import { space } from "../managed/generation"
import { protection } from "../managed/protection"
import { fingerprint } from "../failed-repair"
import * as plan from "./plan"
import * as catalog from "./catalog"
import * as provision from "./provision"
import * as transport from "./transport"
import * as reply from "./reply"
import * as results from "./results"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const ref = z
  .object({
    path: z.string().min(1).refine(path.isAbsolute),
    bytes: z.number().int().positive().max(65536),
    sha256: hash,
    tuple: z.string().min(1),
  })
  .strict()
const operation = z
  .object({
    id: hash,
    op: z.enum(["inspect", "import", "index", "forget", "search"]),
    request: z.string().regex(/^[a-f0-9]{32}$/),
    receipt: ref,
  })
  .strict()
const state = z
  .object({ format: z.literal("raya.media.grant.state.v1"), grant: ref, operations: z.array(operation).max(1024) })
  .strict()
type Ref = z.infer<typeof ref>
type State = z.infer<typeof state>
type Review = Awaited<ReturnType<typeof plan.prepare>>
type Draft = {
  review: Review
  runtime: ReturnType<typeof catalog.runtime>
  selected: Ref
  metadata: string
  release: string
}
type Activity = { request: string; epoch: string; project: string; op: transport.Request["op"] }
type Store = { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
type Options = { extension: string; storage: string; store: Store; trusted: (project: string) => void }

const absent = (file: string) =>
  lstat(file).then(
    () => false,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return true
      throw err
    },
  )

/** Native consent and original-worker ownership are separate from read-only model consumption. */
export class MediaCoordinator {
  private closed = false
  private queue = Promise.resolve()
  private readonly drafts = new WeakSet<Draft>()
  private readonly jobs = new Map<string, { activity: Activity; controller: AbortController; job: Promise<unknown> }>()
  private readonly debts = new Map<string, Activity>()

  constructor(private readonly opts: Options) {
    check(path.isAbsolute(opts.extension) && path.isAbsolute(opts.storage), "Absolute media coordinator roots required")
  }

  private key(project: string) {
    return "raya.media.grant." + sha(normalize(project))
  }
  private guard(project: string, signal: AbortSignal) {
    signal.throwIfAborted()
    check(!this.closed, "Media coordinator intake is retired")
    check(path.isAbsolute(project), "Exact authenticated media project required")
    this.opts.trusted(project)
  }
  private serial<T>(body: () => Promise<T>) {
    const next = this.queue.then(body)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  private async retained(value: Ref) {
    const held = await image(value.path, 65536)
    check(
      held.digest === value.sha256 && held.raw.length === value.bytes && held.tuple === value.tuple,
      "Immutable media publication changed",
    )
    return held
  }

  async draft(
    project: string,
    choice: { source: string; files: string[]; excluded: string[] },
    input: Descriptor,
    signal: AbortSignal,
  ) {
    this.guard(project, signal)
    check(
      this.opts.store.get(this.key(project)) === undefined,
      "Existing media grant must be inspected; replacement is not automatic",
    )
    const cfg = descriptor(input)
    const sid = await protection(cfg.root)
    check(sid === cfg.namespaces.memory.sid && sid === cfg.namespaces.retrieval.sid, "Selected managed owner differs")
    await directory(this.opts.storage)
    const root = path.join(this.opts.storage, "raya-media-" + randomUUID().replaceAll("-", ""))
    await space(root, sid)
    const metadata = path.join(root, "metadata")
    const library = path.join(root, "library")
    await space(metadata, sid)
    await space(library, sid)
    this.guard(project, signal)
    const prepared = await provision.prepare(cfg, metadata, signal)
    await mkdir(path.join(metadata, "Claims"))
    const pin = await image(prepared.selected.path, 65536)
    check(
      pin.digest === prepared.selected.sha256 && pin.raw.length === prepared.selected.bytes,
      "Selected media runtime changed",
    )
    const runtime = catalog.runtime(prepared.runtime)
    const sources = await catalog.sources(this.opts.extension, signal)
    const review = await plan.prepare({ ...choice, project, root: library }, signal)
    const value: Draft = {
      review,
      runtime,
      selected: ref.parse({ ...prepared.selected, tuple: pin.tuple }),
      metadata,
      release: fingerprint({
        sources: sources.release,
        runtime: { bytes: prepared.selected.bytes, sha256: prepared.selected.sha256 },
      }),
    }
    this.drafts.add(value)
    this.guard(project, signal)
    return value
  }

  /** Only the native human-approved handler may call this method with its original draft. */
  approve(value: Draft, signal: AbortSignal) {
    return this.serial(async () => {
      const project = value.review.selection.project
      this.guard(project, signal)
      check(this.drafts.has(value), "Original native media review required")
      const key = this.key(project)
      check(this.opts.store.get(key) === undefined, "Media consent changed during review")
      await plan.verify(value.review, project, signal)
      check(
        isDeepStrictEqual(
          catalog.runtime(document((await this.retained(value.selected)).raw, 65536).value),
          value.runtime,
        ),
        "Reviewed runtime differs from its selected publication",
      )
      check(
        fingerprint({
          sources: (await catalog.sources(this.opts.extension, signal)).release,
          runtime: { bytes: value.selected.bytes, sha256: value.selected.sha256 },
        }) === value.release,
        "Reviewed media release changed",
      )
      const grant = await publish(path.join(value.metadata, "grant.json"), { format: "raya.media.grant.v1", ...value })
      this.guard(project, signal)
      check(this.opts.store.get(key) === undefined, "Media consent changed before publication")
      const next: State = { format: "raya.media.grant.state.v1", grant, operations: [] }
      await this.opts.store.update(key, next)
      check(isDeepStrictEqual(this.opts.store.get(key), next), "Media consent acknowledgement is uncertain")
      this.guard(project, signal)
      await publish(path.join(value.metadata, "approved.json"), {
        format: "raya.media.approval.closed.v1",
        grant,
        state: next,
      })
      this.drafts.delete(value)
      return { ...value, grant }
    })
  }

  async grant(project: string, signal: AbortSignal) {
    this.guard(project, signal)
    const saved = state.parse(this.opts.store.get(this.key(project)))
    const held = await this.retained(saved.grant)
    const value = object(document(held.raw, 65536).value)
    check(value.format === "raya.media.grant.v1", "Native approved media grant required")
    const prior = object(value.review)
    const selection = object(prior.selection)
    const fresh = await plan.prepare(
      {
        project,
        source: selection.source,
        root: selection.root,
        excluded: selection.excluded,
        files: z
          .array(z.object({ path: z.string() }).passthrough())
          .parse(selection.files)
          .map((file) => file.path),
      },
      signal,
    )
    const review = {
      ...fresh,
      generation: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .parse(prior.generation),
    }
    check(fingerprint(review) === fingerprint(value.review), "Original approved media review changed")
    const runtime = catalog.runtime(value.runtime)
    const selected = ref.parse(value.selected)
    check(
      isDeepStrictEqual(catalog.runtime(document((await this.retained(selected)).raw, 65536).value), runtime),
      "Approved runtime differs from its selected publication",
    )
    const metadata = z.string().refine(path.isAbsolute).parse(value.metadata)
    check(
      path.dirname(saved.grant.path) === metadata && normalize(metadata).startsWith(normalize(this.opts.storage) + "/"),
      "Media grant escapes its private storage",
    )
    check(
      path.dirname(path.dirname(metadata)) === this.opts.storage &&
        /^raya-media-[a-f0-9]{32}$/.test(path.basename(path.dirname(metadata))) &&
        path.basename(metadata) === "metadata" &&
        review.selection.root === path.join(path.dirname(metadata), "library") &&
        saved.grant.path === path.join(metadata, "grant.json"),
      "Exact private media generation required",
    )
    await protection(metadata)
    await protection(review.selection.root)
    const approved = object(document((await image(path.join(metadata, "approved.json"), 65536)).raw, 65536).value)
    check(
      approved.format === "raya.media.approval.closed.v1" && fingerprint(approved.grant) === fingerprint(saved.grant),
      "Original media approval acknowledgement remains unresolved",
    )
    const sources = await catalog.sources(this.opts.extension, signal)
    const release = fingerprint({
      sources: sources.release,
      runtime: { bytes: selected.bytes, sha256: selected.sha256 },
    })
    check(release === value.release, "Approved media release changed")
    await this.history(saved, review, release)
    this.guard(project, signal)
    check(
      isDeepStrictEqual(this.opts.store.get(this.key(project)), saved),
      "Media grant state changed during inspection",
    )
    return {
      review,
      runtime,
      selected,
      metadata,
      release,
      sources: sources.sources,
      grant: saved.grant,
      state: saved,
    }
  }

  private async history(saved: State, review: Review, release: string) {
    for (const op of saved.operations) {
      const proof = object(document((await this.retained(op.receipt)).raw, 65536).value)
      const request = object(proof.request)
      const args = object(request.args)
      const terminal = object(proof.terminal)
      check(
        fingerprint(proof.grant) === fingerprint(saved.grant) &&
          request.request === op.request &&
          request.op === op.op &&
          request.release === release &&
          request.policySHA === review.policySHA &&
          fingerprint(request.selection) === fingerprint(review.selection),
        "Original media operation proof belongs to another grant",
      )
      check(
        op.id === (op.op === "search" ? sha(z.string().parse(args.query)) : args.id),
        "Original media operation source differs",
      )
      check(
        terminal.accepted === true &&
          terminal.status === "completed" &&
          ["request", "epoch", "op", "release", "policySHA"].every((key) => terminal[key] === request[key]) &&
          terminal.authority === false &&
          terminal.replay === false &&
          terminal.forced === false,
        "Original completed media operation required",
      )
      const receipt = ref.parse(proof.receipt)
      const closed = object(document((await this.retained(receipt)).raw, 65536).value)
      await this.publications(closed, request, terminal, review.selection.root)
      check(
        closed.originalJoined === true &&
          closed.readersJoined === true &&
          closed.writerJoined === true &&
          closed.familyJoined === true &&
          closed.forced === false &&
          fingerprint(closed.eof) === fingerprint({ stdout: true, stderr: true }),
        "Original media family retirement is unconfirmed",
      )
    }
  }

  private async publications(
    closed: ReturnType<typeof object>,
    request: ReturnType<typeof object>,
    terminal: ReturnType<typeof object>,
    root: string,
  ) {
    const refs = z
      .array(ref.extend({ bytes: z.number().int().positive().max(131072) }))
      .length(2)
      .parse(closed.evidence)
    const folder = path.join(
      root,
      "Requests",
      z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .parse(request.epoch),
    )
    const name = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(request.request)
    const values = await Promise.all(
      refs.map(async (value, index) => {
        check(
          value.path === path.join(folder, name + (index === 0 ? ".pending.json" : ".terminal.json")),
          "Original media evidence path differs",
        )
        const held = await image(value.path, 131072)
        check(
          held.digest === value.sha256 && held.raw.length === value.bytes && held.tuple === value.tuple,
          "Original media evidence changed",
        )
        return document(held.raw, 131072).value
      }),
    )
    const pending = object(values[0])
    check(
      pending.format === "raya.media.pending.v1" &&
        pending.requestSHA === fingerprint(request) &&
        isDeepStrictEqual(pending.operation, request) &&
        terminal.pendingSHA === refs[0].sha256,
      "Original media pending evidence differs",
    )
    check(isDeepStrictEqual(values[1], terminal), "Original media terminal evidence differs")
  }

  private async outcome(
    selected: Review["files"][number] | undefined,
    activity: Activity,
    launch: transport.Launch,
    value: ReturnType<typeof object>[string],
  ) {
    if (!selected) return
    const outcome = object(value)
    check(
      outcome.origin === selected.path &&
        outcome.sourceSHA === selected.sha256 &&
        object(outcome.decoded).sha256 === selected.sha256,
      "Media result differs from its original approved source",
    )
    if (activity.op !== "inspect")
      check(
        outcome.id === selected.id && outcome.kind === selected.kind && outcome.bytes === selected.bytes,
        "Original imported media identity differs",
      )
    if (activity.op === "import")
      check(outcome.imported === true && outcome.indexed === false, "Media import is not confirmed")
    if (activity.op === "index") check(outcome.indexed === true, "Media indexing is not confirmed")
    if (activity.op === "forget") check(outcome.forgotten === true, "Media forgetting is not confirmed")
    if (activity.op !== "inspect") {
      const snapshot = object(outcome.snapshot)
      const target = z.string().parse(snapshot.path)
      const extension = path.extname(selected.path).toLowerCase()
      const suffix = extension === ".jpeg" ? ".jpg" : extension
      check(
        target === path.join(launch.root, "Assets", selected.id + suffix) &&
          snapshot.sha256 === selected.sha256 &&
          snapshot.bytes === selected.bytes,
        "Media snapshot differs from its exact original content address",
      )
      if (activity.op === "forget") check(await absent(target), "Forgotten media snapshot remains present")
      if (activity.op !== "forget") {
        const held = await image(target, 33554432)
        check(held.digest === selected.sha256 && held.raw.length === selected.bytes, "Imported media snapshot changed")
      }
    }
  }

  active() {
    return [...this.jobs.values()].map((value) => ({ ...value.activity }))
  }
  async cancel(activity: Activity) {
    const held = this.jobs.get(activity.project)
    check(held && isDeepStrictEqual(held.activity, activity), "Exact original media activity required")
    held.controller.abort()
    return held.job
  }
  retire() {
    this.closed = true
    for (const held of this.jobs.values()) held.controller.abort()
    return Promise.allSettled([this.queue, ...[...this.jobs.values()].map((held) => held.job)]).then((rows) => {
      const errors = rows.flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
      if (this.debts.size) errors.push(new Error("Original durable media claims remain unresolved"))
      if (errors.length) throw new AggregateError(errors, "Media original operation retirement remains uncertain")
    })
  }

  inspect(project: string, id: string, signal: AbortSignal) {
    return this.start(project, "inspect", { id }, signal)
  }
  import(project: string, id: string, signal: AbortSignal) {
    return this.start(project, "import", { id }, signal)
  }
  index(project: string, id: string, signal: AbortSignal) {
    return this.start(project, "index", { id }, signal)
  }
  forget(project: string, id: string, signal: AbortSignal) {
    return this.start(project, "forget", { id }, signal)
  }
  async context(project: string, query: string, top: number, signal: AbortSignal) {
    check(
      query.trim() && Buffer.byteLength(query, "utf8") <= 2048 && Number.isInteger(top) && top >= 1 && top <= 10,
      "Bounded media query required",
    )
    return results.parse(await this.start(project, "search", { query, top }, signal))
  }

  private start(project: string, op: transport.Request["op"], args: transport.Request["args"], signal: AbortSignal) {
    this.guard(project, signal)
    check(!this.jobs.has(project), "Original media operation is still active")
    check(!this.debts.has(project), "Original media operation remains uncertain")
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    const activity = { project, op, request: randomUUID().replaceAll("-", ""), epoch: randomUUID().replaceAll("-", "") }
    const job = this.serial(() => this.execute(activity, args, controller.signal)).finally(() => {
      signal.removeEventListener("abort", abort)
      this.jobs.delete(project)
    })
    this.jobs.set(project, { activity, controller, job })
    return job
  }

  private async execute(activity: Activity, args: transport.Request["args"], signal: AbortSignal) {
    const current = await this.grant(activity.project, signal)
    const claimpath = path.join(current.metadata, "Claims", sha(normalize(activity.project)) + ".json")
    check(await absent(claimpath), "Original media claim remains unresolved; automatic replay is forbidden")
    const selected = "id" in args ? current.review.files.find((file) => file.id === hash.parse(args.id)) : undefined
    if ("id" in args) check(selected, "Exact approved media source required")
    const last = (id: string) =>
      current.state.operations.filter((row) => row.id === id && row.op !== "inspect" && row.op !== "search").at(-1)?.op
    if (activity.op === "index" || activity.op === "forget")
      check(
        "id" in args && ["import", "index"].includes(last(args.id) ?? ""),
        "Approved original import evidence required",
      )
    if (activity.op === "search")
      check(
        current.review.files.every((file) => last(file.id) === "index"),
        "Every approved source requires original import and index evidence",
      )
    check(current.state.operations.length < 1024, "Media operation history reached its bound")
    const input: transport.Request = {
      format: "raya.media.operation.v1",
      request: activity.request,
      epoch: activity.epoch,
      op: activity.op,
      selection: current.review.selection,
      release: current.release,
      policySHA: current.review.policySHA,
      args,
      model: ["index", "search"].includes(activity.op) ? current.runtime.model : null,
    }
    const runtime = input.model
      ? await catalog.validate(current.runtime, signal)
      : await catalog.dependencies(current.runtime, signal)
    await catalog.current(runtime, signal)
    this.guard(activity.project, signal)
    this.debts.set(activity.project, activity)
    const claim = await publish(claimpath, { format: "raya.media.claim.v1", grant: current.grant, request: input })
    const authorize = async () => {
      this.guard(activity.project, signal)
      check(
        isDeepStrictEqual(this.opts.store.get(this.key(activity.project)), current.state),
        "Original media authority changed",
      )
      await this.retained(current.grant)
      await this.retained(current.selected)
      await this.retained(claim)
      await catalog.current(runtime, signal)
      await plan.verify(current.review, activity.project, signal)
    }
    await authorize()
    const launch: transport.Launch = {
      format: "raya.media.launch.v1",
      root: current.review.selection.root,
      dependencies: current.runtime.dependencies,
      python: current.runtime.python,
      sources: {
        "supervisor.py": current.sources["supervisor.py"],
        "worker.py": current.sources["worker.py"],
        "session.py": current.sources["session.py"],
        "library.py": current.sources["library.py"],
        "encoder.py": current.sources["encoder.py"],
        "owner.py": current.sources["owner.py"],
      },
    }
    const result = await transport.run(this.opts.extension, launch, input, signal, authorize, async (value) => {
      await authorize()
      await publish(path.join(current.metadata, "Requests", input.request + ".owner.json"), { claim, ...value })
    })
    await authorize()
    const pending = await image(
      path.join(launch.root, "Requests", input.epoch, input.request + ".pending.json"),
      131072,
    )
    check(result.terminal.pendingSHA === pending.digest, "Original pending publication differs")
    await this.outcome(selected, activity, launch, result.terminal.result)
    const context =
      activity.op === "search" ? reply.build(current.review, input, result.terminal, pending.digest) : undefined
    if (context)
      await results.verify(context.value, {
        project: activity.project,
        root: current.review.selection.source,
        querySHA: sha("query" in args ? args.query : ""),
        policySHA: input.policySHA,
        releaseSHA: input.release,
        generation: current.review.generation,
        selected: current.review.files,
        authorized: context.authorized,
        forgotten: [],
        library: launch.root,
        segments: context.segments,
        verifiers: [],
      })
    const proof = await publish(path.join(current.metadata, "Requests", input.request + ".json"), {
      request: input,
      grant: current.grant,
      receipt: result.receipt,
      terminal: result.terminal,
    })
    const next: State = {
      ...current.state,
      operations: [
        ...current.state.operations,
        {
          id: selected?.id ?? sha("query" in args ? args.query : ""),
          op: input.op,
          request: input.request,
          receipt: proof,
        },
      ],
    }
    await authorize()
    await this.opts.store.update(this.key(activity.project), next)
    check(
      isDeepStrictEqual(this.opts.store.get(this.key(activity.project)), next),
      "Media operation acknowledgement remains uncertain",
    )
    await this.retained(current.selected)
    await catalog.current(runtime, signal)
    await plan.verify(current.review, activity.project, signal)
    await this.retained(claim)
    await unlink(claim.path)
    this.debts.delete(activity.project)
    this.guard(activity.project, signal)
    await this.retained(current.selected)
    await catalog.current(runtime, signal)
    await plan.verify(current.review, activity.project, signal)
    if (context)
      await results.verify(context.value, {
        project: activity.project,
        root: current.review.selection.source,
        querySHA: sha("query" in args ? args.query : ""),
        policySHA: input.policySHA,
        releaseSHA: input.release,
        generation: current.review.generation,
        selected: current.review.files,
        authorized: context.authorized,
        forgotten: [],
        library: launch.root,
        segments: context.segments,
        verifiers: [],
      })
    this.guard(activity.project, signal)
    return context?.value ?? { op: input.op, result: result.terminal.result, receipt: proof }
  }
}

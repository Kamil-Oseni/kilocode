// raya_change - Async voice plane: session admission, transcript truth, and reactive delegation.
import { Effect, Fiber, Option, Schema, Semaphore, type Scope } from "effect"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { AccessToken } from "livekit-server-sdk"
import type { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import type { Storage } from "@/storage/storage"
import { VoiceReconstructor } from "./reconstructor"
import { ContextItem, Failure, type Envelope, type Info, type Start, type State, VoiceSessionID } from "./protocol"
import { post } from "./transport"
import { local } from "./destination"
import * as Live from "./mf-live"

type Entry = {
  info: typeof Info.Type
  mediaKey: string
  delegateID: (typeof Info.Type)["parentSessionID"]
  transcript: VoiceReconstructor
  failure?: typeof Failure.Type
  directory: string
  live?: Live.State
}

type Stored = Omit<typeof State.Type, "info"> & {
  info: Omit<typeof Info.Type, "controlToken"> & { controlToken?: string }
  delegateID: Entry["delegateID"]
  directory?: string
  live?: Live.State
}

type Deps = {
  sessions: Pick<Session.Interface, "create" | "get">
  prompts: Pick<SessionPrompt.Interface, "prompt" | "cancel">
  storage: Storage.Interface
  livekit?: {
    url: string
    key: string
    secret: string
  }
  inject?: (url: string, id: string, key: string, token: string, item: typeof ContextItem.Type) => Promise<void>
  openai?: Live.Service
  scope?: Scope.Scope
}

const key = (id: VoiceSessionID) => ["raya_voice", id]
const capability = () => randomBytes(32).toString("base64url")
const mediaKey = (value?: string) => (value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined)

export namespace RayaVoice {
  export class InputError extends Schema.TaggedErrorClass<InputError>()("RayaVoice.InputError", {
    message: Schema.String,
  }) {}

  export function make(deps: Deps) {
    const entries = new Map<VoiceSessionID, Entry>()
    const stopped = new Set<VoiceSessionID>()
    const jobs = new Map<VoiceSessionID, Fiber.Fiber<void, never>>()
    const busy = new Set<VoiceSessionID>()
    const controllers = new Map<VoiceSessionID, AbortController>()
    let opening = 0
    const capacity = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          for (const [id, entry] of entries) {
            if (entries.size + opening < 256) break
            if (["closed", "failed"].includes(entry.info.status) && !busy.has(id) && !jobs.has(id)) {
              entries.delete(id)
              stopped.delete(id)
            }
          }
          if (entries.size + opening >= 256)
            return yield* new InputError({ message: "Voice session ownership capacity is full." })
          opening++
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            opening--
          }),
      )
    const gates = new Map<VoiceSessionID, { semaphore: ReturnType<typeof Semaphore.makeUnsafe>; refs: number }>()
    const locked = <A, E, R>(id: VoiceSessionID, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const gate = gates.get(id) ?? { semaphore: Semaphore.makeUnsafe(1), refs: 0 }
          gate.refs++
          gates.set(id, gate)
          return gate
        }),
        (gate) => effect.pipe(gate.semaphore.withPermits(1)),
        (gate) =>
          Effect.sync(() => {
            gate.refs--
            if (gate.refs === 0 && gates.get(id) === gate) gates.delete(id)
          }),
      )
    const livekit = deps.livekit ?? {
      url: process.env.RAYA_LIVEKIT_URL || "ws://127.0.0.1:7880",
      key: process.env.RAYA_LIVEKIT_API_KEY || "devkey",
      secret: process.env.RAYA_LIVEKIT_API_SECRET || "secret",
    }
    const inject = deps.inject ?? post

    const token = (identity: string, room: string, publish: boolean) =>
      Effect.tryPromise({
        try: async () => {
          const access = new AccessToken(livekit.key, livekit.secret, { identity, ttl: "15m" })
          access.addGrant({
            roomJoin: true,
            room,
            canPublish: publish,
            canSubscribe: true,
            canPublishData: true,
          })
          return access.toJwt()
        },
        catch: (err) => err,
      }).pipe(Effect.orDie)

    const start = Effect.fn("RayaVoice.start")(function* (input: typeof Start.Type, key?: string) {
      const mediaURL = local(input.mediaURL)
      if (!mediaURL)
        return yield* new InputError({ message: "Voice media frontend must use a numeric loopback HTTP address." })
      const serviceKey = mediaKey(key)
      if (!serviceKey) return yield* new InputError({ message: "Voice media frontend requires a valid service key." })
      const live = input.engine === "openai-live"
      if (live && (input.version !== 2 || !deps.openai))
        return yield* new InputError({ message: "Canonical Live media binding is unavailable." })
      const parent = yield* deps.sessions.get(input.parentSessionID)
      const id = VoiceSessionID.make(`rvs_${crypto.randomUUID()}`)
      const room = input.room ?? id
      const delegate = live
        ? parent
        : yield* deps.sessions.create({
            parentID: parent.id,
            title: `Voice delegate ${new Date().toISOString()}`,
            agent: "voice",
            model: parent.model,
            metadata: { rayaVoiceSessionID: id },
          })
      const [clientToken, mediaToken] = yield* Effect.all(
        [token(`client-${id}`, room, true), token(`media-${id}`, room, true)],
        { concurrency: "unbounded" },
      )
      const info = {
        id,
        parentSessionID: input.parentSessionID,
        room,
        livekitURL: livekit.url,
        clientToken,
        mediaToken,
        controlToken: capability(),
        mediaURL,
        engine: live ? ("openai-live" as const) : ("qwen-realtime" as const),
        acceptsTruncation: false,
        status: "starting" as const,
        createdAt: Date.now(),
      }
      entries.set(id, {
        info,
        mediaKey: serviceKey,
        delegateID: delegate.id,
        transcript: new VoiceReconstructor(),
        directory: parent.directory,
        ...(live ? { live: { version: 1, secret: randomBytes(32).toString("hex") } } : {}),
      })
      yield* persist(entries.get(id)!)
      if (live && !(yield* Live.reserve(entries.get(id)!, deps.openai!, () => persist(entries.get(id)!))))
        return yield* new InputError({ message: "Live media provider admission was not confirmed." })
      if (!live)
        yield* deps.prompts
          .prompt({
            sessionID: delegate.id,
            parts: [
              {
                type: "text",
                text:
                  "<system-reminder>Warm the voice delegation prefix. Use no tools and reply only READY. " +
                  "Future turns must remain concise, grounded, read-only, and suitable for speech.</system-reminder>",
              },
            ],
          })
          .pipe(Effect.timeout("2 seconds"), Effect.ignore, Effect.forkDetach)
      return entries.get(id)!.info
    })

    const get = Effect.fn("RayaVoice.get")(function* (id: VoiceSessionID) {
      const entry = yield* resolve(id)
      if (!entry) return
      return state(entry)
    })

    const event = Effect.fn("RayaVoice.event")(function* (input: typeof Envelope.Type, proof?: string) {
      const entry = yield* resolve(input.session)
      if (!entry) return false
      if (entry.info.engine === "openai-live") {
        if (
          !proof ||
          !/^[A-Za-z0-9_-]{43}$/.test(proof) ||
          proof.length !== entry.info.controlToken.length ||
          !timingSafeEqual(Buffer.from(proof), Buffer.from(entry.info.controlToken))
        )
          return false
        if (input.event.type === "session.delegation.created" && !deps.scope) return false
        const accepted = yield* Live.event(
          entry,
          input,
          deps.openai,
          () => persist(entry),
          () => stopped.has(input.session),
        )
        yield* persist(entry)
        if (accepted && Live.pending(entry)) yield* collect(entry)
        return accepted
      }
      if (entry.info.status === "closed" || entry.info.status === "failed") return true
      entry.transcript.ingest(input.seq, input.event)
      if (input.event.type === "session.updated") entry.info = { ...entry.info, status: "active" }
      if (input.event.type === "engine.error") {
        entry.info = { ...entry.info, status: "failed" }
        entry.failure = Option.getOrElse(Schema.decodeUnknownOption(Failure)(input.event.data?.failure), () => ({
          code: "engine_failure" as const,
          message: "The voice engine reported a failure.",
          recovery: "Reconnect voice with the selected provider, or continue typing.",
          at: new Date().toISOString(),
        }))
      }
      yield* persist(entry)
      if (input.event.type === "delegation.request") {
        yield* delegate(entry, input).pipe(Effect.forkDetach)
      }
      return true
    })

    const close = Effect.fn("RayaVoice.close")(function* (id: VoiceSessionID) {
      const entry = yield* resolve(id)
      if (!entry) return false
      entry.info = { ...entry.info, status: "closed" }
      for (const task of Object.values(entry.live?.tasks ?? {})) {
        if (task.phase === "offered" && !task.ack) task.phase = "unknown"
      }
      if (entry.live?.binding && deps.openai)
        yield* deps.openai.close(
          entry.live.binding.id,
          entry.live.binding.generation,
          entry.live.secret,
          entry.directory,
        )
      if (!entry.live) yield* deps.prompts.cancel(entry.delegateID)
      yield* persist(entry)
      return true
    })

    const collect = Effect.fn("RayaVoice.collect")(function* (entry: Entry) {
      if (!deps.scope || !deps.openai || busy.has(entry.info.id) || stopped.has(entry.info.id)) return
      const id = entry.info.id
      const service = deps.openai
      const controller = new AbortController()
      controllers.set(id, controller)
      busy.add(id)
      const job = yield* Effect.gen(function* () {
        while (!stopped.has(id) && Live.pending(entry) && entry.info.status === "active") {
          const plan = yield* locked(
            id,
            Live.poll(
              entry,
              service,
              () => persist(entry),
              () => stopped.has(id),
            ),
          )
          if (plan) {
            yield* Effect.uninterruptibleMask((restore) =>
              restore(Live.deliver(plan, controller.signal, () => stopped.has(id))).pipe(
                Effect.flatMap((outcome) =>
                  locked(
                    id,
                    Live.delivered(
                      entry,
                      plan,
                      outcome,
                      () => persist(entry),
                      () => stopped.has(id),
                    ),
                  ),
                ),
              ),
            )
          }
          if (Live.pending(entry)) yield* Effect.sleep("100 millis")
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            jobs.delete(id)
            busy.delete(id)
            controller.abort()
            controllers.delete(id)
          }),
        ),
        Effect.forkIn(deps.scope),
      )
      if (busy.has(id)) jobs.set(id, job)
    })

    const persist = (entry: Entry) =>
      deps.storage
        .write(key(entry.info.id), {
          ...state(entry),
          delegateID: entry.delegateID,
          directory: entry.directory,
          ...(entry.live ? { live: entry.live } : {}),
        })
        .pipe(Effect.orDie)

    const resolve = Effect.fn("RayaVoice.resolve")(function* (id: VoiceSessionID) {
      const active = entries.get(id)
      if (active) return active
      const stored = yield* deps.storage.read<Stored>(key(id)).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (!stored?.delegateID) return
      if (entries.size + opening >= 256) return
      const saved = stored.info.controlToken
      const controlToken = saved && /^[A-Za-z0-9_-]{43}$/.test(saved) ? saved : capability()
      const entry: Entry = {
        info: { ...stored.info, controlToken },
        mediaKey: "",
        delegateID: stored.delegateID,
        transcript: new VoiceReconstructor(stored),
        failure: stored.failure,
        directory: stored.directory ?? "",
        live: stored.live,
      }
      entries.set(id, entry)
      if (stored.info.controlToken !== controlToken) yield* persist(entry)
      return entry
    })

    const state = (entry: Entry): typeof State.Type => ({
      info: entry.info,
      ...entry.transcript.state(),
      incomplete: !!entry.failure || entry.transcript.state().incomplete,
      failure: entry.failure,
    })

    const delegate = Effect.fn("RayaVoice.delegate")(function* (entry: Entry, input: typeof Envelope.Type) {
      const data = input.event.data ?? {}
      const call = typeof data.call === "string" ? data.call : crypto.randomUUID()
      const request = delegationRequest(input.event.text ?? "")
      const status = { done: false }
      const narration = setTimeout(() => {
        if (status.done) return
        void inject(entry.info.mediaURL, entry.info.id, entry.mediaKey, entry.info.controlToken, {
          id: crypto.randomUUID(),
          kind: "guidance",
          text: "I’m checking that now.",
          ttl: 1200,
          created: new Date().toISOString(),
        })
      }, 400)
      const result = yield* deps.prompts
        .prompt({
          sessionID: entry.delegateID,
          parts: [
            {
              type: "text",
              text:
                "<system-reminder>Answer this voice delegation directly. Use only read-only or reversible tools. " +
                "Return concise grounded text suitable for speech; never invent numbers.</system-reminder>\n\n" +
                request,
            },
          ],
        })
        .pipe(
          Effect.timeout("5 seconds"),
          Effect.map((message) =>
            message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
              .trim(),
          ),
          Effect.catch(() => Effect.succeed("I couldn’t complete that check in time.")),
        )
      status.done = true
      clearTimeout(narration)
      yield* Effect.tryPromise({
        try: () =>
          inject(entry.info.mediaURL, entry.info.id, entry.mediaKey, entry.info.controlToken, {
            id: crypto.randomUUID(),
            kind: "delegation.result",
            text: result || "I couldn’t find a grounded answer.",
            call,
            ttl: 5000,
            created: new Date().toISOString(),
          }),
        catch: (err) => err,
      }).pipe(Effect.orDie)
    })

    return {
      start: (input: typeof Start.Type, key?: string) => capacity(start(input, key)),
      get: (id: VoiceSessionID) => locked(id, get(id)),
      event: (input: typeof Envelope.Type, proof?: string) => locked(input.session, event(input, proof)),
      close: (id: VoiceSessionID) =>
        Effect.sync(() => {
          stopped.add(id)
          controllers.get(id)?.abort()
        }).pipe(
          Effect.andThen(locked(id, close(id))),
          Effect.tap(() => {
            const job = jobs.get(id)
            return (job ? Fiber.interrupt(job) : Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  stopped.delete(id)
                }),
              ),
            )
          }),
        ),
    }
  }
}

function delegationRequest(value: string) {
  try {
    const parsed = JSON.parse(value) as { request?: unknown }
    if (typeof parsed.request === "string" && parsed.request.trim()) return parsed.request
  } catch {
    return value // raya_change - malformed vendor arguments remain useful as plain delegation text.
  }
  return value
}

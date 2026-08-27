// raya_change - Async voice plane: session admission, transcript truth, and reactive delegation.
import { Effect } from "effect"
import { AccessToken } from "livekit-server-sdk"
import type { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import type { Storage } from "@/storage/storage"
import { VoiceReconstructor } from "./reconstructor"
import { ContextItem, type Envelope, type Info, type Start, type State, VoiceSessionID } from "./protocol"

type Entry = {
  info: typeof Info.Type
  delegateID: (typeof Info.Type)["parentSessionID"]
  transcript: VoiceReconstructor
}

type Stored = typeof State.Type & { delegateID: Entry["delegateID"] }

type Deps = {
  sessions: Pick<Session.Interface, "create" | "get">
  prompts: Pick<SessionPrompt.Interface, "prompt" | "cancel">
  storage: Storage.Interface
  livekit?: {
    url: string
    key: string
    secret: string
  }
  inject?: (url: string, id: string, item: typeof ContextItem.Type) => Promise<void>
}

const key = (id: VoiceSessionID) => ["raya_voice", id]

export namespace RayaVoice {
  export function make(deps: Deps) {
    const entries = new Map<VoiceSessionID, Entry>()
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

    const start = Effect.fn("RayaVoice.start")(function* (input: typeof Start.Type) {
      const parent = yield* deps.sessions.get(input.parentSessionID)
      const id = VoiceSessionID.make(`rvs_${crypto.randomUUID()}`)
      const room = input.room ?? id
      const delegate = yield* deps.sessions.create({
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
        mediaURL: input.mediaURL,
        engine: "qwen-realtime" as const,
        acceptsTruncation: false,
        status: "starting" as const,
        createdAt: Date.now(),
      }
      entries.set(id, { info, delegateID: delegate.id, transcript: new VoiceReconstructor() })
      yield* persist(entries.get(id)!)
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
        .pipe(
          Effect.timeout("2 seconds"),
          Effect.ignore,
          Effect.forkDetach,
        )
      return info
    })

    const get = Effect.fn("RayaVoice.get")(function* (id: VoiceSessionID) {
      const entry = yield* resolve(id)
      if (!entry) return
      return state(entry)
    })

    const event = Effect.fn("RayaVoice.event")(function* (input: typeof Envelope.Type) {
      const entry = yield* resolve(input.session)
      if (!entry) return false
      entry.transcript.ingest(input.seq, input.event)
      if (input.event.type === "session.updated") entry.info = { ...entry.info, status: "active" }
      if (input.event.type === "engine.error") entry.info = { ...entry.info, status: "failed" }
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
      yield* deps.prompts.cancel(entry.delegateID)
      yield* persist(entry)
      return true
    })

    const persist = (entry: Entry) =>
      deps.storage.write(key(entry.info.id), { ...state(entry), delegateID: entry.delegateID }).pipe(Effect.orDie)

    const resolve = Effect.fn("RayaVoice.resolve")(function* (id: VoiceSessionID) {
      const active = entries.get(id)
      if (active) return active
      const stored = yield* deps.storage
        .read<Stored>(key(id))
        .pipe(
          Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
          Effect.orDie,
        )
      if (!stored?.delegateID) return
      const entry = {
        info: stored.info,
        delegateID: stored.delegateID,
        transcript: new VoiceReconstructor(stored),
      }
      entries.set(id, entry)
      return entry
    })

    const state = (entry: Entry): typeof State.Type => ({
      info: entry.info,
      ...entry.transcript.state(),
    })

    const delegate = Effect.fn("RayaVoice.delegate")(function* (entry: Entry, input: typeof Envelope.Type) {
      const data = input.event.data ?? {}
      const call = typeof data.call === "string" ? data.call : crypto.randomUUID()
      const request = delegationRequest(input.event.text ?? "")
      const status = { done: false }
      const narration = setTimeout(() => {
        if (status.done) return
        void inject(entry.info.mediaURL, entry.info.id, {
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
          inject(entry.info.mediaURL, entry.info.id, {
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

    return { start, get, event, close }
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

async function post(url: string, id: string, item: typeof ContextItem.Type) {
  const response = await fetch(`${url.replace(/\/$/, "")}/v1/sessions/${id}/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item }),
    signal: AbortSignal.timeout(1000),
  })
  if (!response.ok) throw new Error(`Media injection failed with status ${response.status}`)
}

import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaVoice } from "@/kilocode/voice/service"
import { VoiceSessionID, type Envelope, type State } from "@/kilocode/voice/protocol"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))
function fixture(id: VoiceSessionID) {
  return {
    info: {
      id,
      parentSessionID: SessionID.make("ses_voiceparent"),
      room: id,
      livekitURL: "ws://unused.invalid",
      clientToken: "synthetic",
      mediaToken: "synthetic",
      mediaURL: "http://unused.invalid",
      engine: "qwen-realtime" as const,
      acceptsTruncation: false,
      status: "starting" as const,
      createdAt: 0,
    },
    delegateID: SessionID.make("ses_voicedelegate"),
    lastSeq: 0,
    incomplete: false,
    turns: [],
  }
}
function service(storage: Storage.Interface) {
  return RayaVoice.make({
    storage,
    sessions: {
      create: () => Effect.die("unexpected voice session creation"),
      get: () => Effect.die("unexpected parent lookup"),
    },
    prompts: { prompt: () => Effect.die("unexpected work dispatch"), cancel: () => Effect.void },
  })
}
function event(
  session: VoiceSessionID,
  seq: number,
  type: string,
  data?: (typeof Envelope.Type)["event"]["data"],
): typeof Envelope.Type {
  return {
    session,
    seq,
    event: { seq, type, data, at: new Date(0).toISOString(), text: "synthetic secret provider payload" },
  }
}

it.live("persists first voice failure across restart, closure and late events", () =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const id = VoiceSessionID.make(`rvs_${crypto.randomUUID()}`)
    yield* storage.write(["raya_voice", id], fixture(id))
    const voice = service(storage)
    const failure = {
      code: "audio_publish",
      message: "Audio playback failed.",
      recovery: "Reconnect with the selected provider, or continue typing.",
      at: new Date(0).toISOString(),
    }
    expect(yield* voice.event(event(id, 1, "engine.error", { failure }))).toBe(true)
    yield* voice.event(event(id, 2, "session.updated"))
    yield* voice.event(event(id, 3, "engine.error", { failure: { ...failure, code: "audio_input" } }))
    yield* voice.event(event(id, 4, "delegation.request"))
    const restored = service(storage)
    expect(yield* restored.get(id)).toMatchObject({ info: { status: "failed" }, failure, incomplete: true, lastSeq: 1 })
    yield* restored.close(id)
    yield* restored.event(event(id, 5, "session.updated"))
    expect(yield* service(storage).get(id)).toMatchObject({
      info: { status: "closed" },
      failure,
      incomplete: true,
      lastSeq: 1,
    })
    const saved = yield* storage.read<typeof State.Type>(["raya_voice", id])
    expect(JSON.stringify(saved)).not.toContain("synthetic secret provider payload")
    const other = VoiceSessionID.make(`rvs_${crypto.randomUUID()}`)
    yield* storage.write(["raya_voice", other], fixture(other))
    yield* restored.event(event(id, 6, "engine.error"))
    expect((yield* restored.get(other))?.info.status).toBe("starting")
  }),
)

it.live("legacy provider errors use generic recovery without retaining raw payloads", () =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const id = VoiceSessionID.make(`rvs_${crypto.randomUUID()}`)
    yield* storage.write(["raya_voice", id], fixture(id))
    const voice = service(storage)
    yield* voice.event(event(id, 1, "engine.error", { failure: { code: "unknown", message: "secret" } }))
    const saved = yield* service(storage).get(id)
    expect(saved?.failure).toMatchObject({ code: "engine_failure", message: "The voice engine reported a failure." })
    expect(JSON.stringify(saved)).not.toContain("secret")
  }),
)

it.live("an older in-flight event write cannot overwrite a later terminal failure", () =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const id = VoiceSessionID.make(`rvs_${crypto.randomUUID()}`)
    yield* storage.write(["raya_voice", id], fixture(id))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const state = { held: false }
    const voice = service({
      ...storage,
      write: (key, value) =>
        Effect.gen(function* () {
          if (!state.held) {
            state.held = true
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }
          yield* storage.write(key, value)
        }),
    })
    const first = yield* voice.event(event(id, 1, "session.updated")).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const second = yield* voice.event(event(id, 2, "engine.error")).pipe(Effect.forkChild)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    expect((yield* service(storage).get(id))?.info.status).toBe("failed")
  }),
)

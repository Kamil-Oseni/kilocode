import { expect, test } from "bun:test"
import { Room, RoomEvent } from "livekit-client"
import { RealtimeVoice, type RealtimeConnection } from "../../webview-ui/src/context/realtime-voice"

function connection(id: string): RealtimeConnection {
  return {
    id,
    livekitURL: "ws://unused.invalid",
    clientToken: "synthetic",
    engine: "qwen-realtime",
    acceptsTruncation: false,
  }
}

function fixture(connect?: (index: number) => Promise<void>) {
  const rooms: Room[] = []
  const statuses: string[] = []
  const errors: string[] = []
  const fallback: string[] = []
  const calls = { disconnected: 0, disabled: 0 }
  const voice = new RealtimeVoice(
    {
      status: (value) => statuses.push(value),
      error: (value) => errors.push(value),
      fallback: (value) => fallback.push(value),
      transcript: () => {},
      aec: () => {},
    },
    (options) => {
      const room = new Room(options)
      room.connect = async () => {
        await connect?.(rooms.indexOf(room))
      }
      room.startAudio = async () => {}
      room.localParticipant.setMicrophoneEnabled = async (enabled) => {
        if (!enabled) calls.disabled++
        return undefined
      }
      room.disconnect = async () => {
        calls.disconnected++
        room.emit(RoomEvent.Disconnected)
      }
      rooms.push(room)
      return room
    },
  )
  return { voice, rooms, statuses, errors, fallback, calls }
}

function failure(room: Room, id: string) {
  room.emit(
    RoomEvent.DataReceived,
    new TextEncoder().encode(
      JSON.stringify({
        type: "failure",
        session: id,
        failure: {
          code: "audio_publish",
          message: "Audio playback failed.",
          recovery: "Reconnect with the selected provider, or continue typing.",
        },
      }),
    ),
    undefined,
    undefined,
    "raya.control",
  )
}

async function settled(check: () => boolean) {
  for (let count = 0; count < 50 && !check(); count++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test("current media failures release capture and show recovery without changing provider", async () => {
  const run = fixture()
  await run.voice.start(connection("current"))
  failure(run.rooms[0]!, "different")
  expect(run.errors).toEqual([])
  failure(run.rooms[0]!, "current")
  await settled(() => run.statuses.at(-1) === "degraded")
  expect(run.calls).toEqual({ disconnected: 1, disabled: 1 })
  expect(run.errors).toEqual(["Audio playback failed. Reconnect with the selected provider, or continue typing."])
  expect(run.fallback).toEqual([])
  await run.voice.stop()
})

test("late data and disconnect events from an old room cannot stop its replacement", async () => {
  const run = fixture()
  await run.voice.start(connection("old"))
  const old = run.rooms[0]!
  await run.voice.start(connection("new"))
  const count = run.calls.disconnected
  failure(old, "new")
  old.emit(RoomEvent.Disconnected)
  old.emit(RoomEvent.Reconnecting)
  await Bun.sleep(10)
  expect(run.statuses.at(-1)).toBe("listening")
  expect(run.calls.disconnected).toBe(count)
  expect(run.errors).toEqual([])
  expect(run.fallback).toEqual([])
  await run.voice.stop()
})

test("disconnect is attempted even when microphone cleanup fails", async () => {
  const run = fixture()
  await run.voice.start(connection("current"))
  run.rooms[0]!.localParticipant.setMicrophoneEnabled = async () => {
    throw new Error("secret device internals")
  }
  failure(run.rooms[0]!, "current")
  await settled(() => run.statuses.at(-1) === "degraded")
  expect(run.calls.disconnected).toBe(1)
  expect(run.errors.at(-1)).toContain("cleanup failed")
  expect(JSON.stringify(run.errors)).not.toContain("secret device internals")
  expect(run.fallback).toEqual([])
})

test("terminal disconnect offers reconnect or typing and malformed packets do not throw", async () => {
  const run = fixture()
  await run.voice.start(connection("current"))
  const room = run.rooms[0]!
  for (const raw of ["{", "null", "[]"]) {
    room.emit(RoomEvent.DataReceived, new TextEncoder().encode(raw), undefined, undefined, "raya.control")
  }
  room.emit(RoomEvent.Disconnected)
  await settled(() => run.statuses.at(-1) === "degraded")
  expect(run.errors[0]).toContain("Reconnect with the selected provider")
  expect(run.fallback).toEqual([])
})

test("a superseded connection rejection cannot escape and stop the replacement", async () => {
  const waiting = Promise.withResolvers<void>()
  const run = fixture((index) => (index === 0 ? waiting.promise : Promise.resolve()))
  const pending = run.voice.start(connection("old"))
  await settled(() => run.rooms.length === 1)
  await run.voice.start(connection("new"))
  waiting.reject(new Error("old connection failed"))
  await pending
  expect(run.statuses.at(-1)).toBe("listening")
  expect(run.errors).toEqual([])
  expect(run.fallback).toEqual([])
  await run.voice.stop()
})

test("a superseded playout flush rejection cannot stop the replacement", async () => {
  const run = fixture()
  await run.voice.start(connection("old"))
  const waiting = Promise.withResolvers<void>()
  // Hold the audio adapter at its asynchronous flush boundary while the real
  // Room event handler replaces the owning voice connection.
  Object.assign(run.voice, { playout: { flush: () => waiting.promise, stop: async () => {} } })
  run.rooms[0]!.emit(
    RoomEvent.DataReceived,
    new TextEncoder().encode(JSON.stringify({ type: "discontinuity" })),
    undefined,
    undefined,
    "raya.control",
  )
  await run.voice.start(connection("new"))
  waiting.reject(new Error("old playout failed"))
  await Bun.sleep(10)
  expect(run.statuses.at(-1)).toBe("listening")
  expect(run.errors).toEqual([])
  expect(run.fallback).toEqual([])
  await run.voice.stop()
})

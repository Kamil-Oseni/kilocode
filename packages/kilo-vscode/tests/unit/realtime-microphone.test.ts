import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { ConnectionState, LocalTrackPublication, Room, RoomEvent, Track } from "livekit-client"
import { RealtimeVoice, type RealtimeConnection } from "../../webview-ui/src/context/realtime-voice"

import { Native, Stream, publication } from "../fixtures/realtime-media"

const connection: RealtimeConnection = {
  id: "microphone-test",
  livekitURL: "ws://127.0.0.1:7880",
  clientToken: "synthetic-network-boundary",
  engine: "openai-live",
  acceptsTruncation: false,
}

function fixture() {
  const room = new Room()
  const audio = publication()
  const stats = { connects: 0, disconnects: 0, enables: 0, disables: 0 }
  const states: string[] = []
  const errors: string[] = []
  const aec: boolean[] = []
  let returned: LocalTrackPublication | undefined = audio.pub
  const install = (pub: LocalTrackPublication) => {
    room.localParticipant.trackPublications.clear()
    room.localParticipant.audioTrackPublications.clear()
    room.localParticipant.trackPublications.set(pub.trackSid, pub)
    room.localParticipant.audioTrackPublications.set(pub.trackSid, pub)
  }
  install(audio.pub)
  room.connect = async () => {
    stats.connects++
    room.state = ConnectionState.Connected
  }
  room.startAudio = async () => {}
  room.disconnect = async () => {
    stats.disconnects++
    room.state = ConnectionState.Disconnected
  }
  room.localParticipant.setMicrophoneEnabled = async (enabled) => {
    if (enabled) {
      stats.enables++
      return returned
    }
    stats.disables++
    await room.localParticipant.getTrackPublication(Track.Source.Microphone)?.mute()
    return returned
  }
  const voice = new RealtimeVoice(
    {
      status: (value) => states.push(value),
      aec: (value) => aec.push(value),
      error: (value) => errors.push(value),
      fallback: (value) => errors.push(value),
      transcript: () => {},
    },
    () => room,
  )
  const control = () =>
    room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(JSON.stringify({ type: "discontinuity" })),
      undefined,
      undefined,
      "raya.control",
    )
  return {
    room,
    audio,
    stats,
    states,
    errors,
    aec,
    voice,
    install,
    control,
    returned: (pub?: LocalTrackPublication) => (returned = pub),
  }
}

describe("owned realtime microphone availability", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const active: RealtimeVoice[] = []
  let next: Native
  let captures = 0
  beforeEach(() => {
    captures = 0
    next = new Native()
    for (const key of ["MediaStream", "navigator"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: Stream })
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            captures++
            return new Stream([next as unknown as MediaStreamTrack])
          },
        },
      },
    })
  })
  afterEach(async () => {
    for (const voice of active.splice(0)) await voice.stop()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    saved.clear()
  })
  const create = () => {
    const value = fixture()
    active.push(value.voice)
    return value
  }

  for (const mode of ["missing", "ended", "disabled", "muted", "foreign"] as const)
    it(`refuses an initial ${mode} publication without claiming listening`, async () => {
      const value = create()
      if (mode === "missing") value.returned()
      if (mode === "ended") value.audio.native.stop()
      if (mode === "disabled") {
        const enable = value.room.localParticipant.setMicrophoneEnabled.bind(value.room.localParticipant)
        value.room.localParticipant.setMicrophoneEnabled = async (...args) => {
          const pub = await enable(...args)
          // SDK construction can enable its source asynchronously. The boundary
          // under test is the disabled source actually returned by enable.
          if (args[0]) value.audio.native.enabled = false
          return pub
        }
      }
      if (mode === "muted") value.audio.native.mute(true)
      if (mode === "foreign") value.returned(publication().pub)
      await expect(value.voice.start(connection)).rejects.toMatchObject({ name: "MicrophoneUnavailableError" })
      expect(value.states).not.toContain("listening")
      expect(value.aec.at(-1)).toBe(false)
      expect(captures).toBe(0)
    })

  it("keeps mute and reconnect projections degraded until the exact native microphone recovers", async () => {
    const value = create()
    await value.voice.start(connection)
    expect(value.states.at(-1)).toBe("listening")
    value.audio.native.mute(true)
    expect(value.states.at(-1)).toBe("degraded")
    expect(value.aec.at(-1)).toBe(false)
    value.room.emit(RoomEvent.Reconnected)
    value.control()
    expect(value.states.at(-1)).toBe("degraded")
    value.audio.native.mute(false)
    expect(value.states.at(-1)).toBe("listening")
    expect(value.aec.at(-1)).toBe(true)
    expect(value.stats.connects).toBe(1)
    expect(captures).toBe(0)
  })

  it("uses the actual SDK restart without reopening the provider or accepting old native events", async () => {
    const value = create()
    await value.voice.start(connection)
    value.audio.native.stop()
    expect(value.states.at(-1)).toBe("degraded")
    await value.audio.track.restartTrack()
    expect(value.audio.track.mediaStreamTrack).toBe(next)
    expect(value.states.at(-1)).toBe("listening")
    value.audio.native.mute(true)
    expect(value.states.at(-1)).toBe("listening")
    expect(captures).toBe(1)
    expect(value.stats.connects).toBe(1)
    expect(value.stats.enables).toBe(1)
    expect(value.stats.disconnects).toBe(0)
  })

  it("observes actual SDK mute and unmute without treating a foreign participant as the microphone owner", async () => {
    const value = create()
    await value.voice.start(connection)
    await value.audio.pub.mute()
    value.room.emit(RoomEvent.TrackMuted, value.audio.pub, value.room.localParticipant)
    expect(value.states.at(-1)).toBe("degraded")
    expect(value.aec.at(-1)).toBe(false)
    value.control()
    expect(value.states.at(-1)).toBe("degraded")
    await value.audio.pub.unmute()
    value.room.emit(RoomEvent.TrackUnmuted, value.audio.pub, value.room.localParticipant)
    expect(value.states.at(-1)).toBe("listening")
    const length = value.states.length
    value.room.emit(RoomEvent.TrackMuted, value.audio.pub, new Room().localParticipant)
    expect(value.states.length).toBe(length)
    expect(value.stats.connects).toBe(1)
    expect(captures).toBe(0)
  })

  it("rechecks the actual SDK publication lookup after reconnection even without an unpublish callback", async () => {
    const value = create()
    await value.voice.start(connection)
    value.room.localParticipant.trackPublications.clear()
    value.room.localParticipant.audioTrackPublications.clear()
    value.room.emit(RoomEvent.Reconnected)
    expect(value.states.at(-1)).toBe("degraded")
    expect(value.aec.at(-1)).toBe(false)
    const replacement = publication()
    value.install(replacement.pub)
    value.room.emit(RoomEvent.Reconnected)
    expect(value.states.at(-1)).toBe("listening")
    expect(value.aec.at(-1)).toBe(true)
    expect(value.stats.connects).toBe(1)
  })

  it("requires the currently published microphone and ignores retired publication events", async () => {
    const value = create()
    await value.voice.start(connection)
    value.room.localParticipant.trackPublications.clear()
    value.room.localParticipant.audioTrackPublications.clear()
    value.room.emit(RoomEvent.LocalTrackUnpublished, value.audio.pub, value.room.localParticipant)
    expect(value.states.at(-1)).toBe("degraded")
    value.control()
    expect(value.states.at(-1)).toBe("degraded")
    const replacement = publication()
    value.install(replacement.pub)
    value.room.emit(RoomEvent.LocalTrackPublished, replacement.pub, value.room.localParticipant)
    expect(value.states.at(-1)).toBe("listening")
    value.audio.native.stop()
    value.room.emit(RoomEvent.TrackMuted, value.audio.pub, value.room.localParticipant)
    expect(value.states.at(-1)).toBe("listening")
    expect(value.aec.at(-1)).toBe(true)
    expect(value.stats.connects).toBe(1)
  })

  it("sanitizes owned device failure and detaches stale microphone observers on Stop", async () => {
    const value = create()
    await value.voice.start(connection)
    const err = new Error("private-device-id / private-token")
    value.room.emit(RoomEvent.MediaDevicesError, err, "audioinput")
    await value.voice.stop()
    expect(value.errors.length).toBe(1)
    expect(value.errors.join(" ")).not.toContain("private-device-id")
    expect(value.errors.join(" ")).not.toContain("private-token")
    expect(value.aec.at(-1)).toBe(false)
    const length = value.states.length
    value.audio.native.mute(true)
    value.room.emit(RoomEvent.MediaDevicesError, err, "audioinput")
    value.room.emit(RoomEvent.Reconnected)
    expect(value.states.length).toBe(length)
    expect(value.errors.length).toBe(1)
    expect(captures).toBe(0)
  })

  it("ends unavailable source recovery after the actual ten-second deadline without reopening capture", async () => {
    const value = create()
    await value.voice.start(connection)
    const ended = Promise.withResolvers<string>()
    const error = value.errors.push.bind(value.errors)
    value.errors.push = (...messages) => {
      ended.resolve(messages[0]!)
      return error(...messages)
    }
    const started = performance.now()
    value.room.localParticipant.trackPublications.clear()
    value.room.localParticipant.audioTrackPublications.clear()
    value.room.emit(RoomEvent.LocalTrackUnpublished, value.audio.pub, value.room.localParticipant)
    expect(value.states.at(-1)).toBe("degraded")
    expect(value.aec.at(-1)).toBe(false)
    expect(value.errors).toHaveLength(0)
    const message = await ended.promise
    expect(performance.now() - started).toBeGreaterThanOrEqual(9_900)
    expect(message).toContain("microphone")
    expect(message).not.toContain(connection.clientToken)
    await value.voice.stop()
    expect(value.room.state).toBe(ConnectionState.Disconnected)
    expect(value.stats.connects).toBe(1)
    expect(value.stats.enables).toBe(1)
    expect(captures).toBe(0)
    const length = value.states.length
    const errors = value.errors.length
    value.audio.native.mute(true)
    value.room.emit(RoomEvent.Reconnected)
    value.room.emit(RoomEvent.LocalTrackPublished, value.audio.pub, value.room.localParticipant)
    expect(value.states.length).toBe(length)
    expect(value.errors.length).toBe(errors)
  }, 15_000)

  for (const stage of ["input", "output", "publication"] as const)
    it(`preserves the ${stage} error stage without misclassifying microphone capture`, async () => {
      const value = create()
      const err =
        stage === "publication"
          ? new Error("signaling publication failed")
          : new DOMException("private-device-id", "NotAllowedError")
      if (stage === "input")
        value.room.localParticipant.setMicrophoneEnabled = async (enabled) => {
          if (enabled) throw err
          return value.audio.pub
        }
      if (stage === "output")
        value.room.startAudio = async () => {
          throw err
        }
      if (stage === "publication")
        value.room.localParticipant.setMicrophoneEnabled = async (enabled) => {
          if (enabled) throw err
          return value.audio.pub
        }
      const result = await value.voice.start(connection).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(result).toBeInstanceOf(Error)
      if (stage === "input") {
        expect(result).toMatchObject({ name: "MicrophoneUnavailableError" })
        expect((result as Error).message).toContain("microphone access")
        expect((result as Error).message).not.toContain("private-device-id")
      }
      if (stage === "output") {
        expect(result).toBe(err)
        expect(value.stats.enables).toBe(0)
      }
      if (stage === "publication") expect(result).toBe(err)
      expect(value.states).not.toContain("listening")
      expect(captures).toBe(0)
    })
})

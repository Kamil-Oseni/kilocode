import { LocalAudioTrack, LocalTrackPublication, Track } from "livekit-client"

// Only browser capture and network connection are synthetic. Publication lookup,
// SDK mute/restart, event dispatch and RealtimeVoice ownership are production code.
export class Native extends EventTarget {
  readonly id = crypto.randomUUID()
  readonly kind = "audio"
  readonly label = "synthetic microphone"
  enabled = true
  muted = false
  readyState: MediaStreamTrackState = "live"
  getSettings() {
    return { echoCancellation: true }
  }
  getConstraints() {
    return {}
  }
  getCapabilities() {
    return {}
  }
  applyConstraints() {
    return Promise.resolve()
  }
  stop() {
    this.readyState = "ended"
    this.dispatchEvent(new Event("ended"))
  }
  mute(value: boolean) {
    this.muted = value
    this.dispatchEvent(new Event(value ? "mute" : "unmute"))
  }
}

export class Stream extends EventTarget {
  readonly id = crypto.randomUUID()
  constructor(private tracks: MediaStreamTrack[]) {
    super()
  }
  getTracks() {
    return [...this.tracks]
  }
  getAudioTracks() {
    return this.getTracks()
  }
  getVideoTracks() {
    return []
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track)
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((value) => value !== track)
  }
}

export function publication(native = new Native()) {
  const track = new LocalAudioTrack(native as unknown as MediaStreamTrack, {}, true)
  track.source = Track.Source.Microphone
  const sid = crypto.randomUUID()
  // Decoded SFU metadata boundary, without a transport or provider.
  const info = { sid, name: "microphone", source: 2, mimeType: "audio/opus" } as ConstructorParameters<
    typeof LocalTrackPublication
  >[1]
  const pub = new LocalTrackPublication(Track.Kind.Audio, info, track)
  return { native, track, pub }
}


// raya_change - Testable webview sink for streamed MiniMax PCM and encoded speech.
export class StreamPlayer {
  private audio: HTMLAudioElement | undefined
  private source: MediaSource | undefined
  private buffer: SourceBuffer | undefined
  private queue: Uint8Array[] = []
  private context: AudioContext | undefined
  private nodes = new Set<AudioBufferSourceNode>()
  private output: AudioNode | undefined
  private bridge:
    | {
        sink: MediaStreamAudioDestinationNode
        audio: HTMLAudioElement
        send: RTCPeerConnection
        receive: RTCPeerConnection
      }
    | undefined
  private bridging = false
  private next = 0
  private began: number | undefined
  private ending = false

  constructor(
    private readonly done: () => void,
    private readonly fail: (error: string) => void,
  ) {}

  unlock() {
    const context = this.context ?? new AudioContext()
    this.context = context
    this.output ??= context.destination
    if (!this.bridging && !this.bridge)
      void this.connect(context).catch((err: unknown) => {
        this.closeBridge()
        this.output = context.destination
        console.warn("[Raya Voice] WebRTC echo reference unavailable; using direct audio output.", err)
      })
    void context.resume().catch((err: unknown) => this.fail(err instanceof Error ? err.message : String(err)))
  }

  push(data: string, mime: string) {
    const bytes = decode(data)
    if (mime.startsWith("audio/pcm")) {
      this.pcm(bytes, Number(mime.match(/rate=(\d+)/)?.[1]) || 16_000)
      return
    }
    this.queue.push(bytes)
    if (!this.source) this.open(mime)
    this.flush()
  }

  finish() {
    this.ending = true
    if (this.context && this.nodes.size === 0) {
      this.settle()
      return
    }
    this.flush()
  }

  elapsed() {
    if (!this.context || this.began === undefined) return 0
    return Math.max(0, this.context.currentTime - this.began)
  }

  stop(notify = true) {
    this.reset()
    this.closeBridge()
    this.output = undefined
    void this.context?.close()
    this.context = undefined
    if (notify) this.done()
  }

  // raya_change - preserve the user-gesture-unlocked AudioContext between streamed voice turns
  reset() {
    this.ending = false
    for (const node of this.nodes) node.stop()
    this.nodes.clear()
    this.next = 0
    this.began = undefined
    this.audio?.pause()
    if (this.audio?.src) URL.revokeObjectURL(this.audio.src)
    this.audio = undefined
    this.source = undefined
    this.buffer = undefined
    this.queue = []
  }

  private pcm(bytes: Uint8Array, rate: number) {
    this.unlock()
    const context = this.context
    if (!context) return
    const count = Math.floor(bytes.byteLength / 2)
    if (count === 0) return
    const audio = context.createBuffer(1, count, rate)
    const channel = audio.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let index = 0; index < count; index++) channel[index] = view.getInt16(index * 2, true) / 32_768
    const node = context.createBufferSource()
    node.buffer = audio
    node.connect(this.output ?? context.destination)
    const start = Math.max(context.currentTime + 0.01, this.next)
    this.began ??= start
    this.next = start + audio.duration
    this.nodes.add(node)
    node.addEventListener(
      "ended",
      () => {
        this.nodes.delete(node)
        if (this.ending && this.nodes.size === 0) this.settle()
      },
      { once: true },
    )
    node.start(start)
  }

  // raya_change start - present local MiniMax PCM as remote WebRTC playout so Chromium AEC has a reference
  private async connect(context: AudioContext) {
    if (typeof RTCPeerConnection === "undefined" || typeof context.createMediaStreamDestination !== "function") return
    this.bridging = true
    const sink = context.createMediaStreamDestination()
    const send = new RTCPeerConnection()
    const receive = new RTCPeerConnection()
    const audio = new Audio()
    audio.autoplay = true
    this.bridge = { sink, audio, send, receive }
    receive.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
    }
    const track = sink.stream.getAudioTracks()[0]
    if (!track) {
      this.closeBridge()
      return
    }
    send.addTrack(track, sink.stream)
    const offer = await send.createOffer()
    await send.setLocalDescription(offer)
    await gathered(send)
    if (!send.localDescription) throw new Error("WebRTC echo sender did not produce a local description.")
    await receive.setRemoteDescription(send.localDescription)
    const answer = await receive.createAnswer()
    await receive.setLocalDescription(answer)
    await gathered(receive)
    if (!receive.localDescription) throw new Error("WebRTC echo receiver did not produce a local description.")
    await send.setRemoteDescription(receive.localDescription)
    await connected(send, receive)
    await audio.play()
    if (this.context !== context) {
      this.closeBridge()
      return
    }
    this.output = sink
    this.bridging = false
  }

  private closeBridge() {
    const bridge = this.bridge
    this.bridge = undefined
    this.bridging = false
    bridge?.audio.pause()
    if (bridge?.audio.srcObject) bridge.audio.srcObject = null
    bridge?.send.close()
    bridge?.receive.close()
    bridge?.sink.disconnect()
  }
  // raya_change end

  private open(mime: string) {
    if (!MediaSource.isTypeSupported(mime)) {
      this.fail(`Streaming speech MIME type is unsupported: ${mime}`)
      return this.stop()
    }
    const source = new MediaSource()
    const audio = new Audio(URL.createObjectURL(source))
    this.source = source
    this.audio = audio
    source.addEventListener(
      "sourceopen",
      () => {
        const buffer = source.addSourceBuffer(mime)
        this.buffer = buffer
        buffer.addEventListener("updateend", () => this.flush())
        void audio.play().catch((err: unknown) => this.fail(err instanceof Error ? err.message : String(err)))
        this.flush()
      },
      { once: true },
    )
  }

  private flush() {
    const source = this.source
    const buffer = this.buffer
    if (!source || !buffer || buffer.updating) return
    const chunk = this.queue.shift()
    if (chunk) {
      const copy = new Uint8Array(chunk.byteLength)
      copy.set(chunk)
      buffer.appendBuffer(copy.buffer)
      return
    }
    if (!this.ending || source.readyState !== "open") return
    source.endOfStream()
    this.audio?.addEventListener("ended", () => this.settle(), { once: true })
  }

  // raya_change - completed turns keep the gesture-authorized sink alive for the next reply
  private settle() {
    this.reset()
    this.done()
  }
}

function decode(value: string) {
  const raw = atob(value)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes
}

function gathered(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return Promise.resolve()
  return new Promise<void>((resolve) => {
    const change = () => {
      if (peer.iceGatheringState !== "complete") return
      peer.removeEventListener("icegatheringstatechange", change)
      resolve()
    }
    peer.addEventListener("icegatheringstatechange", change)
  })
}

function connected(...peers: RTCPeerConnection[]) {
  if (peers.every((peer) => peer.connectionState === "connected")) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("WebRTC echo reference connection timed out.")), 2_000)
    const change = () => {
      if (!peers.every((peer) => peer.connectionState === "connected")) return
      finish()
    }
    const finish = (error?: Error) => {
      window.clearTimeout(timer)
      for (const peer of peers) peer.removeEventListener("connectionstatechange", change)
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    for (const peer of peers) peer.addEventListener("connectionstatechange", change)
  })
}

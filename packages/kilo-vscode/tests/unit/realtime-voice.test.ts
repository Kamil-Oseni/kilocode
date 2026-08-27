// raya_change - Thin-client measured playout and composer-isolation contracts.
import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { PlayoutCursor } from "../../webview-ui/src/context/realtime-voice"
import { StreamPlayer } from "../../webview-ui/src/context/stream-player"
import { EchoGate } from "../../webview-ui/src/components/speech-to-text/echo-gate"

describe("realtime voice thin client", () => {
  it("counts measured destination samples and resets on discontinuity", () => {
    const cursor = new PlayoutCursor()
    cursor.advance(2400, "assistant-1")
    cursor.advance(1200)
    expect(cursor.samples).toBe(3600)
    expect(cursor.milliseconds(24000)).toBe(150)
    cursor.reset()
    expect(cursor.samples).toBe(0)
  })

  it("keeps the gesture-unlocked audio sink for the first MiniMax chunk", () => {
    const prior = globalThis.AudioContext
    const stats = { contexts: 0, starts: 0, closes: 0 }
    const nodes: Node[] = []
    class Node extends EventTarget {
      buffer: { duration: number } | undefined
      connect() {}
      start() {
        stats.starts++
      }
      stop() {}
    }
    class Context {
      currentTime = 0
      destination = {}
      constructor() {
        stats.contexts++
      }
      resume() {
        return Promise.resolve()
      }
      close() {
        stats.closes++
        return Promise.resolve()
      }
      createBuffer(_channels: number, count: number, rate: number) {
        return { duration: count / rate, getChannelData: () => new Float32Array(count) }
      }
      createBufferSource() {
        const node = new Node()
        nodes.push(node)
        return node
      }
    }
    Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: Context })
    const player = new StreamPlayer(() => {}, () => {})
    player.unlock()
    player.reset()
    player.push("AQAAAA==", "audio/pcm;rate=16000")
    expect(stats.contexts).toBe(1)
    expect(stats.starts).toBe(1)
    expect(stats.closes).toBe(0)
    player.finish()
    nodes[0]?.dispatchEvent(new Event("ended"))
    player.push("AQAAAA==", "audio/pcm;rate=16000")
    expect(stats.contexts).toBe(1)
    expect(stats.starts).toBe(2)
    expect(stats.closes).toBe(0)
    player.reset()
    player.push("AQAAAA==", "audio/pcm;rate=16000")
    expect(stats.contexts).toBe(1)
    expect(stats.starts).toBe(3)
    expect(stats.closes).toBe(0)
    player.stop(false)
    expect(stats.closes).toBe(1)
    Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: prior })
  })

  it("learns stable speaker residue while retaining human barge-in", () => {
    const gate = new EchoGate()
    for (let index = 0; index < 20; index++) {
      const rms = [0.018, 0.021, 0.02, 0.022][index % 4]!
      expect(gate.hears(rms, 0.015, true)).toBe(false)
    }
    expect(gate.hears(0.024, 0.015, true)).toBe(false)
    expect(gate.hears(0.08, 0.015, true)).toBe(true)
    expect(gate.hears(0.033, 0.015, true)).toBe(true)
    gate.reject()
    expect(gate.hears(0.033, 0.015, true)).toBe(false)
  })

  it("starts the orb through realtime admission without composer submission", async () => {
    const root = join(import.meta.dir, "../..")
    const input = await Bun.file(join(root, "webview-ui/src/components/chat/PromptInput.tsx")).text()
    const capture = await Bun.file(join(root, "webview-ui/src/components/speech-to-text/capture.ts")).text()
    const gate = await Bun.file(join(root, "webview-ui/src/components/speech-to-text/echo-gate.ts")).text()
    const client = await Bun.file(join(root, "webview-ui/src/context/realtime-voice.ts")).text()
    const voice = await Bun.file(join(root, "webview-ui/src/context/voice.tsx")).text()
    const player = await Bun.file(join(root, "webview-ui/src/context/stream-player.ts")).text()
    expect(input).toContain("voice.start(id)")
    expect(input).toContain('session.selectAgent("voice", id)')
    expect(input).toContain('session.selectAgent("auto", sid())')
    expect(input).toContain('setTimeout(() => window.dispatchEvent(new CustomEvent("rayaVoiceListen")), 100)')
    expect(input).toContain("if (!voice.playing()) voice.listen()")
    expect(input).toContain("echoSuppression: voice.playing()")
    expect(input).toContain("speech.cancel()")
    expect(capture).toContain('echoCancellation: { ideal: "all" }')
    expect(capture).toContain("voiceIsolation: { ideal: true }")
    expect(capture).toContain("autoGainControl: { ideal: false }")
    expect(capture).toContain("this.stream?.active === true")
    expect(gate).toContain("this.echo * this.scale + 0.004")
    expect(gate).toContain("this.warm < 20")
    expect(capture).toContain("this.chunks = []")
    expect(voice).toContain("setCascade(true)")
    expect(voice).toContain('update({ mode: "hands-free", autoSpeak: true })')
    expect(voice).toContain('settings().voiceEngine === "cascade-v1" ? undefined : message.error')
    expect(voice).toContain('if (settings().mode === "hands-free") setStatus("thinking")')
    expect(voice).toContain("player.reset()")
    expect(voice).toContain("only full orb deactivation closes the webview audio sink")
    expect(player).toContain("preserve the user-gesture-unlocked AudioContext")
    expect(player).toContain("present local MiniMax PCM as remote WebRTC playout")
    expect(player).toContain("send.addTrack(track, sink.stream)")
    expect(player).toContain("await connected(send, receive)")
    expect(player).toContain("this.output = sink")
    expect(client).toContain('topic: "raya.playout"')
    expect(client).toContain('"raya.playout.item"')
    expect(client).toContain("this.sink.fallback")
    expect(client).toContain('registerProcessor("raya-playout"')
    expect(client).not.toContain('type: "sendMessage"')
  })
})

import { expect, test } from "bun:test"
import { SpeechCapture } from "../../webview-ui/src/components/speech-to-text/capture"

class Recorder extends EventTarget {
  static all: Recorder[] = []
  static isTypeSupported() {
    return true
  }
  state = "inactive"
  mimeType = "audio/webm"
  constructor() {
    super()
    Recorder.all.push(this)
  }
  start() {
    this.state = "recording"
  }
  stop() {
    this.state = "inactive"
  }
}
const opts = { handsFree: false, threshold: 0.025, silenceMs: 900, onSpeech() {}, onSilence() {} }
function stream() {
  const state = { stopped: 0 }
  return {
    state,
    value: { active: true, getTracks: () => [{ stop: () => state.stopped++ }] } as unknown as MediaStream,
  }
}
function environment(get: () => Promise<MediaStream>) {
  const media = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  const recorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: get } })
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
  Recorder.all = []
  return {
    [Symbol.dispose]() {
      if (media) Object.defineProperty(navigator, "mediaDevices", media)
      else Reflect.deleteProperty(navigator, "mediaDevices")
      if (recorder) Object.defineProperty(globalThis, "MediaRecorder", recorder)
      else Reflect.deleteProperty(globalThis, "MediaRecorder")
    },
  }
}
test("cancelled original microphone acquisition closes its late stream without replacing fresh capture", async () => {
  const gate = Promise.withResolvers<MediaStream>()
  const old = stream()
  const fresh = stream()
  let count = 0
  using env = environment(() => (++count === 1 ? gate.promise : Promise.resolve(fresh.value)))
  const capture = new SpeechCapture()
  const pending = capture.start(opts).then(
    () => undefined,
    (err) => err,
  )
  capture.cancel()
  await capture.start(opts)
  gate.resolve(old.value)
  expect(await pending).toBeInstanceOf(Error)
  expect(old.state.stopped).toBe(1)
  expect(fresh.state.stopped).toBe(0)
  expect(Recorder.all).toHaveLength(1)
  expect(Recorder.all[0]!.state).toBe("recording")
  capture.cancel()
  expect(fresh.state.stopped).toBe(1)
})
test("late original recorder stop and encoding never clean up its replacement", async () => {
  const old = stream()
  const fresh = stream()
  let count = 0
  using env = environment(() => Promise.resolve(++count === 1 ? old.value : fresh.value))
  const capture = new SpeechCapture()
  await capture.start(opts)
  const recorder = Recorder.all[0]!
  const pending = capture.stop().then(
    () => undefined,
    (err) => err,
  )
  capture.cancel()
  await capture.start(opts)
  recorder.dispatchEvent(new Event("stop"))
  expect(await pending).toBeInstanceOf(Error)
  await Bun.sleep(0)
  expect(Recorder.all[1]!.state).toBe("recording")
  expect(fresh.state.stopped).toBe(0)
  capture.cancel()
  expect(fresh.state.stopped).toBe(1)
})
test("cancelled original microphone rejection never starts a fallback acquisition", async () => {
  const gate = Promise.withResolvers<MediaStream>()
  let calls = 0
  using env = environment(() => {
    calls++
    return gate.promise
  })
  const capture = new SpeechCapture()
  const pending = capture.start(opts).then(
    () => undefined,
    (err) => err,
  )
  capture.cancel()
  gate.reject(new Error("Deferred permission refusal"))
  expect(await pending).toBeInstanceOf(Error)
  expect(calls).toBe(1)
  expect(Recorder.all).toHaveLength(0)
})

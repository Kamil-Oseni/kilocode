import { expect, test } from "bun:test"
import { WakeController } from "../../src/speech/wake-controller"

// Deterministic detector ports exercise controller admission, not keyword accuracy.
function gate() {
  const state = { frames: 0, resets: 0, closed: 0, frame: undefined as Int16Array | undefined }
  const detector = {
    accept(pcm: Int16Array) {
      state.frames++
      state.frame = pcm
      return pcm[0] === 7
    },
    reset() {
      state.resets++
    },
    async close() {
      state.closed++
    },
  }
  return { state, detector }
}

test("disabled/local-only PCM, bounded memory and one capture after detection", async () => {
  const port = gate()
  const calls: AbortSignal[] = []
  const owner = new WakeController(port.detector, async (signal) => {
    calls.push(signal)
  })
  expect(owner.feed(new Int16Array([7]), 16000)).toBe(false)
  owner.enable()
  expect(owner.feed(new Int16Array([1]), 16000)).toBe(false)
  expect(calls).toHaveLength(0)
  expect([...port.state.frame!]).toEqual([0])
  expect(() => owner.feed(new Int16Array(1601), 16000)).toThrow("Invalid local wake PCM")
  expect(() => owner.feed(new Int16Array([7]), 48000)).toThrow("Invalid local wake PCM")
  const pcm = new Int16Array([7])
  expect(owner.feed(pcm, 16000)).toBe(true)
  expect(owner.feed(pcm, 16000)).toBe(false)
  expect([...pcm]).toEqual([7])
  await owner.pause()
  expect(calls).toHaveLength(0) // cancellation before first producer instruction
  await owner.end()
  expect(port.state.closed).toBe(1)
})

test("pause/playback/EOF retain original capture until it settles and refuse late PCM", async () => {
  const port = gate()
  const signals: AbortSignal[] = []
  const hold = Promise.withResolvers<void>()
  const owner = new WakeController(port.detector, async (signal) => {
    signals.push(signal)
    await hold.promise
  })
  owner.enable()
  owner.feed(new Int16Array([7]), 16000)
  await Promise.resolve()
  expect(signals).toHaveLength(1)
  const pause = owner.playback(true)
  expect(signals[0].aborted).toBe(true)
  expect(owner.feed(new Int16Array([7]), 16000)).toBe(false)
  const ending = owner.end()
  expect(port.state.closed).toBe(0)
  expect(() => owner.enable()).toThrow("closed")
  hold.resolve()
  await Promise.all([pause, ending])
  expect(owner.state().closed).toBe(true)
  expect(port.state.closed).toBe(1)
  expect(owner.end()).toBe(ending)
})

test("failure stays paused through late playback completion; explicit enable resets", async () => {
  const port = gate()
  const primary = new Error("capture failed")
  const cleanup = new Error("detector close failed")
  port.detector.close = async () => {
    throw cleanup
  }
  const owner = new WakeController(port.detector, async () => {
    throw primary
  })
  owner.enable()
  owner.feed(new Int16Array([7]), 16000)
  await owner.pause()
  owner.enable()
  owner.feed(new Int16Array([7]), 16000)
  await Promise.resolve()
  await owner.pause()
  await owner.playback(false)
  expect(owner.state().paused).toBe(true)
  expect(owner.feed(new Int16Array([7]), 16000)).toBe(false)
  try {
    await owner.end()
    throw new Error("Expected retained errors")
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toEqual([primary, cleanup])
  }
})

test("reset and synchronous close failures remain original retirement errors", async () => {
  const port = gate()
  const reset = new Error("reset failed")
  const close = new Error("close threw")
  const owner = new WakeController(port.detector, async () => {})
  owner.enable()
  port.detector.reset = () => {
    throw reset
  }
  expect(() => owner.enable()).toThrow(reset)
  expect(owner.state().paused).toBe(true)
  port.detector.reset = () => {
    port.state.resets++
  }
  port.detector.close = () => {
    throw close
  }
  try {
    await owner.end()
    throw new Error("Expected retained errors")
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toEqual([reset, close])
  }
})

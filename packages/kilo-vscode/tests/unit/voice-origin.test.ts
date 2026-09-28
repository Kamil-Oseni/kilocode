import { expect, test } from "bun:test"
import { VoiceOrigin } from "../../src/speech/voice-origin"

test("webview replacement fences an old owner even when the same object is reattached", () => {
  const origin = new VoiceOrigin()
  const owner = {}
  const first = origin.bind(owner)
  expect(first()).toBe(true)
  const second = origin.bind(owner)
  expect(first()).toBe(false)
  expect(second()).toBe(true)
  const third = origin.bind({})
  expect(second()).toBe(false)
  expect(third()).toBe(true)
  origin.clear()
  expect(first()).toBe(false)
  expect(second()).toBe(false)
  expect(third()).toBe(false)
})

test("disposed ownership cannot revive when its original webview returns", () => {
  const origin = new VoiceOrigin()
  const owner = {}
  const first = origin.bind(owner)
  origin.clear()
  const second = origin.bind(owner)
  expect(first()).toBe(false)
  expect(second()).toBe(true)
})

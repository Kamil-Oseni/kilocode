import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import type { ExtensionMessage, WebviewMessage } from "../../webview-ui/src/types/messages"
import { DurableDrafts } from "../../webview-ui/src/utils/durable-drafts"
import type { ComposerDraftExtensionMessage, ComposerDraftRequest } from "../../src/shared/composer-drafts-messages"
import {
  createSpeechShortcut,
  isSpeechShortcut,
  SPEECH_HOLD_MS,
  speechShortcutLabel,
  speechShortcutValue,
  toggleSpeech,
} from "../../webview-ui/src/components/speech-to-text/shortcut"

type Toast = {
  actions?: Array<{ onClick: string | (() => void) }>
}

const toasts: Toast[] = []
mock.module("@kilocode/kilo-ui/toast", () => ({
  showToast: (toast: Toast) => toasts.push(toast),
}))

const { useSpeechToText } = await import("../../webview-ui/src/components/speech-to-text/useSpeechToText")

it("End and STT failure close the real hook's retained hands-free microphone after transcription", async () => {
  const names = ["MediaRecorder", "AudioContext", "window"] as const
  const original = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  const media = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  class Recorder extends EventTarget {
    static isTypeSupported() {
      return true
    }
    state = "inactive"
    mimeType = "audio/webm"
    start() {
      this.state = "recording"
    }
    stop() {
      this.state = "inactive"
      queueMicrotask(() => {
        const data = new Event("dataavailable")
        Object.defineProperty(data, "data", { value: new Blob([new Uint8Array([1])]) })
        this.dispatchEvent(data)
        this.dispatchEvent(new Event("stop"))
      })
    }
  }
  class Context {
    createMediaStreamSource() {
      return { connect() {} }
    }
    createAnalyser() {
      return {
        fftSize: 1024,
        getByteTimeDomainData(data: Uint8Array) {
          data.fill(128)
        },
      }
    }
    close() {
      return Promise.resolve()
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: Context })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setInterval: () => 1, clearInterval() {} },
  })
  try {
    for (const outcome of ["result", "error"]) {
      let stopped = 0
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({ active: true, getTracks: () => [{ stop: () => stopped++ }] }),
        },
      })
      const ctx = setup(() => "voice-session")
      try {
        ctx.speech.start({ model: "local", handsFree: true, insert: () => undefined })
        await Bun.sleep(0)
        expect(ctx.speech.state()).toBe("recording")
        ctx.speech.stop()
        await Bun.sleep(0)
        const submit = ctx.sent.find((message) => message.type === "speechToTextSubmit")
        if (submit?.type !== "speechToTextSubmit") throw new Error("Real capture submit missing")
        expect(stopped).toBe(0)
        if (outcome === "result") {
          ctx.fire({ type: "speechToTextResult", requestId: submit.requestId, text: "Synthetic conversation" })
          expect(ctx.speech.state()).toBe("idle")
          expect(stopped).toBe(0)
          ctx.speech.cancel()
        } else {
          ctx.fire({
            type: "speechToTextError",
            requestId: submit.requestId,
            code: "transcription_failed",
            error: "Synthetic STT refusal",
          })
          expect(ctx.speech.state()).toBe("error")
        }
        expect(stopped).toBe(1)
        ctx.speech.cancel()
        expect(stopped).toBe(1)
      } finally {
        ctx.dispose()
      }
    }
  } finally {
    if (media) Object.defineProperty(navigator, "mediaDevices", media)
    else Reflect.deleteProperty(navigator, "mediaDevices")
    names.forEach((name, index) => {
      const descriptor = original[index]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
})

function setup(session: () => string | undefined = () => undefined) {
  const sent: WebviewMessage[] = []
  let handler: ((message: ExtensionMessage) => void) | undefined
  let logins = 0
  toasts.length = 0

  const root = createRoot((dispose) => ({
    dispose,
    speech: useSpeechToText(
      {
        postMessage: (message) => sent.push(message),
        onMessage: (next) => {
          handler = next
          return () => {
            handler = undefined
          }
        },
      },
      { goToLogin: () => logins++ },
      { t: (key) => key },
      session,
    ),
  }))

  const fire = (message: ExtensionMessage) => handler?.(message)
  return { ...root, fire, sent, logins: () => logins }
}

it("cancelled submitted speech retains one late result without inserting into its successor", async () => {
  const ctx = setup(() => "original-session")
  const saved: string[] = []
  const inserted: string[] = []
  try {
    ctx.speech.start({
      model: "synthetic-stt",
      insert: (text) => inserted.push(text),
      retain: (text) => saved.push(text),
    })
    const original = ctx.sent.findLast((message) => message.type === "speechToTextStart")
    if (original?.type !== "speechToTextStart") throw new Error("Actual speech start missing")
    ctx.fire({ type: "speechToTextStarted", requestId: original.requestId })
    ctx.speech.stop()
    ctx.speech.cancel()
    ctx.speech.start({ model: "synthetic-stt", insert: (text) => inserted.push(text) })
    const next = ctx.sent.findLast((message) => message.type === "speechToTextStart")
    if (next?.type !== "speechToTextStart") throw new Error("Actual successor start missing")
    expect(next.requestId).not.toBe(original.requestId)
    ctx.fire({ type: "speechToTextResult", requestId: original.requestId, text: "Detached original speech" })
    ctx.fire({ type: "speechToTextResult", requestId: original.requestId, text: "Duplicate" })
    expect(saved).toEqual(["Detached original speech"])
    expect(inserted).toEqual([])
    expect(ctx.speech.state()).toBe("starting")
    ctx.fire({ type: "speechToTextStarted", requestId: next.requestId })
    ctx.speech.stop()
    ctx.fire({ type: "speechToTextResult", requestId: next.requestId, text: "Current speech" })
    await Bun.sleep(0)
    expect(inserted).toEqual(["Current speech"])
    expect(saved).toHaveLength(1)
  } finally {
    ctx.dispose()
  }
})

it("retired result capacity, cancelled/error acknowledgments and disposal remain fenced", () => {
  const ctx = setup()
  const saved: string[] = []
  const ids: string[] = []
  try {
    for (let count = 0; count < 16; count++) {
      ctx.speech.start({
        model: "synthetic-stt",
        insert: () => {
          throw new Error("Retired speech cannot insert")
        },
        retain: (text) => saved.push(text),
      })
      const original = ctx.sent.findLast((message) => message.type === "speechToTextStart")
      if (original?.type !== "speechToTextStart") throw new Error("Actual speech start missing")
      ids.push(original.requestId)
      ctx.fire({ type: "speechToTextStarted", requestId: original.requestId })
      ctx.speech.stop()
      ctx.speech.cancel()
    }
    ctx.speech.start({ model: "synthetic-stt", insert: () => undefined })
    expect(ctx.sent.filter((message) => message.type === "speechToTextStart")).toHaveLength(16)
    expect(ctx.speech.error()).toContain("unresolved")
    ctx.fire({ type: "speechToTextCancelled", requestId: ids[0]! })
    ctx.fire({ type: "speechToTextError", requestId: ids[1]!, error: "Original refusal" })
    ctx.fire({ type: "speechToTextResult", requestId: ids[0]!, text: "After original cancellation" })
    ctx.fire({ type: "speechToTextResult", requestId: ids[1]!, text: "After original failure" })
    expect(saved).toEqual([])
    ctx.speech.start({ model: "synthetic-stt", insert: () => undefined })
    expect(ctx.sent.filter((message) => message.type === "speechToTextStart")).toHaveLength(17)
    ctx.dispose()
    ctx.fire({ type: "speechToTextResult", requestId: ids[2]!, text: "After disposal" })
    expect(saved).toEqual([])
  } finally {
    ctx.dispose()
  }
})

it("actual recognized-result consumption retains speech on throwing settlement, ownership, readiness or partial insertion", async () => {
  for (const fault of ["settlement", "ownership", "readiness", "insertion"]) {
    const ctx = setup()
    const retained: Array<{ text: string; request: string }> = []
    const inserted: string[] = []
    let sent = 0
    try {
      ctx.speech.start({
        model: "synthetic-stt",
        ownership: () => () => {
          if (fault === "ownership") throw new Error("Private fault detail must not appear in the diagnostic")
          return true
        },
        settle: () => {
          if (fault === "settlement") throw new Error("Private synchronous settlement fault")
          return Promise.resolve(true)
        },
        insert: (text) => {
          inserted.push(text)
          if (fault === "insertion") throw new Error("Unknown partial insertion")
        },
        retain: (text, request) => {
          retained.push({ text, request })
        },
      })
      const start = ctx.sent[0]
      if (start?.type !== "speechToTextStart") throw new Error("Actual speech start missing")
      ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
      ctx.speech.stop({
        ready: () => {
          if (fault === "readiness") throw new Error("Private readiness fault")
          return true
        },
        done: () => sent++,
      })
      const result = {
        type: "speechToTextResult",
        requestId: start.requestId,
        text: "Original recognized speech",
      } as const
      ctx.fire(result)
      ctx.fire({ ...result, text: "Duplicate" })
      await Bun.sleep(0)
      expect(retained).toEqual([{ text: result.text, request: start.requestId }])
      expect(inserted).toEqual(fault === "insertion" ? [result.text] : [])
      expect(sent).toBe(0)
      expect(ctx.speech.state()).toBe("idle")
      expect(ctx.speech.error()).toBe("Speech could not be applied safely. Review the retained transcript.")
      ctx.speech.cancel()
      expect(retained).toHaveLength(1)
    } finally {
      ctx.dispose()
    }
  }
})

it("cancellation during settlement admission retains once and late completion cannot inspect or reset a newer request", async () => {
  const ctx = setup()
  const gate = Promise.withResolvers<boolean>()
  const retained: string[] = []
  let checks = 0
  let sent = 0
  try {
    ctx.speech.start({
      model: "old-stt",
      ownership: () => () => {
        checks++
        return true
      },
      settle: () => {
        ctx.speech.cancel()
        ctx.speech.start({
          model: "new-stt",
          insert: () => {
            throw new Error("Old result reached new insertion")
          },
        })
        return gate.promise
      },
      insert: () => {
        throw new Error("Cancelled result reached old insertion")
      },
      retain: (text) => {
        retained.push(text)
      },
    })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("Actual speech start missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    ctx.speech.stop({
      ready: () => {
        checks++
        return true
      },
      done: () => sent++,
    })
    ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "Retained original" })
    expect(ctx.speech.state()).toBe("starting")
    expect(retained).toEqual(["Retained original"])
    gate.resolve(true)
    await Bun.sleep(0)
    expect(ctx.speech.state()).toBe("starting")
    expect(checks).toBe(0)
    expect(sent).toBe(0)
    expect(retained).toEqual(["Retained original"])
  } finally {
    gate.resolve(false)
    ctx.dispose()
  }
})

it("explicitly consumed local control can cancel synchronously without retaining it, while a thrown action retains once", async () => {
  for (const outcome of ["success", "throw", "newer"]) {
    const ctx = setup()
    const retained: Array<{ text: string; request: string }> = []
    let done = 0
    try {
      ctx.speech.start({
        model: "synthetic-stt",
        settle: () => Promise.resolve(true),
        ownership: () => () => true,
        insert: (_text, consume) => {
          consume?.()
          ctx.speech.cancel()
          if (outcome === "newer") ctx.speech.start({ model: "new-stt", insert: () => false })
          if (outcome !== "success") throw new Error("Unknown partial local control action")
          return false
        },
        retain: (text, request) => {
          retained.push({ text, request })
        },
      })
      const start = ctx.sent[0]
      if (start?.type !== "speechToTextStart") throw new Error("Actual speech start missing")
      ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
      ctx.speech.stop({ done: () => done++ })
      const result = {
        type: "speechToTextResult",
        requestId: start.requestId,
        text: "Stop hands-free voice mode",
      } as const
      ctx.fire(result)
      ctx.fire(result)
      await Bun.sleep(0)
      expect(done).toBe(0)
      expect(retained).toEqual(outcome === "success" ? [] : [{ text: result.text, request: start.requestId }])
      expect(ctx.speech.state()).toBe(outcome === "newer" ? "starting" : "idle")
      ctx.speech.cancel()
      expect(retained).toHaveLength(outcome === "success" ? 0 : 1)
    } finally {
      ctx.dispose()
    }
  }
})

it("recognized speech waits for actual first-owner SQL promotion and preserves cancellation, timeout and drift once", async () => {
  const { draftStorage } = await import("../fixtures/durable-draft-storage")
  for (const outcome of ["success", "cancel", "dispose", "drift", "timeout"]) {
    await using storage = await draftStorage()
    const handlers = new Set<(message: ComposerDraftExtensionMessage) => void>()
    const requests: ComposerDraftRequest[] = []
    const emit = (message: ComposerDraftExtensionMessage) => handlers.forEach((handler) => handler(message))
    const durable = new DurableDrafts({
      onMessage: (handler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      postMessage: (message) => {
        if (message.type === "composerDraftPane" || message.type === "composerDraftFlushed") return
        requests.push(message)
        void storage.handle(message).then(emit)
      },
    })
    const origin = { box: "sidebar:new-task", key: "pending:first", pendingID: "first" }
    const target = { box: origin.box, key: `${origin.box}:session:first`, sessionID: "first" }
    durable.context(origin.box, "same-context")
    durable.view(origin)
    durable.created(origin.pendingID, target.sessionID, origin.box)
    const owned = durable.insertion(target)
    const ctx = setup(() => target.sessionID)
    const inserted: string[] = []
    const retained: Array<{ text: string; request: string }> = []
    let stable = true
    let checks = 0
    let done = 0
    try {
      ctx.speech.start({
        model: "synthetic-stt",
        ownership: () => () => stable && owned(target),
        settle: (signal) =>
          owned.settle(target, signal, () => {
            checks++
            return stable
          }),
        insert: (text) => {
          inserted.push(text)
        },
        retain: (text, request) => {
          retained.push({ text, request })
        },
      })
      const start = ctx.sent[0]
      if (start?.type !== "speechToTextStart") throw new Error("Actual speech start missing")
      ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
      ctx.speech.stop({ done: () => done++ })
      const result = {
        type: "speechToTextResult",
        requestId: start.requestId,
        text: "Original bounded transcript",
      } as const
      ctx.fire(result)
      ctx.fire({ ...result, text: "Duplicate recognized result" })
      expect(ctx.speech.state()).toBe("transcribing")
      expect(inserted).toEqual([])
      expect(requests).toEqual([])
      if (outcome === "cancel") {
        ctx.speech.cancel()
        ctx.speech.start({
          model: "new-stt",
          insert: (text) => {
            inserted.push(text)
          },
        })
      }
      if (outcome === "dispose") ctx.dispose()
      if (outcome === "drift") stable = false
      if (outcome === "timeout") {
        const deadline = Date.now() + 12_000
        while (!retained.length && Date.now() < deadline) await Bun.sleep(25)
        expect(retained).toEqual([{ text: result.text, request: start.requestId }])
        expect(requests).toEqual([])
      }
      emit({
        type: "composerDraftState",
        epoch: durable.epoch,
        generation: 1,
        connected: true,
        owners: [{ box: origin.box, owner: storage.root }],
      })
      await durable.hydrate(target)
      await Bun.sleep(0)
      expect(requests.map((request) => request.type)).toEqual([
        "composerDraftLoad",
        "composerDraftSave",
        "composerDraftPromote",
      ])
      if (outcome === "success") {
        expect(inserted).toEqual([result.text])
        expect(retained).toEqual([])
        expect(done).toBe(1)
        expect(ctx.speech.state()).toBe("idle")
      } else {
        expect(inserted).toEqual([])
        expect(retained).toEqual([{ text: result.text, request: start.requestId }])
        expect(done).toBe(0)
        expect(ctx.speech.state()).toBe(outcome === "cancel" ? "starting" : "idle")
      }
      const settled = checks
      await Bun.sleep(150)
      expect(checks).toBe(settled)
      ctx.fire(result)
      expect(inserted).toEqual(outcome === "success" ? [result.text] : [])
      expect(retained).toHaveLength(outcome === "success" ? 0 : 1)
    } finally {
      ctx.dispose()
      durable.dispose()
    }
  }
}, 30_000)

describe("useSpeechToText", () => {
  it("pins the session selected when recording starts", () => {
    let session = "ses_origin"
    const ctx = setup(() => session)
    ctx.speech.start({ model: "openai/gpt-4o-mini-transcribe", insert: () => undefined })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    expect(start.sessionID).toBe("ses_origin")

    session = "ses_other"
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    ctx.speech.stop()
    expect(ctx.sent[1]).toEqual({ type: "speechToTextStop", requestId: start.requestId, sessionID: "ses_origin" })
    ctx.dispose()
  })

  it("waits for microphone readiness before reporting recording", () => {
    const ctx = setup()

    ctx.speech.start({ model: "scribe", insert: () => {} })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")

    expect(ctx.speech.state()).toBe("starting")
    expect(ctx.speech.active()).toBe(true)

    ctx.fire({ type: "speechToTextStarted", requestId: "another-request" })
    expect(ctx.speech.state()).toBe("starting")

    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    expect(ctx.speech.state()).toBe("recording")
    ctx.dispose()
  })

  // raya_change - hands-free capture stays active during playback and cancels only after real speech begins.
  it("cancels streaming playback when extension-host VAD hears a barge-in", () => {
    const ctx = setup()
    let heard = 0
    ctx.speech.start({ model: "scribe", insert: () => {}, handsFree: true, onSpeech: () => heard++ })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    ctx.fire({ type: "speechToTextSpeech", requestId: start.requestId })

    expect(heard).toBe(1)
    expect(ctx.sent[1]).toEqual({ type: "speechPlaybackCancel" })
    ctx.dispose()
  })

  it("does not stop or start another recording while the microphone is starting", () => {
    const ctx = setup()

    ctx.speech.start({ model: "scribe", insert: () => {} })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")

    ctx.speech.stop()
    ctx.speech.start({ model: "other", insert: () => {} })
    expect(ctx.speech.state()).toBe("starting")
    expect(ctx.sent).toEqual([start])

    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    ctx.speech.stop()
    expect(ctx.speech.state()).toBe("transcribing")
    expect(ctx.sent[1]).toEqual({ type: "speechToTextStop", requestId: start.requestId })
    ctx.dispose()
  })

  it("cancels a pending microphone startup and ignores its late acknowledgement", () => {
    const ctx = setup()

    ctx.speech.start({ model: "scribe", insert: () => {} })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")

    ctx.speech.cancel()
    expect(ctx.sent[1]).toEqual({ type: "speechToTextCancel", requestId: start.requestId })
    expect(ctx.speech.state()).toBe("idle")

    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    expect(ctx.speech.state()).toBe("idle")
    ctx.dispose()
  })

  it("offers sign-in when stored credentials stop authenticating", () => {
    const ctx = setup()

    ctx.speech.start({ model: "scribe", insert: () => {} })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")

    ctx.fire({
      type: "speechToTextError",
      requestId: start.requestId,
      error: "Unauthorized",
      code: "not_authenticated",
    })
    const action = toasts[0]?.actions?.find((item) => typeof item.onClick === "function")
    if (typeof action?.onClick === "function") action.onClick()

    expect(ctx.logins()).toBe(1)
    expect(ctx.speech.error()).toBe("speechToText.error.loginRequired")
    ctx.dispose()
  })

  it("runs the stop completion after inserting a transcript", () => {
    const ctx = setup()
    const text: string[] = []
    let done = 0

    ctx.speech.start({ model: "scribe", insert: (value) => text.push(value) })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })

    ctx.speech.stop({ done: () => done++ })
    ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "Recorded prompt" })

    expect(text).toEqual(["Recorded prompt"])
    expect(done).toBe(1)
    ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "Recorded prompt" })
    expect(text).toEqual(["Recorded prompt"])
    expect(done).toBe(1)
    expect(ctx.speech.state()).toBe("idle")
    ctx.dispose()
  })

  // raya_change - Milestone H local plain-English voice commands are not sent to the agent
  it("does not submit a transcript consumed by voice control", () => {
    const ctx = setup()
    let done = 0
    ctx.speech.start({ model: "scribe", insert: () => false })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })

    ctx.speech.stop({ done: () => done++ })
    ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "Start hands-free voice mode" })

    expect(done).toBe(0)
    expect(ctx.speech.state()).toBe("idle")
    ctx.dispose()
  })

  it("drops the stop completion when transcription is cancelled", () => {
    const ctx = setup()
    let done = 0

    ctx.speech.start({ model: "scribe", insert: () => {} })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })

    ctx.speech.stop({ done: () => done++ })
    ctx.speech.cancel()
    ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "Ignored prompt" })

    expect(done).toBe(0)
    expect(ctx.speech.state()).toBe("idle")
    ctx.dispose()
  })

  it("drops the stop completion when the send context changes", () => {
    const ctx = setup()
    const text: string[] = []
    let done = 0

    ctx.speech.start({ model: "scribe", insert: (value) => text.push(value) })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })

    ctx.speech.stop({ done: () => done++, ready: () => false })
    ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "Keep as draft" })

    expect(text).toEqual(["Keep as draft"])
    expect(done).toBe(0)
    expect(ctx.speech.state()).toBe("idle")
    ctx.dispose()
  })

  it("captures insertion ownership once at transcription and retains rejected results once", () => {
    const ctx = setup()
    const inserted: string[] = []
    const retained: string[] = []
    let epoch = 0
    let captured = 0
    let done = 0
    ctx.speech.start({
      model: "scribe",
      insert: (text) => {
        inserted.push(text)
      },
      retain: (text) => {
        retained.push(text)
      },
      ownership: () => {
        captured++
        const original = epoch
        return () => epoch === original
      },
    })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start missing")
    expect(captured).toBe(0)
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    ctx.speech.stop({ done: () => done++ })
    ctx.speech.stop()
    expect(captured).toBe(1)
    epoch++
    const result = { type: "speechToTextResult", requestId: start.requestId, text: "Stop hands-free voice" } as const
    ctx.fire(result)
    ctx.fire(result)
    expect(inserted).toEqual([])
    expect(retained).toEqual([result.text])
    expect(done).toBe(0)
    ctx.speech.cancel()
    expect(retained).toEqual([result.text])
    ctx.dispose()
  })
})

it("capture failure notifies once and a fresh capture ignores the old error", () => {
  const ctx = setup()
  const errors: string[] = []
  const texts: string[] = []
  ctx.speech.start({
    model: "local",
    insert: (text) => {
      texts.push(text)
    },
    onError: (error) => errors.push(error),
  })
  const first = ctx.sent[0]
  if (first?.type !== "speechToTextStart") throw new Error("Missing capture")
  ctx.fire({
    type: "speechToTextError",
    requestId: first.requestId,
    error: "No speech was detected.",
    code: "empty_transcript",
  })
  expect(ctx.speech.state()).toBe("error")
  expect(errors).toEqual(["No speech was detected."])
  ctx.speech.start({
    model: "local",
    insert: (text) => {
      texts.push(text)
    },
    onError: (error) => errors.push(error),
  })
  const second = ctx.sent.at(-1)
  if (second?.type !== "speechToTextStart") throw new Error("Missing second capture")
  ctx.fire({ type: "speechToTextError", requestId: first.requestId, error: "stale" })
  expect(ctx.speech.state()).toBe("starting")
  ctx.fire({ type: "speechToTextResult", requestId: second.requestId, text: "new draft" })
  expect(texts).toEqual(["new draft"])
  expect(errors).toHaveLength(1)
  expect(ctx.speech.error()).toBeUndefined()
  ctx.dispose()
})

it("native K then O chords leave the genuine speech hook idle on both platforms", () => {
  for (const mac of [false, true]) {
    const ctx = setup()
    const shortcut = createSpeechShortcut({
      speech: ctx.speech,
      disabled: () => false,
      start: () => ctx.speech.start({ model: "scribe", insert: () => {} }),
      finish: () => ctx.speech.stop(),
      mac,
    })
    try {
      for (const key of ["k", "o"]) {
        const event = {
          key,
          ctrlKey: !mac,
          metaKey: mac,
          altKey: false,
          shiftKey: false,
          repeat: false,
          timeStamp: 100,
        }
        expect(shortcut.down(event)).toBe(false)
        expect(shortcut.up(event)).toBe(false)
      }
      expect(ctx.sent).toEqual([])
      expect(ctx.speech.state()).toBe("idle")
    } finally {
      shortcut.reset()
      ctx.dispose()
    }
  }
})

it("intentional Alt speech chords preserve tap and held release on both platforms", () => {
  for (const mac of [false, true]) {
    for (const held of [false, true]) {
      const ctx = setup()
      const submits: boolean[] = []
      const shortcut = createSpeechShortcut({
        speech: ctx.speech,
        disabled: () => false,
        start: () => ctx.speech.start({ model: "scribe", insert: () => {} }),
        finish: (submit) => {
          submits.push(submit)
          ctx.speech.stop()
        },
        mac,
      })
      try {
        expect(
          shortcut.down({
            key: "k",
            ctrlKey: !mac,
            metaKey: mac,
            altKey: true,
            shiftKey: false,
            repeat: false,
            timeStamp: 0,
          }),
        ).toBe(true)
        const start = ctx.sent[0]
        if (start?.type !== "speechToTextStart") throw new Error("Real hook start missing")
        ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
        expect(shortcut.up({ key: held ? "Alt" : "k", timeStamp: held ? SPEECH_HOLD_MS : 100 })).toBe(true)
        expect(ctx.speech.state()).toBe(held ? "transcribing" : "recording")
        expect(submits).toEqual(held ? [true] : [])
      } finally {
        shortcut.reset()
        ctx.dispose()
      }
    }
  }
})

describe("speech shortcut", () => {
  const key = (timeStamp: number, repeat = false) => ({
    key: "k",
    metaKey: true,
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    repeat,
    timeStamp,
  })

  it("accepts only the platform modifier with K", () => {
    expect(isSpeechShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, true)).toBe(
      true,
    )
    expect(isSpeechShortcut({ key: "k", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }, true)).toBe(
      false,
    )
    expect(isSpeechShortcut({ key: "k", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }, false)).toBe(
      true,
    )
    expect(isSpeechShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, false)).toBe(
      false,
    )
    expect(isSpeechShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe(
      false,
    )
    expect(isSpeechShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: true, shiftKey: true }, true)).toBe(
      false,
    )
  })

  it("exposes platform-specific labels for the focused input", () => {
    expect(speechShortcutLabel(true)).toBe("⌥⌘K")
    expect(speechShortcutValue(true)).toBe("Alt+Meta+K")
    expect(speechShortcutLabel(false)).toBe("Ctrl+Alt+K")
    expect(speechShortcutValue(false)).toBe("Control+Alt+K")
  })

  it("does not handle a shortcut when speech is unavailable", () => {
    const ctx = setup()
    let started = 0
    expect(toggleSpeech(ctx.speech, true, () => started++)).toBe(false)
    expect(started).toBe(0)
    ctx.dispose()
  })

  it("ignores key repeat and keeps a quick press recording", () => {
    const ctx = setup()
    const shortcut = createSpeechShortcut({
      speech: ctx.speech,
      disabled: () => false,
      start: () => ctx.speech.start({ model: "scribe", insert: () => {} }),
      finish: () => ctx.speech.stop(),
      mac: true,
    })

    expect(shortcut.down(key(0))).toBe(true)
    expect(shortcut.down(key(50, true))).toBe(true)
    expect(shortcut.down(key(100, true))).toBe(true)
    expect(shortcut.up(key(SPEECH_HOLD_MS - 1))).toBe(true)
    expect(ctx.sent).toHaveLength(1)
    expect(ctx.speech.state()).toBe("starting")

    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    expect(ctx.speech.state()).toBe("recording")
    ctx.dispose()
  })

  it("stops recording on a second quick press", () => {
    const ctx = setup()
    const shortcut = createSpeechShortcut({
      speech: ctx.speech,
      disabled: () => false,
      start: () => ctx.speech.start({ model: "scribe", insert: () => {} }),
      finish: () => ctx.speech.stop(),
      mac: true,
    })

    shortcut.down(key(0))
    shortcut.up(key(100))
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })

    shortcut.down(key(200))
    shortcut.down(key(250, true))
    shortcut.up(key(300))
    expect(ctx.speech.state()).toBe("transcribing")
    expect(ctx.sent[1]).toEqual({ type: "speechToTextStop", requestId: start.requestId })
    ctx.dispose()
  })

  it("queues transcription and submit when a held press is released during startup", () => {
    const ctx = setup()
    let submitted = 0
    const shortcut = createSpeechShortcut({
      speech: ctx.speech,
      disabled: () => false,
      start: () => ctx.speech.start({ model: "scribe", insert: () => {} }),
      finish: (submit) => ctx.speech.stop(submit ? { done: () => submitted++ } : undefined),
      mac: true,
    })

    shortcut.down(key(0))
    shortcut.up(key(SPEECH_HOLD_MS))
    expect(ctx.speech.state()).toBe("starting")
    expect(ctx.sent).toHaveLength(1)

    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    expect(ctx.speech.state()).toBe("transcribing")
    expect(ctx.sent[1]).toEqual({ type: "speechToTextStop", requestId: start.requestId })

    ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "Held prompt" })
    expect(submitted).toBe(1)
    ctx.dispose()
  })

  it("submits when macOS suppresses K key-up and only reports Command release", () => {
    const ctx = setup()
    let submitted = 0
    const shortcut = createSpeechShortcut({
      speech: ctx.speech,
      disabled: () => false,
      start: () => ctx.speech.start({ model: "scribe", insert: () => {} }),
      finish: (submit) => ctx.speech.stop(submit ? { done: () => submitted++ } : undefined),
      mac: true,
    })

    shortcut.down(key(0))
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })

    expect(shortcut.up({ key: "Meta", timeStamp: SPEECH_HOLD_MS })).toBe(true)
    expect(ctx.speech.state()).toBe("transcribing")
    expect(ctx.sent[1]).toEqual({ type: "speechToTextStop", requestId: start.requestId })

    ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "Held prompt" })
    expect(submitted).toBe(1)
    ctx.dispose()
  })
})

it("empty transcription stays an error for push-to-talk even with a resume callback", () => {
  for (const outcome of ["result", "error"] as const) {
    const ctx = setup()
    let resumed = 0
    let failed = 0
    ctx.speech.start({
      model: "scribe",
      handsFree: false,
      insert: () => undefined,
      onEmpty: () => resumed++,
      onError: () => failed++,
    })
    const start = ctx.sent[0]
    if (start?.type !== "speechToTextStart") throw new Error("speech start message missing")
    ctx.fire({ type: "speechToTextStarted", requestId: start.requestId })
    ctx.speech.stop()
    if (outcome === "result") ctx.fire({ type: "speechToTextResult", requestId: start.requestId, text: "" })
    if (outcome === "error")
      ctx.fire({ type: "speechToTextError", requestId: start.requestId, code: "empty_transcript", error: "No speech" })
    expect(ctx.speech.state()).toBe("error")
    expect(resumed).toBe(0)
    expect(failed).toBe(1)
    ctx.dispose()
  }
})

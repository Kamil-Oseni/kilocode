import { expect, test } from "bun:test"
import { createVoiceImages } from "../../webview-ui/src/context/voice-images"
import type { WebviewMessage } from "../../webview-ui/src/types/messages"

test("image acknowledgements are owned and no recorded image outcome is automatically replayed", () => {
  let call: { id: string } | undefined = { id: "call" }
  const sent: WebviewMessage[] = []
  const registered: string[] = []
  const images = createVoiceImages({
    current: () => call,
    post: (message) => sent.push(message),
    register: (id) => {
      registered.push(id)
      return true
    },
  })
  try {
    images.share("first", "data:image/jpeg;base64,AA==")
    images.share("first", "data:image/jpeg;base64,AA==")
    expect(sent).toHaveLength(1)
    images.receive({ type: "speechOpenAIImageResult", requestId: "unrelated", imageID: "first", status: "shared" })
    expect(images.state()?.status).toBe("pending")
    images.receive({ type: "speechOpenAIImageResult", requestId: "call", imageID: "first", status: "unknown" })
    images.share("first", "data:image/jpeg;base64,AA==")
    expect(sent).toHaveLength(1)
    images.receive({ type: "speechOpenAIImageResult", requestId: "call", imageID: "first", status: "shared" })
    expect(images.state()?.status).toBe("shared")
    images.share("second", "data:image/jpeg;base64,AA==")
    images.receive({ type: "speechOpenAIImageResult", requestId: "call", imageID: "second", status: "failed" })
    images.share("second", "data:image/jpeg;base64,AA==")
    expect(sent).toHaveLength(2)
    expect(registered).toEqual(["first", "second"])
    call = undefined
    images.receive({ type: "speechOpenAIImageResult", requestId: "call", imageID: "second", status: "shared" })
    expect(images.state()?.status).toBe("failed")
  } finally {
    images.clear()
  }
})

import { createSignal } from "solid-js"
import type { ExtensionMessage, WebviewMessage } from "../types/messages"

type ImageState = {
  requestId: string
  imageID: string
  status: "pending" | "shared" | "staged" | "unknown" | "failed"
  error?: string
}

export function createVoiceImages(input: {
  current: () => { id: string } | undefined
  register: (id: string) => boolean
  post: (message: WebviewMessage) => void
}) {
  const [state, setState] = createSignal<ImageState>()
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    state,
    clear: () => {
      clearTimeout(timer)
      setState(undefined)
    },
    share(imageID: string, data: string) {
      const call = input.current()
      if (!call) return
      const previous = state()
      if (previous?.imageID === imageID) return
      if (!input.register(imageID)) return
      clearTimeout(timer)
      setState({ requestId: call.id, imageID, status: "pending" })
      timer = setTimeout(() => {
        const pending = state()
        if (pending?.requestId === call.id && pending.imageID === imageID && pending.status === "pending")
          setState({
            ...pending,
            status: "unknown",
            error: "The sharing acknowledgement did not arrive. Check the voice conversation before sharing again.",
          })
      }, 60_000)
      input.post({ type: "speechOpenAIImage", requestId: call.id, imageID, data })
    },
    receive(message: ExtensionMessage) {
      if (message.type !== "speechOpenAIImageResult") return false
      const current = state()
      if (input.current()?.id !== message.requestId || current?.imageID !== message.imageID) return true
      clearTimeout(timer)
      setState(message)
      return true
    },
  }
}

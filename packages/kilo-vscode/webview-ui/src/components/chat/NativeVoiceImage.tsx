import { createSignal, onCleanup, Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVoice } from "../../context/voice"
import { prepare } from "./voice-image"

export const NativeVoiceImage: Component = () => {
  const voice = useVoice()
  const [draft, setDraft] = createSignal<{ id: string; name: string; data: string }>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  let input: HTMLInputElement | undefined
  let generation = 0
  const result = () => (voice.image()?.imageID === draft()?.id ? voice.image() : undefined)
  const connected = () => voice.status() === "listening" || voice.status() === "speaking"
  const blocked = () => !connected() || loading() || result()?.status === "pending"
  const choose = async (file?: File) => {
    if (!file || blocked()) return
    const current = ++generation
    setLoading(true)
    setError(undefined)
    try {
      const image = await prepare(file)
      if (current !== generation) return
      setDraft({ id: crypto.randomUUID(), name: file.name.slice(0, 120), data: image.data })
    } catch (error) {
      if (current === generation) setError(error instanceof Error ? error.message : "Image preparation failed.")
    } finally {
      if (current === generation) setLoading(false)
      if (input) input.value = ""
    }
  }
  onCleanup(() => {
    generation++
  })
  return (
    <div data-slot="native-voice-image">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => void choose(event.currentTarget.files?.[0])}
      />
      <Button variant="ghost" size="small" disabled={blocked()} onClick={() => input?.click()}>
        {loading() ? "Preparing image" : "Choose image for voice"}
      </Button>
      <Show when={voice.live()}>
        <p>Images go to Raya work and its vision model, not GPT-Live.</p>
      </Show>
      <Show when={draft()}>
        {(image) => (
          <>
            <img src={image().data} alt={`Selected image: ${image().name}`} />
            <span>{image().name}</span>
            <p>
              {voice.live() ? "Sharing retains this image for Raya work and its vision model; GPT-Live receives no image. End voice does not delete it." : "Sharing sends this image to OpenAI and retains it with voice/work context. End voice does not delete it."}
            </p>
            <Button
              variant="secondary"
              size="small"
              disabled={blocked() || !!result()}
              onClick={() => voice.share(image().id, image().data)}
            >
              Share image with voice
            </Button>
            <Show when={result()}>
              {(state) => (
                <p role="status">
                  {state().status === "pending"
                    ? "Sharing image"
                    : state().status === "shared"
                      ? "Image shared. Sharing does not start work."
                      : state().status === "staged"
                        ? "Image staged for Raya work. Sharing does not start work."
                      : state().status === "unknown"
                        ? "Sharing outcome unknown. This image will not be sent again automatically."
                        : "Image sharing failed. Choose the image again for a new attempt."}{" "}
                  {state().error}
                </p>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </div>
  )
}

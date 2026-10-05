import { createEffect, createSignal, onCleanup } from "solid-js"

export function createVoiceSession(opts: {
  id: () => string | undefined
  connected: () => boolean
  create: (signal: AbortSignal) => Promise<string | undefined>
  start: (id: string) => void
  prepare?: () => (() => void) | undefined
}) {
  const [pending, setPending] = createSignal(false)
  let controller: AbortController | undefined
  let release: (() => void) | undefined
  const cancel = () => {
    controller?.abort()
    controller = undefined
    const cleanup = release
    release = undefined
    setPending(false)
    cleanup?.()
  }
  createEffect(() => {
    if (!opts.connected()) cancel()
  })
  onCleanup(cancel)
  return {
    pending,
    cancel,
    start() {
      if (pending() || !opts.connected()) return
      const id = opts.id()
      if (id) return opts.start(id)
      const owner = new AbortController()
      controller = owner
      setPending(true)
      if (opts.prepare) {
        try {
          release = opts.prepare()
        } catch (error) {
          cancel()
          console.error("[Raya] Voice audio preparation failed", error)
          return
        }
        if (!release) return cancel()
      }
      void opts
        .create(owner.signal)
        .then((id) => {
          if (controller !== owner || owner.signal.aborted) return
          if (!id || !opts.connected() || opts.id() !== id) return cancel()
          controller = undefined
          release = undefined
          setPending(false)
          opts.start(id)
        })
        .catch((error: unknown) => {
          if (controller !== owner) return
          cancel()
          console.error("[Raya] Voice session creation failed", error)
        })
    },
  }
}

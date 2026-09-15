import { Button } from "@kilocode/kilo-ui/button"
import { Component, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import type { DraftFile } from "./Inbox"

const images = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
const audio = new Set(["audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav"])
const video = new Set(["video/mp4", "video/ogg", "video/webm"])
const media = new Set([...images, ...audio, ...video])

function size(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function previewable(mime: string) {
  return media.has(mime)
}

export const MediaAttachment: Component<{ agentID: string; file: DraftFile; detail?: string }> = (props) => {
  const vscode = useVSCode()
  const [phase, setPhase] = createSignal<"idle" | "loading" | "ready" | "failed">("idle")
  const [src, setSrc] = createSignal("")
  const [error, setError] = createSignal("")
  let root: HTMLLIElement | undefined
  let requestID = ""
  let observer: IntersectionObserver | undefined
  let url = ""

  const open = () =>
    vscode.postMessage({
      type: "routineInboxAttachmentOpen",
      requestID: crypto.randomUUID(),
      agentID: props.agentID,
      attachmentID: props.file.id,
    })

  const load = () => {
    if (phase() === "loading" || phase() === "ready") return
    requestID = crypto.randomUUID()
    setPhase("loading")
    setError("")
    vscode.postMessage({
      type: "routineInboxAttachmentPreview",
      requestID,
      agentID: props.agentID,
      attachmentID: props.file.id,
    })
  }

  const receive = (msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxAttachmentPreviewed" || msg.requestID !== requestID || msg.agentID !== props.agentID)
      return
    const file = msg.file
    if (msg.error) {
      setError(msg.error)
      setPhase("failed")
      return
    }
    if (
      !file ||
      file.id !== props.file.id ||
      file.mime !== props.file.mime ||
      file.size !== props.file.size ||
      !media.has(file.mime) ||
      file.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data)
    ) {
      setError("This media couldn't be verified for preview.")
      setPhase("failed")
      return
    }
    if (images.has(file.mime)) {
      setSrc(`data:${file.mime};base64,${file.data}`)
      setPhase("ready")
      return
    }
    const bytes = Uint8Array.from(atob(file.data), (value) => value.charCodeAt(0))
    if (url) URL.revokeObjectURL(url)
    url = URL.createObjectURL(new Blob([bytes], { type: file.mime }))
    setSrc(url)
    setPhase("ready")
  }

  const unsub = vscode.onMessage(receive)
  onMount(() => {
    if (!root || typeof IntersectionObserver === "undefined") {
      load()
      return
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer?.disconnect()
        load()
      },
      { rootMargin: "160px" },
    )
    observer.observe(root)
  })
  onCleanup(() => {
    observer?.disconnect()
    unsub()
    if (url) URL.revokeObjectURL(url)
  })

  const failed = () => {
    setError("This media couldn't be shown.")
    setPhase("failed")
  }
  const caption = (
    <>
      <span class="routines-file-name">{props.file.name}</span>
      <span class="routines-file-path">
        {props.file.mime} · {size(props.file.size)}
      </span>
      <Show when={props.detail}>
        <span class="routines-file-path">{props.detail}</span>
      </Show>
    </>
  )

  return (
    <li ref={root} class="routines-image-item">
      <Show
        when={phase() === "ready"}
        fallback={
          <div class="routines-media routines-media-placeholder" role="group" aria-label={props.file.name}>
            <span class="routines-image-state" role={phase() === "loading" ? "status" : undefined}>
              {phase() === "failed" ? "Preview unavailable" : "Loading preview…"}
            </span>
            <div class="routines-media-caption">{caption}</div>
          </div>
        }
      >
        <Show
          when={images.has(props.file.mime)}
          fallback={
            <div class="routines-media routines-playback">
              <Show
                when={audio.has(props.file.mime)}
                fallback={
                  <video controls preload="metadata" src={src()} aria-label={props.file.name} onError={failed} />
                }
              >
                <audio controls preload="metadata" src={src()} aria-label={props.file.name} onError={failed} />
              </Show>
              <div class="routines-media-caption">{caption}</div>
              <Button type="button" size="small" variant="ghost" onClick={open}>
                Open file
              </Button>
            </div>
          }
        >
          <button type="button" class="routines-image" aria-label={`Open ${props.file.name}`} onClick={open}>
            <img src={src()} alt={props.file.name} onError={failed} />
            <span class="routines-media-caption">{caption}</span>
          </button>
        </Show>
      </Show>
      <Show when={phase() === "failed"}>
        <Button type="button" size="small" variant="ghost" title={error()} onClick={load}>
          Retry preview
        </Button>
      </Show>
    </li>
  )
}

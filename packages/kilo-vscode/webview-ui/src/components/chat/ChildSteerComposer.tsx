import { Button } from "@kilocode/kilo-ui/button"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { isEnterKeyCommitNotIme } from "../../utils/ime-enter"
import { applySteerResult, canSteer, steerID, steerKey, type ChildSteerDraft } from "./child-steer"

const blank = (): ChildSteerDraft => ({ text: "", stage: "ready" })

export const ChildSteerComposer: Component<{ parentSessionID?: string; childSessionID?: string }> = (props) => {
  const language = useLanguage()
  const session = useSession()
  const vscode = useVSCode()
  const [drafts, setDrafts] = createSignal<Record<string, ChildSteerDraft>>({})
  let root: HTMLDivElement | undefined

  const key = () =>
    props.parentSessionID && props.childSessionID && props.parentSessionID !== props.childSessionID
      ? steerKey(props.parentSessionID, props.childSessionID)
      : undefined
  const draft = () => {
    const id = key()
    return id ? (drafts()[id] ?? blank()) : blank()
  }
  const status = createMemo(() => {
    const id = props.childSessionID
    return id ? session.allStatusMap()[id]?.type : undefined
  })
  const terminal = createMemo(() => draft().code === "inactive" || draft().code === "not-found")
  const active = createMemo(() => !terminal() && (status() === "busy" || status() === "retry"))
  const editable = createMemo(() => !terminal() && status() !== "idle")
  const valid = createMemo(() => canSteer(status(), draft()))

  const update = (next: (value: ChildSteerDraft) => ChildSteerDraft) => {
    const id = key()
    if (!id) return
    setDrafts((items) => ({ ...items, [id]: next(items[id] ?? blank()) }))
  }

  const change = (text: string) =>
    update((value) => ({
      text,
      stage: value.stage === "working" ? value.stage : "ready",
      messageID: value.stage === "working" ? value.messageID : undefined,
    }))

  const submit = () => {
    const parentSessionID = props.parentSessionID
    const childSessionID = props.childSessionID
    const text = draft().text.trim()
    if (!parentSessionID || !childSessionID || !active() || draft().stage === "working") return
    if (!text || text.length > 32_000) return
    const messageID = steerID()
    update((value) => ({ ...value, stage: "working", messageID, code: undefined, error: undefined }))
    vscode.postMessage({ type: "steerChildSession", parentSessionID, childSessionID, messageID, text })
  }

  const notice = createMemo(() => {
    const value = draft()
    if (value.stage === "working") return language.t("task.childSteer.sending")
    if (value.stage === "accepted") return language.t("task.childSteer.sent")
    if (value.stage === "failed") {
      if (value.code === "inactive") return language.t("task.childSteer.finished")
      if (value.code === "stale-run") return language.t("task.childSteer.stale")
      if (value.code === "not-found") return language.t("task.childSteer.notFound")
      return value.error || language.t("task.childSteer.failed")
    }
    if (status() === undefined) return language.t("task.childSteer.checking")
    if (status() === "idle") return language.t("task.childSteer.finished")
    if (status() === "offline") return language.t("task.childSteer.offline")
    if (draft().text.length > 32_000) return language.t("task.childSteer.tooLong")
    return undefined
  })

  onMount(() => {
    const unsub = vscode.onMessage((message) => {
      if (message.type !== "childSteerResult") return
      const id = steerKey(message.parentSessionID, message.childSessionID)
      const value = drafts()[id]
      if (!value || value.stage !== "working" || value.messageID !== message.messageID) return
      setDrafts((items) => applySteerResult(items, message))
      if (message.accepted && id === key()) queueMicrotask(() => root?.querySelector("textarea")?.focus())
    })
    onCleanup(unsub)
  })

  return (
    <Show when={key()}>
      <div ref={root} data-component="child-steer" data-state={draft().stage}>
        <Show when={editable() || draft().stage === "working"}>
          <TextField
            multiline
            label={language.t("task.childSteer.label")}
            hideLabel
            placeholder={language.t("task.childSteer.placeholder")}
            value={draft().text}
            maxLength={32_001}
            disabled={!active() || draft().stage === "working"}
            validationState={draft().text.length > 32_000 ? "invalid" : undefined}
            onChange={change}
            onKeyDown={(event: KeyboardEvent) => {
              if (!isEnterKeyCommitNotIme(event) || event.shiftKey) return
              event.preventDefault()
              submit()
            }}
          />
          <Button
            variant="primary"
            size="small"
            disabled={!active() || !valid()}
            aria-label={language.t("task.childSteer.send")}
            onClick={submit}
          >
            <Show when={draft().stage === "working"}>
              <Spinner />
            </Show>
            {language.t("task.childSteer.send")}
          </Button>
        </Show>
        <Show when={notice()}>
          {(text) => (
            <p
              data-slot="child-steer-status"
              role={draft().stage === "failed" || status() === "offline" ? "alert" : "status"}
              aria-live="polite"
            >
              {text()}
            </p>
          )}
        </Show>
      </div>
    </Show>
  )
}

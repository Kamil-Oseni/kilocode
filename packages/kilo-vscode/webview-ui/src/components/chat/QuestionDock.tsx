/**
 * QuestionDock component
 * Displays question requests from the AI assistant inline above the prompt input.
 * Uses kilo-ui's DockPrompt component for proper surface styling.
 */

import { For, Show, createMemo, createEffect, onCleanup } from "solid-js"
import type { Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { useServer } from "../../context/server"
import { useConfig } from "../../context/config"
import { useProvider } from "../../context/provider"
import { useSpeechToText } from "../speech-to-text/useSpeechToText"
import { canUseSpeechToText, selectedSpeechToTextModel } from "../speech-to-text/availability"
import { useSpeechToTextModels } from "../../context/speech-to-text-models"
import type { QuestionRequest } from "../../types/messages"
import {
  clearActiveQuestionTab,
  questionOptionValue, // raya_change - Milestone C stable option ids
  resolveOptimisticQuestionAgent,
  resolveSelectedQuestionMode,
  setActiveQuestionTab,
  toggleAnswer,
  tr,
} from "./question-dock-utils"
import { isEnterKeyCommitNotIme } from "../../utils/ime-enter"

export const QuestionDock: Component<{ request: QuestionRequest }> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const vscode = useVSCode()
  const server = useServer()
  const { config } = useConfig()
  const provider = useProvider()
  const models = useSpeechToTextModels()
  const speech = useSpeechToText(vscode, server, language, session.currentSessionID)
  const id = props.request.id

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)

  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as string[][],
    custom: [] as string[],
    kinds: [] as Record<string, "option" | "custom">[],
    editing: false,
    sending: false,
    collapsed: false,
  })

  let root!: HTMLDivElement
  let prevAgent: string | undefined

  // Reset sending state and roll back the optimistic agent change on error
  createEffect(() => {
    if (session.questionErrors().has(props.request.id)) {
      setStore("sending", false)
      if (prevAgent !== undefined) {
        session.selectAgent(prevAgent)
        prevAgent = undefined
      }
    }
  })

  // Chat search indexes only the mounted page's options, and there's no
  // other signal exposing which page that is — publish it here so search
  // stays in sync as the user navigates instead of always assuming page 0.
  createEffect(() => setActiveQuestionTab(id, store.tab))
  onCleanup(() => clearActiveQuestionTab(id))

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const dictate = () => {
    if (speech.active()) {
      speech.stop()
      return
    }
    selectCustom()
    speech.start({
      model: selectedSpeechToTextModel(config(), models.models()),
      insert: (text) => {
        updateCustom([store.custom[store.tab], text].filter(Boolean).join(" "))
      },
    })
  }
  const multi = createMemo(() => question()?.multiple === true)

  const total = createMemo(() => questions().length)
  const last = createMemo(() => store.tab >= total() - 1)

  const summary = createMemo(() => `${Math.min(store.tab + 1, total())} of ${total()}`)

  // Localized view of the current question. The wire-format `label` is preserved for reply
  // matching; only the display text goes through `tr()`.
  //
  // translateOption returns accessor functions, not plain strings. SolidJS runs the <For>
  // child callback in an untracked scope (via mapArray), so reading `language.t(...)` once
  // at construction would freeze translations at the first render. Accessors force every
  // JSX read to happen inside the binding's tracking scope, so switching the sidebar
  // language while a question dock is visible re-renders the option labels.
  const questionText = createMemo(() => tr(language.t, question()?.questionKey, question()?.question ?? ""))
  const translateOption = (opt: {
    label: string
    description?: string
    labelKey?: string
    descriptionKey?: string
  }) => ({
    label: () => tr(language.t, opt.labelKey, opt.label),
    description: () => (opt.description ? tr(language.t, opt.descriptionKey, opt.description) : ""),
  })

  const focusPrompt = () => requestAnimationFrame(() => window.dispatchEvent(new Event("focusPrompt")))

  const reply = (answers: string[][]) => {
    if (store.sending) return
    setStore("sending", true)
    session.replyToQuestion(props.request.id, answers)
    focusPrompt()
    // prevAgent is intentionally left set until either questionError (rollback)
    // or the question is dismissed (success — the question unmounts, so no cleanup needed)
  }

  const reject = () => {
    if (store.sending) return
    if (prevAgent !== undefined) {
      session.selectAgent(prevAgent)
      prevAgent = undefined
    }
    setStore("sending", true)
    session.rejectQuestion(props.request.id)
    focusPrompt()
  }

  const submit = () => {
    reply(questions().map((_, i) => [...(store.answers[i] ?? [])]))
  }

  const close = () => setStore("editing", false)

  const back = () => {
    if (store.sending || store.tab <= 0) return
    setStore("tab", store.tab - 1)
    close()
  }

  const syncAgent = (answers: string[][], kinds: Record<string, "option" | "custom">[] = store.kinds) => {
    const mode = resolveSelectedQuestionMode(questions(), answers, kinds)
    const next = resolveOptimisticQuestionAgent(prevAgent, session.selectedAgent(), mode)

    prevAgent = next.base
    if (!next.agent) return
    if (next.agent === session.selectedAgent()) return
    session.selectAgent(next.agent)
  }

  const pick = (answer: string, custom = false) => {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)

    const kinds = [...store.kinds]
    kinds[store.tab] = { [answer]: custom ? "custom" : "option" }
    setStore("kinds", kinds)

    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }

    syncAgent(answers, kinds)

    // Cost alerts use a single affirmative option and should respond on click.
    // Normal questions keep the explicit Submit flow.
    if (single() && props.request.autoSubmit) {
      reply(answers)
      return
    }
  }

  const toggle = (answer: string) => {
    const next = toggleAnswer(store.answers[store.tab] ?? [], answer)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
    const kinds = [...store.kinds]
    const current = { ...(kinds[store.tab] ?? {}) }
    if (next.includes(answer)) current[answer] = "option"
    else delete current[answer]
    kinds[store.tab] = current
    setStore("kinds", kinds)
    syncAgent(answers, kinds)
  }

  const selectTab = (index: number) => {
    setStore("tab", index)
    close()
  }

  const selectCustom = () => {
    if (store.sending) return
    if (!multi()) {
      const answer = store.answers[store.tab]?.[0]
      if (answer && store.kinds[store.tab]?.[answer] !== "custom") {
        const answers = [...store.answers]
        answers[store.tab] = []
        setStore("answers", answers)

        const kinds = [...store.kinds]
        kinds[store.tab] = {}
        setStore("kinds", kinds)
        syncAgent(answers, kinds)
      }
    }
    setStore("editing", true)
  }

  const updateCustom = (value: string) => {
    const inputs = [...store.custom]
    inputs[store.tab] = value
    setStore("custom", inputs)
    if (multi()) return
    const answer = value.trim()
    const answers = [...store.answers]
    answers[store.tab] = answer ? [answer] : []
    setStore("answers", answers)
    const kinds = [...store.kinds]
    kinds[store.tab] = answer ? { [answer]: "custom" } : {}
    setStore("kinds", kinds)
    syncAgent(answers, kinds)
  }

  const selectOption = (optIndex: number) => {
    if (store.sending) return

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      toggle(questionOptionValue(opt)) // raya_change - Milestone C stable option ids
      return
    }
    close()
    pick(questionOptionValue(opt)) // raya_change - Milestone C stable option ids
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    if ((e.target as HTMLElement).tagName === "INPUT") return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const items = Array.from(
      el.querySelectorAll<HTMLButtonElement>("button[data-slot='question-option']:not(:disabled)"),
    )
    if (!items.length) return
    const idx = items.findIndex((b) => b === document.activeElement)
    const next =
      e.key === "ArrowDown"
        ? idx === -1
          ? 0
          : (idx + 1) % items.length
        : idx === -1
          ? items.length - 1
          : (idx - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const handleCustomSubmit = (e: Event) => {
    e.preventDefault()
    if (store.sending) return

    const value = input().trim()
    if (!value) {
      close()
      return
    }

    if (multi()) {
      const existing = store.answers[store.tab] ?? []
      const next = [...existing]
      if (!next.includes(value)) next.push(value)

      const answers = [...store.answers]
      answers[store.tab] = next
      setStore("answers", answers)
      const kinds = [...store.kinds]
      const current = { ...(kinds[store.tab] ?? {}) }
      current[value] = "custom"
      kinds[store.tab] = current
      setStore("kinds", kinds)
      syncAgent(answers, kinds)
      close()
      return
    }

    pick(value, true)
    close()
  }

  const onRoot = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      if (store.editing) {
        close()
        return
      }
      if (props.request.dismissResponse === "continue") {
        session.closeQuestion(props.request.id)
        return
      }
      reject()
      return
    }
    if (isEnterKeyCommitNotIme(e) && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      if (store.sending) return
      if (!confirm() && (store.answers[store.tab]?.length ?? 0) === 0) return
      submit()
      return
    }
  }

  // Keep keyboard navigation when the webview already has focus, but do not
  // steal focus from the editor, terminal, or other VS Code surfaces.
  // preventScroll avoids the browser's focus-into-view behavior fighting
  // createAutoScroll (and yanking the viewport back to the dock while the
  // user has scrolled up to read earlier context).
  createEffect(() => {
    void store.tab
    if (store.tab === 0 || store.collapsed || store.editing || confirm()) return
    requestAnimationFrame(() => {
      if (!document.hasFocus()) return
      const btn = root?.querySelector<HTMLButtonElement>("button[data-slot='question-option']:not(:disabled)")
      btn?.focus({ preventScroll: true })
    })
  })

  return (
    <div
      ref={root}
      data-component="question-dock"
      data-collapsed={store.collapsed ? "true" : "false"}
      data-tone={props.request.tone}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      onKeyDown={onRoot}
    >
      <div data-slot="question-dock-header">
        <div data-slot="question-dock-header-content">
          <Icon name="help" size="small" />
          <div data-slot="question-header-title">Question</div>
        </div>
        <div data-slot="question-header-actions">
          <button
            type="button"
            data-slot="question-progress-nav"
            disabled={store.sending || store.tab <= 0}
            onClick={back}
            aria-label="Previous question"
          >
            <Icon name="chevron-left" size="small" />
          </button>
          <span data-slot="question-progress-count">{summary()}</span>
          <button
            type="button"
            data-slot="question-progress-nav"
            disabled={store.sending || store.tab >= questions().length || (store.answers[store.tab]?.length ?? 0) === 0}
            onClick={() => selectTab(store.tab + 1)}
            aria-label="Next question"
          >
            <Icon name="chevron-right" size="small" />
          </button>
          <button type="button" data-slot="question-close" onClick={reject} aria-label="Close question">
            <Icon name="close" size="small" />
          </button>
        </div>
      </div>

      {/* Animated body — hidden when collapsed */}
      <div data-slot="question-dock-body" inert={store.collapsed || undefined}>
        <div data-slot="question-dock-body-inner">
          <Show when={!confirm()}>
            <div data-slot="question-text" dir="auto">
              {questionText()}
            </div>
            <Show when={multi()}>
              <div data-slot="question-hint">{language.t("ui.question.multiHint")}</div>
            </Show>
            <div data-slot="question-options" onKeyDown={onKey}>
              <For each={options()}>
                {(opt, i) => {
                  const picked = () => store.answers[store.tab]?.includes(questionOptionValue(opt)) ?? false // raya_change
                  const localized = translateOption(opt)
                  return (
                    <button
                      data-slot="question-option"
                      data-picked={picked()}
                      disabled={store.sending}
                      onClick={() => selectOption(i())}
                    >
                      <span data-slot="question-option-number" aria-hidden="true">
                        {i() + 1}
                      </span>
                      <span data-slot="question-option-main">
                        <span data-slot="option-label" dir="auto">
                          {localized.label()}
                        </span>
                        <Show when={localized.description()}>
                          <span data-slot="option-description" dir="auto">
                            {localized.description()}
                          </span>
                        </Show>
                      </span>
                      <Icon name="arrow-right" size="small" class="question-option-arrow" aria-hidden="true" />
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>

          <Show when={confirm()}>
            <div data-slot="question-review">
              <div data-slot="review-title">{language.t("ui.messagePart.review.title")}</div>
              <For each={questions()}>
                {(q, index) => {
                  // raya_change start - Milestone C review shows labels while replies retain stable ids
                  const value = () =>
                    (store.answers[index()] ?? [])
                      .map(
                        (answer) => q.options.find((option) => questionOptionValue(option) === answer)?.label ?? answer,
                      )
                      .join(", ")
                  // raya_change end
                  const answered = () => Boolean(value())
                  return (
                    <div data-slot="review-item">
                      <span data-slot="review-label" dir="auto">
                        {tr(language.t, q.questionKey, q.question)}
                      </span>
                      <span data-slot="review-value" data-answered={answered()} dir="auto">
                        {answered() ? value() : language.t("ui.question.review.notAnswered")}
                      </span>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>

          <div data-slot="question-dock-footer">
            <Show when={!confirm() && question()?.custom !== false}>
              <form data-slot="custom-input-form" onSubmit={handleCustomSubmit}>
                <Icon name="pencil-line" size="small" aria-hidden="true" />
                <input
                  type="text"
                  data-slot="custom-input"
                  aria-label="Write your own response"
                  placeholder="Or write your own response"
                  value={input()}
                  disabled={store.sending}
                  onFocus={selectCustom}
                  onInput={(e) => updateCustom(e.currentTarget.value)}
                />
              </form>
            </Show>
            <div data-slot="question-footer-actions">
              <button
                type="button"
                data-slot="question-microphone"
                aria-label={speech.active() ? "Stop dictation" : "Dictate response"}
                aria-pressed={speech.active()}
                disabled={!canUseSpeechToText(config(), provider.authStates())}
                title={
                  canUseSpeechToText(config(), provider.authStates())
                    ? undefined
                    : "Set up dictation to use the microphone"
                }
                onClick={dictate}
              >
                <svg
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                >
                  <rect x="7" y="2.5" width="6" height="10" rx="3" />
                  <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5m-3 0h6" />
                </svg>
              </button>
              <button
                type="button"
                data-slot="question-skip"
                disabled={store.sending}
                onClick={last() ? submit : () => selectTab(store.tab + 1)}
              >
                Skip
              </button>
              <button
                type="button"
                data-slot="question-next"
                disabled={store.sending || (!confirm() && (store.answers[store.tab]?.length ?? 0) === 0)}
                onClick={last() || confirm() ? submit : () => selectTab(store.tab + 1)}
              >
                {last() || confirm() ? "Submit" : "Next"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import { Icon } from "@kilocode/kilo-ui/icon"
import { createSignal, onCleanup, type Accessor, type ParentComponent } from "solid-js"
import { useSession } from "../../context/session"
import { useProvider } from "../../context/provider"
import { useLanguage } from "../../context/language"
import { sanitizeName, stripSubProviderPrefix } from "../shared/model-selector-utils"

/** Keeps the existing selectors mounted so scoped picker shortcuts still work. */
export const ComposerConfiguration: ParentComponent<{ sessionID: Accessor<string | undefined>; scope: string }> = (
  props,
) => {
  const session = useSession()
  const provider = useProvider()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const selection = () => session.selected(props.sessionID())
  const model = () => provider.findModel(selection())
  const mode = () => {
    const name = session.selectedAgent(props.sessionID())
    return session.agents().find((agent) => agent.name === name)?.displayName ?? name
  }
  const identity = () => {
    const selected = selection()
    if (!selected) return language.t("composer.configuration.unset")
    const name = model()?.name
    return name ? stripSubProviderPrefix(sanitizeName(name)) : selected.modelID
  }
  const events = ["openModePicker", "openModelPicker", "openVariantPicker"]
  const reveal = (event: Event) => {
    if (!(event instanceof CustomEvent) || event.detail?.source !== props.scope) return
    setOpen(true)
  }
  for (const event of events) window.addEventListener(event, reveal, true)
  onCleanup(() => {
    for (const event of events) window.removeEventListener(event, reveal, true)
  })
  let summary: HTMLButtonElement | undefined
  return (
    <div
      class="composer-configuration-shell"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        event.preventDefault()
        setOpen(false)
        summary?.focus()
      }}
    >
      <Collapsible class="composer-configuration" variant="ghost" open={open()} onOpenChange={setOpen} forceMount>
        <Collapsible.Trigger ref={summary}>
          <span class="composer-configuration-value">
            <span>
              {mode()} · {identity()}
            </span>
            {!provider.isModelValid(selection()) && (
              <span class="composer-configuration-warning">
                {language.t(selection() ? "composer.configuration.unavailable" : "composer.configuration.choose")}
              </span>
            )}
          </span>
          <Icon name="chevron-down" size="small" aria-hidden="true" />
        </Collapsible.Trigger>
        <Collapsible.Content hidden={!open()} class="composer-configuration-body">
          <div class="composer-configuration-controls">{props.children}</div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

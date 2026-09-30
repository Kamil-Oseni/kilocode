import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/chat.css"
import "../../webview-ui/preview/preview.css"
import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { I18nProvider } from "@kilocode/kilo-ui/context"
import { ModelCard } from "../../webview-ui/src/components/settings/CustomProviderModelCard"
import { LocalServer } from "../../webview-ui/src/components/settings/CustomProviderLocalServer"
import { validateCustomProvider } from "../../webview-ui/src/components/settings/CustomProviderValidation"
import {
  customProviderModelSettings,
  customProviderLocalInference,
  sanitizeCustomProviderConfig,
} from "../../src/shared/custom-provider"
import { dict } from "../../webview-ui/src/i18n/en"
import { dict as ui } from "@kilocode/kilo-ui/i18n/en"
const t = (key) => dict[key] ?? ui[key] ?? key
const theme = new URLSearchParams(location.search).get("theme") ?? "dark"
document.body.className = `vscode-${theme} pv-theme--${theme}`
document.documentElement.setAttribute("data-theme", "kilo-vscode")
function Fixture() {
  const [form, set] = createStore({
    providerID: "local",
    name: "Local server",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "http://127.0.0.1:1234/v1",
    localInference: undefined,
    apiKey: "",
    models: [
      {
        id: "local-model",
        name: "Local model",
        reasoning: false,
        supportsImages: false,
        modalities: {},
        variants: [],
        tools: false,
      },
    ],
    headers: [],
    saving: false,
  })
  const [errors, issue] = createSignal({})
  const [saved, save] = createSignal()
  const [open, show] = createSignal(true)
  const submit = () => {
    const out = validateCustomProvider({
      form,
      t,
      editing: false,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })
    issue(out.errors.models[0] ?? {})
    if (!out.result) return
    const cfg = sanitizeCustomProviderConfig(out.result.config)
    if (!("value" in cfg)) throw new Error(cfg.error)
    save(cfg.value)
    show(false)
  }
  const reopen = () => {
    set("models", 0, customProviderModelSettings(saved().models["local-model"]))
    set("localInference", customProviderLocalInference(saved()))
    issue({})
    show(true)
  }
  return (
    <main style={{ padding: "16px", "max-width": "760px", margin: "auto" }}>
      <Show when={open()}>
        <LocalServer
          checked={form.localInference === true}
          onChange={(checked) => set("localInference", checked)}
          t={t}
        />
        <ModelCard
          m={form.models[0]}
          errors={errors()}
          t={t}
          canRemove={false}
          onChangeId={(v) => set("models", 0, "id", v)}
          onChangeName={(v) => set("models", 0, "name", v)}
          onChangeReasoning={(v) => set("models", 0, "reasoning", v)}
          onChangeSupportsImages={(v) => set("models", 0, "supportsImages", v)}
          onChangeLimit={(field, v) => {
            set("models", 0, field, v)
            set("models", 0, "limits", true)
            if (field === "input") set("models", 0, "inputSet", true)
          }}
          onChangeTools={(v) => set("models", 0, "tools", v)}
          onRemove={() => {}}
        />
        <button onClick={submit}>Save settings</button>
      </Show>
      <Show when={!open()}>
        <button onClick={reopen}>Reopen settings</button>
      </Show>
      <output data-saved style={{ display: "none" }}>
        {JSON.stringify(saved())}
      </output>
    </main>
  )
}
render(
  () => (
    <I18nProvider value={{ t, locale: () => "en", plural: (key) => t(key) }}>
      <Fixture />
    </I18nProvider>
  ),
  document.getElementById("root"),
)

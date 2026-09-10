import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/dialogs.css"
import "../../webview-ui/preview/preview.css"
import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { DialogProvider, useDialog } from "@kilocode/kilo-ui/context/dialog"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { LanguageContext, useLanguage } from "../../webview-ui/src/context/language"
import { RemoveDialog } from "../../webview-ui/src/components/marketplace/RemoveDialog"
window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage: () => {} })
const theme = new URLSearchParams(location.search).get("theme") ?? "dark"
document.body.className =
  theme === "light" ? "vscode-light" : theme === "contrast" ? "vscode-high-contrast" : "vscode-dark"
document.documentElement.setAttribute("data-theme", "kilo-vscode")
document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark"
document.body.classList.add(theme === "light" ? "pv-theme--light" : "pv-theme--dark")
const colors =
  theme === "light"
    ? { background: "#f5f5f5", foreground: "#222222", weak: "#595959", focus: "#45557a" }
    : theme === "contrast"
      ? { background: "#000000", foreground: "#ffffff", weak: "#ffffff", focus: "#ffff00" }
      : { background: "#1c1c1c", foreground: "#f1f1f1", weak: "#b8b8b8", focus: "#9ab0d6" }
for (const [key, value] of Object.entries({
  "editor-background": colors.background,
  "sideBar-background": colors.background,
  foreground: colors.foreground,
  "font-family": '"Segoe UI", sans-serif',
  "button-background": "#0078a0",
  "button-foreground": "#ffffff",
  "button-hoverBackground": "#006080",
  "button-secondaryBackground": theme === "light" ? "#dddddd" : "#3a3d41",
  "button-secondaryForeground": colors.foreground,
  "button-secondaryHoverBackground": theme === "light" ? "#cccccc" : "#45494e",
  errorForeground: theme === "light" ? "#b42318" : "#ff6b6b",
  "inputValidation-errorBorder": theme === "light" ? "#b42318" : "#ff6b6b",
  "editorMarkerNavigationError-headerBackground": theme === "light" ? "#fbeae8" : "#3a2222",
  descriptionForeground: colors.weak,
  "input-background": colors.background,
  "input-foreground": colors.foreground,
  "input-placeholderForeground": colors.weak,
  "input-border": colors.weak,
  focusBorder: colors.focus,
  contrastBorder: theme === "contrast" ? colors.foreground : "transparent",
}))
  document.documentElement.style.setProperty(`--vscode-${key}`, value)
document.body.style.background = colors.background
document.body.style.color = colors.foreground

function Owned(props) {
  const dialog = useDialog()
  return (
    <Button
      onClick={() =>
        dialog.show(() => (
          <Dialog title="Owned confirmation">
            <Button autofocus onClick={props.dispose}>
              Unmount owner
            </Button>
          </Dialog>
        ))
      }
    >
      Review owned dialog
    </Button>
  )
}
function Boundary() {
  const [mounted, setMounted] = createSignal(true)
  return (
    <Dialog title="Owner boundary">
      <Button autofocus>Keep outer owner</Button>
      <Show when={mounted()}>
        <DialogProvider>
          <Owned dispose={() => setMounted(false)} />
        </DialogProvider>
      </Show>
    </Dialog>
  )
}
function Fixture() {
  const dialog = useDialog()
  const language = useLanguage()
  const [attached, setAttached] = createSignal(true)
  const [actions, setActions] = createSignal(0)
  const [submits, setSubmits] = createSignal(0)
  const [disabled, setDisabled] = createSignal(true)
  const [variant, setVariant] = createSignal("destructive")
  const item = {
    id: "fixture",
    name: "Quarterly reporting skill",
    type: "skill",
    description: "Local fixture",
    category: "productivity",
    githubUrl: "",
    content: "",
    displayName: "Quarterly reporting skill",
    displayCategory: "Productivity",
  }
  const open = () =>
    dialog.show(() => (
      <RemoveDialog
        item={item}
        scope="project"
        onClose={() => dialog.close()}
        onConfirm={() => {
          setActions((n) => n + 1)
          dialog.close()
        }}
      />
    ))
  const translated = () =>
    dialog.show(() => (
      <LanguageContext.Provider
        value={{
          ...language,
          t: (key, params) =>
            key === "marketplace.remove.cancel"
              ? "Vorhandene Konfiguration beibehalten"
              : key === "marketplace.remove.confirm.button"
                ? "Aus Projektkonfiguration entfernen"
                : language.t(key, params),
        }}
      >
        <RemoveDialog
          item={item}
          scope="project"
          onClose={() => dialog.close()}
          onConfirm={() => {
            setActions((n) => n + 1)
            dialog.close()
          }}
        />
      </LanguageContext.Provider>
    ))
  const caller = () =>
    dialog.show(() => (
      <Dialog
        title="Caller confirmation"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          document.querySelector('[data-testid="default"]').focus()
        }}
      >
        <Button autofocus onClick={() => dialog.close()}>
          Keep caller
        </Button>
      </Dialog>
    ))
  const nested = () =>
    dialog.show(() => (
      <Dialog title="Outer confirmation">
        <Button
          autofocus
          onClick={() =>
            dialog.push(() => (
              <Dialog title="Inner confirmation">
                <Button autofocus onClick={() => dialog.close()}>
                  Keep inner
                </Button>
              </Dialog>
            ))
          }
        >
          Review inner
        </Button>
        <Button
          onClick={() =>
            dialog.show(() => (
              <Dialog title="Replacement confirmation">
                <Button autofocus onClick={() => dialog.close()}>
                  Keep replacement
                </Button>
              </Dialog>
            ))
          }
        >
          Replace confirmation
        </Button>
        <Button onClick={() => setAttached(false)}>Detach opener</Button>
      </Dialog>
    ))
  return (
    <main data-dialog-active={dialog.active?.id} style={{ padding: "12px", "max-width": "460px", margin: "auto" }}>
      <h1>Shared confirmation controls</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSubmits((n) => n + 1)
        }}
        style={{ display: "flex", "flex-wrap": "wrap", gap: "12px" }}
      >
        <Button data-testid="default">Default</Button>
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button
          variant={variant()}
          disabled={disabled()}
          data-testid="reactive"
          onClick={() => setActions((n) => n + 1)}
        >
          Destructive action
        </Button>
        <Button type="submit">Submit form</Button>
      </form>
      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "12px", "margin-top": "16px" }}>
        <Button onClick={() => setDisabled(!disabled())}>Toggle disabled</Button>
        <Button onClick={() => setVariant(variant() === "destructive" ? "primary" : "destructive")}>
          Toggle variant
        </Button>
        <Button onClick={open}>Review removal</Button>
        <Button onClick={translated}>Review long labels</Button>
        <Button onClick={caller}>Review caller focus</Button>
        <Button onClick={() => dialog.show(() => <Boundary />)}>Review owner boundary</Button>
        <Show when={attached()}>
          <Button onClick={nested}>Review nested</Button>
        </Show>
      </div>
      <p>
        Actions: <output data-actions>{actions()}</output>; submissions: <output data-submits>{submits()}</output>
      </p>
    </main>
  )
}
render(
  () => (
    <StoryProviders noPadding config={{}}>
      <Fixture />
    </StoryProviders>
  ),
  document.getElementById("root"),
)

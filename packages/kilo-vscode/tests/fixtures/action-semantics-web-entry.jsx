import "@kilocode/kilo-web-ui/styles/button"
import { Button } from "@kilocode/kilo-web-ui/button"
import { ConfirmDialog } from "../../../kilo-console/src/components/ConfirmDialog"
import "../../../kilo-console/src/styles/providers.css"
import "../../../kilo-console/src/styles/responsive.css"
import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"

const scheme = new URLSearchParams(location.search).get("scheme") === "light" ? "light" : "dark"
document.documentElement.dataset.theme = "kilo-console"
document.documentElement.dataset.colorScheme = scheme
document.documentElement.style.colorScheme = scheme
document.body.className = `kilo-console ${scheme === "dark" ? "dark" : ""}`
const colors =
  scheme === "light"
    ? {
        background: "#ffffff",
        foreground: "#252525",
        weak: "#595959",
        muted: "#f0f0f0",
        border: "#767676",
        danger: "#b42318",
      }
    : {
        background: "#252525",
        foreground: "#f5f5f5",
        weak: "#b8b8b8",
        muted: "#404040",
        border: "#a0a0a0",
        danger: "#ff7b72",
      }
for (const [name, value] of Object.entries({
  background: colors.background,
  "background-base": colors.background,
  "background-stronger": colors.background,
  foreground: colors.foreground,
  "text-strong": colors.foreground,
  "text-weak": colors.weak,
  "muted-foreground": colors.weak,
  muted: colors.muted,
  border: colors.border,
  "border-weak-base": colors.border,
  "input-base": colors.muted,
  primary: "#0078a0",
  "primary-foreground": "#ffffff",
  destructive: colors.danger,
  "status-error-base": colors.danger,
  ring: "#0078a0",
  "radius-md": "4px",
  "radius-sm": "2px",
  "radius-lg": "6px",
}))
  document.documentElement.style.setProperty(`--${name}`, value)
document.body.style.background = colors.background
document.body.style.color = colors.foreground

function Fixture() {
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  return (
    <main style={{ padding: "16px", display: "grid", gap: "12px", "max-width": "460px" }}>
      <h1>Web action semantics</h1>
      <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
        <Button intent="primary" scale="compact">
          Primary
        </Button>
        <Button intent="secondary">Secondary</Button>
        <Button intent="quiet" scale="large">
          Quiet
        </Button>
        <Button intent="destructive" pending={busy()}>
          Delete translated configuration permanently
        </Button>
      </div>
      <Button intent="secondary" onClick={() => setOpen(true)}>
        Review deletion
      </Button>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <ConfirmDialog
        open={open()}
        title="Delete saved provider?"
        message="Saved settings will be removed from this project."
        confirm="Delete translated configuration permanently"
        cancel="Keep existing configuration"
        busy={busy()}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setBusy(true)
          setError("Deletion could not be completed. Your saved provider remains available.")
        }}
      />
    </main>
  )
}

render(() => <Fixture />, document.getElementById("root"))

// raya_change - searchable, indexed settings finder. Surfaces every contributed raya.* setting
// (including application-scoped ones like raya.selfHeal.sourcePath that have no custom control)
// plus the settings tabs themselves, so nothing is undiscoverable. Tab hits jump to the tab;
// bare-setting hits deep-link into VS Code's native Settings filtered to that exact key.
import { Component, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useVSCode } from "../../context/vscode"

type CatalogEntry = { key: string; title: string; detail: string; scope: string }
type NavItem = { value: string; title: string }
type Result =
  | { kind: "tab"; id: string; title: string; detail: string }
  | { kind: "setting"; id: string; title: string; detail: string }

function catalog(): CatalogEntry[] {
  const raw = (window as unknown as { RAYA_SETTINGS_CATALOG?: CatalogEntry[] }).RAYA_SETTINGS_CATALOG
  return Array.isArray(raw) ? raw : []
}

function match(query: string, ...fields: string[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = fields.join(" ").toLowerCase()
  return terms.every((term) => hay.includes(term))
}

const SettingsSearch: Component<{ navItems: NavItem[]; onNavigate: (value: string) => void }> = (props) => {
  const vscode = useVSCode()
  const [query, setQuery] = createSignal("")
  const [open, setOpen] = createSignal(false)

  const results = createMemo<Result[]>(() => {
    const q = query().trim()
    if (!q) return []
    const tabs: Result[] = props.navItems
      .filter((item) => match(q, item.title, item.value))
      .map((item) => ({ kind: "tab", id: item.value, title: item.title, detail: "Open settings tab" }))
    const settings: Result[] = catalog()
      .filter((entry) => match(q, entry.key, entry.title, entry.detail))
      .map((entry) => ({ kind: "setting", id: entry.key, title: entry.title, detail: entry.key }))
    return [...tabs, ...settings].slice(0, 12)
  })

  const choose = (result: Result) => {
    if (result.kind === "tab") props.onNavigate(result.id)
    else vscode.postMessage({ type: "openVSCodeSettings", query: result.id })
    setQuery("")
    setOpen(false)
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setQuery("")
      setOpen(false)
      return
    }
    if (event.key === "Enter") {
      const first = results()[0]
      if (first) {
        event.preventDefault()
        choose(first)
      }
    }
  }

  // Close the dropdown when focus leaves the whole search widget.
  let root: HTMLDivElement | undefined
  const onDocClick = (event: MouseEvent) => {
    if (root && !root.contains(event.target as Node)) setOpen(false)
  }
  document.addEventListener("mousedown", onDocClick)
  onCleanup(() => document.removeEventListener("mousedown", onDocClick))

  return (
    <div ref={root} style={{ position: "relative", flex: "1 1 240px", "min-width": "200px", "max-width": "420px" }}>
      <div style={{ position: "relative", display: "flex", "align-items": "center" }}>
        <span style={{ position: "absolute", left: "8px", display: "flex", "pointer-events": "none", opacity: 0.7 }}>
          <Icon name="search" size="small" />
        </span>
        <input
          type="text"
          value={query()}
          placeholder="Search settings…"
          aria-label="Search settings"
          onInput={(event) => {
            setQuery(event.currentTarget.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          style={{
            width: "100%",
            height: "28px",
            padding: "0 8px 0 28px",
            color: "var(--vscode-input-foreground)",
            background: "var(--vscode-input-background)",
            border: "1px solid var(--vscode-input-border, transparent)",
            "border-radius": "4px",
          }}
        />
      </div>
      <Show when={open() && results().length > 0}>
        <div
          style={{
            position: "absolute",
            top: "32px",
            left: 0,
            right: 0,
            "z-index": 20,
            "max-height": "320px",
            "overflow-y": "auto",
            background: "var(--vscode-dropdown-background, var(--vscode-editor-background))",
            border: "1px solid var(--border-weak-base, var(--vscode-dropdown-border))",
            "border-radius": "4px",
            "box-shadow": "0 4px 12px rgb(0 0 0 / 28%)",
          }}
        >
          <For each={results()}>
            {(result) => (
              <button
                type="button"
                onClick={() => choose(result)}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  width: "100%",
                  padding: "6px 10px",
                  "text-align": "left",
                  color: "var(--vscode-foreground)",
                  background: "transparent",
                  border: "none",
                  "border-bottom": "1px solid var(--border-weak-base)",
                  cursor: "pointer",
                }}
                onMouseEnter={(event) => (event.currentTarget.style.background = "var(--vscode-list-hoverBackground)")}
                onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
              >
                <Icon name={result.kind === "tab" ? "settings-gear" : "edit"} size="small" />
                <span style={{ display: "flex", "flex-direction": "column", "min-width": 0, flex: 1 }}>
                  <span style={{ "font-weight": 600, "font-size": "var(--kilo-font-size-13)" }}>{result.title}</span>
                  <span
                    style={{
                      "font-size": "var(--kilo-font-size-11)",
                      opacity: 0.7,
                      "white-space": "nowrap",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                    }}
                  >
                    {result.detail}
                  </span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default SettingsSearch

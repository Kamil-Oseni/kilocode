import { Component, For, Show, createEffect, createSignal } from "solid-js"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"

import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useMemory, type MemoryContextValue } from "../../context/memory"
import { useIndexing } from "../../context/indexing"
import { useServer } from "../../context/server"
import SettingsRow from "./SettingsRow"
import { SecondBrain } from "./SecondBrain"

export function MemoryActions(props: { memory: MemoryContextValue }) {
  const [correction, setCorrection] = createSignal("")
  const [forgotten, setForgotten] = createSignal("")
  const [review, setReview] = createSignal<{ operation: "correct" | "forget"; text: string; root: string }>()
  createEffect(() => {
    const proposal = review()
    if (proposal && (proposal.root !== props.memory.status()?.root || !props.memory.enabled())) setReview()
  })
  const preview = (operation: "correct" | "forget", value: string) => {
    const root = props.memory.status()?.root
    if (!root || !value.trim() || props.memory.pending()) return
    setReview({ operation, text: value.trim(), root })
  }
  const apply = () => {
    const proposal = review()
    if (!proposal || proposal.root !== props.memory.status()?.root || props.memory.pending()) return
    const accepted =
      proposal.operation === "correct" ? props.memory.correct(proposal.text) : props.memory.forget(proposal.text)
    if (accepted) setReview()
  }
  return (
    <div class="raya-memory-actions">
      <SettingsRow
        title="Correct remembered context"
        description="Save the current fact for this project. The historical receipt stays read-only."
      >
        <div class="raya-memory-action">
          <div>
            <TextField
              value={correction()}
              onChange={setCorrection}
              placeholder="What should Raya remember instead?"
              label="Correct remembered context"
              hideLabel
            />
          </div>
          <Button
            intent="primary"
            scale="compact"
            pending={props.memory.pending()}
            disabled={
              props.memory.pending() || !props.memory.enabled() || !props.memory.status()?.root || !correction().trim()
            }
            onClick={() => preview("correct", correction())}
          >
            Review correction
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Remove remembered context"
        description="Describe the stale fact to remove from this project. Raya will report if nothing matched."
        last
      >
        <div class="raya-memory-action">
          <div>
            <TextField
              value={forgotten()}
              onChange={setForgotten}
              placeholder="Which remembered fact is stale?"
              label="Remove remembered context"
              hideLabel
            />
          </div>
          <Button
            intent="destructive"
            scale="compact"
            pending={props.memory.pending()}
            disabled={
              props.memory.pending() || !props.memory.enabled() || !props.memory.status()?.root || !forgotten().trim()
            }
            onClick={() => preview("forget", forgotten())}
          >
            Review removal
          </Button>
        </div>
      </SettingsRow>
      <Show when={review()}>
        {(proposal) => (
          <Card>
            <h4>{proposal().operation === "correct" ? "Review memory correction" : "Review memory removal"}</h4>
            <p>Project: {proposal().root}</p>
            <p>Source: your explicit correction in this form.</p>
            <p>{proposal().text}</p>
            <p>
              {proposal().operation === "correct"
                ? "Save this as the current project fact."
                : "Remove matching project facts. The result will report whether a match was found."}
            </p>
            <Button onClick={apply} disabled={props.memory.pending() || !props.memory.enabled()}>
              {proposal().operation === "correct" ? "Confirm correction" : "Confirm removal"}
            </Button>
            <Button variant="secondary" onClick={() => setReview()}>
              Keep editing
            </Button>
          </Card>
        )}
      </Show>
    </div>
  )
}

export function WorkLocation(props: {
  directory?: string
  root?: string
  scope?: string
  index: { message: string; label: string; tone: "muted" | "warning" | "success" | "error"; loading: boolean }
}) {
  return (
    <>
      <h4 style={{ "margin-top": "16px", "margin-bottom": "8px" }}>Work location and indexed context</h4>
      <Card>
        <SettingsRow title="Active work location" description={props.directory ?? "No project directory is connected."}>
          <span>{props.directory ? "Connected" : "Unavailable"}</span>
        </SettingsRow>
        <SettingsRow
          title="Memory scope"
          description={props.root ?? "Memory scope has not been loaded for this project."}
        >
          <span>{props.scope ?? "Unknown"}</span>
        </SettingsRow>
        <SettingsRow title="Codebase index" description={props.index.message} last>
          <span class={`indexing-status-badge indexing-status-badge--${props.index.tone}`}>
            {props.index.loading ? "Loading" : props.index.label}
          </span>
        </SettingsRow>
      </Card>
    </>
  )
}

function ContextScope(props: { memory: MemoryContextValue }) {
  const indexing = useIndexing()
  const server = useServer()
  return (
    <WorkLocation
      directory={server.workspaceDirectory() || undefined}
      root={props.memory.status()?.root}
      scope={props.memory.status()?.state.scope}
      index={{
        message: indexing.status().message,
        label: indexing.label(),
        tone: indexing.tone(),
        loading: indexing.loading(),
      }}
    />
  )
}

const ContextTab: Component = () => {
  const { config, updateConfig } = useConfig()
  const memory = useMemory()
  const language = useLanguage()
  const [newPattern, setNewPattern] = createSignal("")

  const patterns = () => config().watcher?.ignore ?? []
  const limit = () => {
    const value = config().compaction?.threshold_percent
    return value === null || value === undefined ? "" : String(value)
  }

  const saveLimit = (value: string) => {
    const raw = value.trim()
    if (!raw) {
      updateConfig({ compaction: { ...config().compaction, threshold_percent: null } })
      return
    }

    const percent = Number(raw)
    if (!Number.isFinite(percent)) return
    const next = Math.min(100, Math.max(1, percent))
    updateConfig({ compaction: { ...config().compaction, threshold_percent: next } })
  }

  const addPattern = () => {
    const value = newPattern().trim()
    if (!value) return
    const current = [...patterns()]
    if (!current.includes(value)) {
      current.push(value)
      updateConfig({ watcher: { ignore: current } })
    }
    setNewPattern("")
  }

  const removePattern = (index: number) => {
    const current = [...patterns()]
    current.splice(index, 1)
    updateConfig({ watcher: { ignore: current } })
  }

  const memoryStats = () => {
    const status = memory.status()
    if (!status) return language.t("settings.context.memory.status.notLoaded")
    if (!status.state.enabled) return language.t("settings.context.memory.status.disabled")
    if (status.index.estimatedTokens === 0) return language.t("chat.memory.project.empty")
    const tokens = status.index.estimatedTokens.toLocaleString(language.locale())
    return language.t("settings.context.memory.status.enabledTokens", { tokens })
  }

  return (
    <div>
      <SecondBrain />
      <h4 style={{ "margin-top": "0", "margin-bottom": "8px" }}>{language.t("settings.context.memory.title")}</h4>
      <Card>
        <SettingsRow title={language.t("settings.context.memory.project.title")} description={memoryStats()}>
          <Switch
            checked={memory.enabled()}
            onChange={(checked) => (checked ? memory.enable() : memory.disable())}
            hideLabel
            disabled={memory.pending()}
          >
            {language.t("settings.context.memory.project.title")}
          </Switch>
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.context.memory.autoSave.title")}
          description={language.t("settings.context.memory.autoSave.description")}
        >
          <Switch
            checked={memory.status()?.state.autoConsolidate ?? true}
            onChange={(checked) => memory.auto(checked ? "on" : "off")}
            hideLabel
            disabled={memory.pending() || !memory.status()}
          >
            {language.t("settings.context.memory.autoSave.title")}
          </Switch>
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.context.memory.storage.title")}
          description={
            memory.enabled()
              ? language.t("settings.context.memory.storage.path", { path: memory.status()!.root })
              : language.t("settings.context.memory.storage.enable")
          }
        >
          <Button
            variant="secondary"
            size="small"
            icon="eye"
            disabled={memory.loading() || memory.pending() || !memory.enabled() || memory.totalTokens() === 0}
            onClick={() => memory.inspect()}
          >
            {language.t("settings.context.memory.inspect")}
          </Button>
        </SettingsRow>
        <MemoryActions memory={memory} />
        <Show when={memory.error()}>
          {(err) => (
            <div
              style={{
                padding: "8px 12px",
                color: "var(--vscode-errorForeground)",
                "font-size": "var(--kilo-font-size-12)",
              }}
            >
              {err()}
            </div>
          )}
        </Show>
      </Card>

      <ContextScope memory={memory} />

      {/* Compaction settings */}
      <h4 style={{ "margin-top": "16px", "margin-bottom": "8px" }}>
        {language.t("settings.context.compaction.title")}
      </h4>
      <Card>
        <SettingsRow
          title={language.t("settings.context.autoCompaction.title")}
          description={language.t("settings.context.autoCompaction.description")}
        >
          <Switch
            checked={config().compaction?.auto ?? true}
            onChange={(checked) => updateConfig({ compaction: { ...config().compaction, auto: checked } })}
            hideLabel
          >
            {language.t("settings.context.autoCompaction.title")}
          </Switch>
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.context.compactionLimit.title")}
          description={language.t("settings.context.compactionLimit.description")}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "6px", width: "96px" }}>
            <TextField
              type="number"
              min="1"
              max="100"
              step="1"
              value={limit()}
              placeholder="80"
              onChange={saveLimit}
              hideLabel
              label={language.t("settings.context.compactionLimit.title")}
            />
            <span style={{ color: "var(--text-weak-base, var(--vscode-descriptionForeground))" }}>%</span>
          </div>
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.context.prune.title")}
          description={language.t("settings.context.prune.description")}
          last
        >
          <Switch
            checked={config().compaction?.prune ?? true}
            onChange={(checked) => updateConfig({ compaction: { ...config().compaction, prune: checked } })}
            hideLabel
          >
            {language.t("settings.context.prune.title")}
          </Switch>
        </SettingsRow>
      </Card>

      <h4 style={{ "margin-top": "16px", "margin-bottom": "8px" }}>{language.t("settings.context.watcherPatterns")}</h4>

      <Card>
        <div
          style={{
            "font-size": "var(--kilo-font-size-12)",
            color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
            "padding-bottom": "8px",
            "border-bottom": patterns().length > 0 || newPattern() ? "1px solid var(--border-weak-base)" : "none",
          }}
        >
          {language.t("settings.context.watcherPatterns.description")}
        </div>

        {/* Add new pattern */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            "align-items": "center",
            padding: "8px 0",
            "border-bottom": patterns().length > 0 ? "1px solid var(--border-weak-base)" : "none",
          }}
        >
          <div style={{ flex: 1 }}>
            <TextField
              value={newPattern()}
              placeholder="e.g. **/node_modules/**"
              onChange={(val) => setNewPattern(val)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") addPattern()
              }}
            />
          </div>
          <Button variant="secondary" onClick={addPattern}>
            {language.t("common.add")}
          </Button>
        </div>

        {/* Pattern list */}
        <For each={patterns()}>
          {(pattern, index) => (
            <div
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
                padding: "6px 0",
                "border-bottom": index() < patterns().length - 1 ? "1px solid var(--border-weak-base)" : "none",
              }}
            >
              <span
                style={{
                  "font-family": "var(--vscode-editor-font-family, monospace)",
                  "font-size": "var(--kilo-font-size-12)",
                }}
              >
                {pattern}
              </span>
              <IconButton size="small" variant="ghost" icon="close" onClick={() => removePattern(index())} />
            </div>
          )}
        </For>
      </Card>
    </div>
  )
}

export default ContextTab

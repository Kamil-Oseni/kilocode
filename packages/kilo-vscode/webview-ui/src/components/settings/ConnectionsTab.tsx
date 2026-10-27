import { Component, createEffect, createMemo, createSignal, For, Show, on } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { inventory } from "../../../../src/shared/connections"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useServer } from "../../context/server"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { mergeScopedConfig } from "../../utils/config-utils"
import type { McpConfig } from "../../types/messages"
import { mcpEnabledPatch } from "./agent-behaviour-patches"
import McpEditView from "./McpEditView"
import SettingsRow from "./SettingsRow"

const ConnectionsTab: Component = () => {
  const cfg = useConfig()
  const language = useLanguage()
  const server = useServer()
  const session = useSession()
  const vscode = useVSCode()
  const dialog = useDialog()
  const [editing, setEditing] = createSignal<{ id: string; origin: "global" | "project"; directory: string }>()
  const value = (row: { name: string; origin: string }): McpConfig => {
    const source =
      row.origin === "project" ? cfg.projectConfig() : row.origin === "global" ? cfg.globalConfig() : undefined
    return (
      mergeScopedConfig(
        { mcp: { [row.name]: cfg.config().mcp?.[row.name] ?? {} } },
        { mcp: { [row.name]: source?.mcp?.[row.name] ?? {} } },
      ).mcp?.[row.name] ?? {}
    )
  }
  const entries = createMemo(() => {
    const data = inventory({ mcp: cfg.config().mcp, collections: cfg.collections(), status: session.mcpStatus() })
    return { ...data, items: data.items.map((row) => ({ ...row, enabled: value(row).enabled !== false })) }
  })
  const selected = createMemo(() => {
    const value = editing()
    if (!value || value.directory !== server.workspaceDirectory()) return
    return entries().items.find((item) => item.id === value.id && item.origin === value.origin && item.editable)
  })
  const busy = () => !server.isConnected() || session.mcpLoading() !== null || cfg.isDirty() || cfg.saving()
  const edit = (id: string) => {
    const row = entries().items.find((item) => item.id === id && item.editable)
    if (!server.isConnected() || !row || (row.origin !== "project" && row.origin !== "global")) return
    setEditing({ id: row.id, origin: row.origin, directory: server.workspaceDirectory() })
  }
  const update = (partial: Partial<McpConfig>) => {
    const row = selected()
    if (!server.isConnected() || !row || (row.origin !== "project" && row.origin !== "global")) return
    const write = row.origin === "project" ? cfg.updateProjectConfig : cfg.updateGlobalConfig
    write({ mcp: { [row.name]: partial } })
  }
  const toggle = (id: string) => {
    const row = entries().items.find((item) => item.id === id && item.editable)
    if (!server.isConnected() || !row || (row.origin !== "project" && row.origin !== "global")) return
    const write = row.origin === "project" ? cfg.updateProjectConfig : cfg.updateGlobalConfig
    write(mcpEnabledPatch(row.name, !row.enabled))
  }
  const connect = (id: string) => {
    const row = entries().items.find((item) => item.id === id)
    if (busy() || !row || (!row.enabled && row.status !== "connected")) return
    if (row.status === "connected") {
      session.disconnectMcp(row.name, server.workspaceDirectory())
      return
    }
    session.connectMcp(row.name, server.workspaceDirectory())
  }
  createEffect(
    on(
      () => server.workspaceDirectory(),
      () => setEditing(undefined),
      { defer: true },
    ),
  )
  const remove = (name: string) => {
    const directory = server.workspaceDirectory()
    dialog.show(() => (
      <Dialog title={language.t("settings.agentBehaviour.removeMcp.title")} fit>
        <div class="dialog-confirm-body">
          <p>{language.t("settings.connections.removeConfirm", { name })}</p>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (
                  server.workspaceDirectory() !== directory ||
                  busy() ||
                  !entries().items.some((item) => item.name === name && item.removable)
                )
                  return
                dialog.close()
                setEditing(undefined)
                session.removeMcp(name, directory)
              }}
            >
              {language.t("settings.agentBehaviour.removeMcp.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }
  const status = (value: ReturnType<typeof inventory>["items"][number]["status"]) => {
    const key = {
      connected: "mcp.status.connected",
      failed: "mcp.status.failed",
      needs_auth: "mcp.status.needs_auth",
      disabled: "mcp.status.disabled",
      needs_client_registration: "mcp.status.needs_registration",
      unknown: "settings.connections.unknown",
    }[value]
    return key ? language.t(key) : language.t("settings.connections.unknown")
  }
  return (
    <div data-component="connections-settings">
      <Card>
        <p>{language.t("settings.connections.description")}</p>
        <p>{language.t("settings.connections.authority")}</p>
        <p>{language.t("settings.connections.save")}</p>
      </Card>
      <Show when={!server.isConnected()}>
        <p role="status">{language.t("settings.connections.offline")}</p>
      </Show>
      <Show
        when={selected()}
        fallback={
          <>
            <div data-slot="connections-actions">
              <Button
                variant="secondary"
                size="small"
                onClick={() => vscode.postMessage({ type: "openMarketplacePanel" })}
              >
                {language.t("settings.agentBehaviour.mcpBrowseMarketplace")}
              </Button>
            </div>
            <Show when={entries().items.length} fallback={<Card>{language.t("settings.connections.empty")}</Card>}>
              <For each={entries().items}>
                {(item) => (
                  <Card>
                    <SettingsRow
                      title={item.name}
                      description={language.t("settings.connections.status", { status: status(item.status) })}
                      last
                    >
                      <div data-slot="connections-actions">
                        <Show when={item.status === "needs_auth"}>
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={busy() || (!item.enabled && item.status !== "connected")}
                            onClick={() => {
                              if (busy()) return
                              session.authenticateMcp(item.name, server.workspaceDirectory())
                            }}
                          >
                            {language.t("common.signIn")}
                          </Button>
                        </Show>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={busy() || (!item.enabled && item.status !== "connected")}
                          onClick={() => connect(item.id)}
                        >
                          {language.t(
                            item.status === "connected"
                              ? "settings.connections.disconnect"
                              : "settings.connections.connect",
                          )}
                        </Button>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={!item.editable || !server.isConnected() || cfg.saving()}
                          onClick={() => toggle(item.id)}
                        >
                          {language.t(item.enabled ? "settings.connections.pause" : "settings.connections.enable")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={!item.editable || !server.isConnected()}
                          onClick={() => edit(item.id)}
                        >
                          {language.t("settings.connections.configure")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="small"
                          disabled={!item.removable || busy()}
                          onClick={() => remove(item.name)}
                        >
                          {language.t("settings.connections.remove")}
                        </Button>
                      </div>
                    </SettingsRow>
                    <dl data-slot="connections-details">
                      <dt>{language.t("settings.connections.transport")}</dt>
                      <dd>{language.t(`settings.connections.transport.${item.transport}`)}</dd>
                      <dt>{language.t("settings.connections.origin")}</dt>
                      <dd>{language.t(`settings.connections.origin.${item.origin}`)}</dd>
                      <dt>{language.t("settings.connections.configuration")}</dt>
                      <dd>
                        {language.t(item.enabled ? "settings.connections.enabled" : "settings.connections.paused")}
                      </dd>
                      <dt>{language.t("settings.connections.account")}</dt>
                      <dd>{language.t("settings.connections.unverified")}</dd>
                    </dl>
                    <Show when={!item.editable}>
                      <p>{language.t("settings.connections.inherited")}</p>
                    </Show>
                  </Card>
                )}
              </For>
            </Show>
            <Show when={entries().omitted}>
              <p role="status">{language.t("settings.connections.omitted", { count: entries().omitted })}</p>
            </Show>
          </>
        }
      >
        {(item) => (
          <McpEditView
            name={item().name}
            value={value(item())}
            onBack={() => setEditing(undefined)}
            onRemove={remove}
            onUpdate={update}
          />
        )}
      </Show>
    </div>
  )
}

export default ConnectionsTab

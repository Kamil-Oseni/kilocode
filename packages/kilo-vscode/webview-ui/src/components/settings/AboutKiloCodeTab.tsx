import { Component, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { useConfig } from "../../context/config"
import { useVoice } from "../../context/voice" // raya_change - include non-secret speech preferences in transfer
import type { Config, ConnectionState, MigrationSource } from "../../types/messages"
import { buildExport, parseImport, MAX_IMPORT_SIZE } from "./settings-io"

export interface AboutKiloCodeTabProps {
  port: number | null
  connectionState: ConnectionState
  extensionVersion?: string
  onMigrationClick?: (source: MigrationSource) => void // legacy-migration
}

const AboutKiloCodeTab: Component<AboutKiloCodeTabProps> = (props) => {
  const language = useLanguage()
  const vscode = useVSCode()
  const { globalConfig, projectConfig, updateConfig, updateGlobalConfig, updateProjectConfig } = useConfig()
  const voice = useVoice() // raya_change
  const [importing, setImporting] = createSignal(false)

  const open = (url: string) => {
    vscode.postMessage({ type: "openExternal", url })
  }

  const importConfig = (config: Config) => {
    const enabled = config.indexing?.enabled
    if (enabled === undefined) {
      updateConfig(config)
      return
    }

    const indexing = { ...config.indexing }
    delete indexing.enabled
    const next = { ...config }
    if (Object.keys(indexing).length > 0) next.indexing = indexing
    else delete next.indexing

    updateConfig(next)
    updateGlobalConfig({ indexing: { enabled } })
  }

  // raya_change start - export both config scopes and speech preferences without credentials
  const handleExport = () => {
    const payload = buildExport({
      global: globalConfig(),
      project: projectConfig(),
      speech: voice.settings(),
    })
    const json = JSON.stringify(payload, null, 2)
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "raya-settings.json" // raya_change - Milestone I non-secret settings transfer
    a.click()
    URL.revokeObjectURL(url)
  }
  // raya_change end

  // ----- Import -----
  const handleImport = () => {
    if (importing()) return
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".json"
    input.style.display = "none"
    input.addEventListener("change", () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > MAX_IMPORT_SIZE) {
        showToast({ variant: "error", title: language.t("settings.aboutKiloCode.importSettings.tooLarge") })
        return
      }
      setImporting(true)
      const reader = new FileReader()
      reader.onload = () => {
        setImporting(false)
        const text = reader.result as string
        const result = parseImport(text)
        if (!result.ok) {
          const key =
            result.error === "invalidJson"
              ? "settings.aboutKiloCode.importSettings.invalidJson"
              : "settings.aboutKiloCode.importSettings.invalidConfig"
          showToast({ variant: "error", title: language.t(key) })
          return
        }
        if (result.warning === "newerVersion") {
          showToast({
            variant: "default",
            title: language.t("settings.aboutKiloCode.importSettings.newerVersion"),
          })
        }
        // raya_change start - v2 restores original scopes; v1 retains legacy scope splitting
        if (result.scopes) {
          updateGlobalConfig(result.scopes.global)
          updateProjectConfig(result.scopes.project)
        } else {
          importConfig(result.config)
        }
        if (result.speech) voice.update(result.speech)
        // raya_change end
        showToast({
          variant: "success",
          title: language.t("settings.aboutKiloCode.importSettings.success"),
        })
      }
      reader.onerror = () => {
        setImporting(false)
        showToast({ variant: "error", title: language.t("settings.aboutKiloCode.importSettings.invalidJson") })
      }
      reader.readAsText(file)
    })
    document.body.appendChild(input)
    input.click()
    document.body.removeChild(input)
  }

  const getStatusColor = () => {
    switch (props.connectionState) {
      case "connected":
        return "var(--vscode-testing-iconPassed, #89d185)"
      case "connecting":
        return "var(--vscode-testing-iconQueued, #cca700)"
      case "disconnected":
        return "var(--vscode-testing-iconFailed, #f14c4c)"
      case "error":
        return "var(--vscode-testing-iconFailed, #f14c4c)"
    }
  }

  const getStatusText = () => {
    switch (props.connectionState) {
      case "connected":
        return language.t("settings.aboutKiloCode.status.connected")
      case "connecting":
        return language.t("settings.aboutKiloCode.status.connecting")
      case "disconnected":
        return language.t("settings.aboutKiloCode.status.disconnected")
      case "error":
        return language.t("settings.aboutKiloCode.status.error")
    }
  }

  const linkStyle = {
    color: "var(--vscode-textLink-foreground)",
    "text-decoration": "none",
    cursor: "pointer",
  } as const

  const sectionStyle = {
    background: "var(--vscode-editor-background)",
    border: "1px solid var(--vscode-panel-border)",
    "border-radius": "4px",
    padding: "16px",
    "margin-bottom": "16px",
  } as const

  const headingStyle = {
    "font-size": "var(--kilo-font-size-13)",
    "font-weight": "600",
    "margin-bottom": "12px",
    "margin-top": "0",
    color: "var(--vscode-foreground)",
  } as const

  const labelStyle = {
    "font-size": "var(--kilo-font-size-12)",
    color: "var(--vscode-descriptionForeground)",
    width: "100px",
  } as const

  const valueStyle = {
    "font-size": "var(--kilo-font-size-12)",
    color: "var(--vscode-foreground)",
    "font-family": "var(--vscode-editor-font-family, monospace)",
  } as const

  return (
    <div>
      {/* Version Information */}
      <div style={sectionStyle}>
        <h4 style={headingStyle}>{language.t("settings.aboutKiloCode.versionInfo")}</h4>
        <div style={{ display: "flex", "align-items": "center" }}>
          <span style={labelStyle}>{language.t("settings.aboutKiloCode.version.label")}</span>
          <span style={valueStyle}>{props.extensionVersion ?? "—"}</span>
        </div>
      </div>

      {/* Community & Support */}
      <div style={sectionStyle}>
        <h4 style={headingStyle}>{language.t("settings.aboutKiloCode.community")}</h4>
        <p
          style={{
            "font-size": "var(--kilo-font-size-12)",
            color: "var(--vscode-descriptionForeground)",
            margin: "0 0 12px 0",
            "line-height": "1.5",
          }}
        >
          {language.t("settings.aboutKiloCode.feedback.prefix")}{" "}
          <span style={linkStyle} onClick={() => open("https://github.com/Kilo-Org/kilocode")}>
            GitHub
          </span>
          ,{" "}
          <span style={linkStyle} onClick={() => open("https://reddit.com/r/kilocode")}>
            Reddit
          </span>
          , {language.t("settings.aboutKiloCode.feedback.or")}{" "}
          <span style={linkStyle} onClick={() => open("https://kilo.ai/discord")}>
            Discord
          </span>
          .
        </p>
        <p
          style={{
            "font-size": "var(--kilo-font-size-12)",
            color: "var(--vscode-descriptionForeground)",
            margin: 0,
            "line-height": "1.5",
          }}
        >
          {language.t("settings.aboutKiloCode.support.prefix")}{" "}
          <span style={linkStyle} onClick={() => open("https://kilo.ai/support")}>
            kilo.ai/support
          </span>
          .
        </p>
      </div>

      {/* Telemetry */}
      <div style={sectionStyle}>
        <h4 style={headingStyle}>{language.t("settings.aboutKiloCode.telemetry.title")}</h4>
        <p
          style={{
            "font-size": "var(--kilo-font-size-12)",
            color: "var(--vscode-descriptionForeground)",
            margin: "0 0 12px 0",
            "line-height": "1.5",
          }}
        >
          {language.t("settings.aboutKiloCode.telemetry.description")}
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => vscode.postMessage({ type: "openVSCodeSettings", query: "telemetry.telemetryLevel" })}
        >
          <Icon name="settings-gear" />
          {language.t("settings.aboutKiloCode.telemetry.openSettings")}
        </Button>
      </div>

      {/* CLI Server */}
      <div style={sectionStyle}>
        <h4 style={headingStyle}>{language.t("settings.aboutKiloCode.cliServer")}</h4>

        {/* Connection Status */}
        <div style={{ display: "flex", "align-items": "center", "margin-bottom": "12px" }}>
          <span style={labelStyle}>{language.t("settings.aboutKiloCode.status.label")}</span>
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <span
              style={{
                width: "8px",
                height: "8px",
                "border-radius": "50%",
                background: getStatusColor(),
                display: "inline-block",
              }}
            />
            <span style={{ "font-size": "var(--kilo-font-size-12)", color: "var(--vscode-foreground)" }}>
              {getStatusText()}
            </span>
          </div>
        </div>

        {/* Port Number */}
        <div style={{ display: "flex", "align-items": "center" }}>
          <span style={labelStyle}>{language.t("settings.aboutKiloCode.port.label")}</span>
          <span style={valueStyle}>{props.port !== null ? props.port : "—"}</span>
        </div>
      </div>

      {/* Settings Transfer */}
      <div style={sectionStyle}>
        <h4 style={headingStyle}>{language.t("settings.aboutKiloCode.settingsTransfer.title")}</h4>
        <p
          style={{
            "font-size": "var(--kilo-font-size-12)",
            color: "var(--vscode-descriptionForeground)",
            margin: "0 0 12px 0",
            "line-height": "1.5",
          }}
        >
          {language.t("settings.aboutKiloCode.settingsTransfer.description")}
        </p>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button variant="secondary" size="small" onClick={handleExport}>
            <Icon name="cloud-upload" />
            {language.t("settings.aboutKiloCode.exportSettings")}
          </Button>
          <Button variant="secondary" size="small" onClick={handleImport} disabled={importing()}>
            <Icon name="download" />
            {language.t("settings.aboutKiloCode.importSettings")}
          </Button>
        </div>
      </div>

      {/* legacy-migration start */}
      <div style={{ ...sectionStyle, "margin-bottom": "0" }}>
        <h4 style={headingStyle}>{language.t("settings.aboutKiloCode.legacyMigration.title")}</h4>
        <p
          style={{
            "font-size": "var(--kilo-font-size-12)",
            color: "var(--vscode-descriptionForeground)",
            margin: "0 0 12px 0",
            "line-height": "1.5",
          }}
        >
          {language.t("settings.aboutKiloCode.legacyMigration.description")}
        </p>
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
          <Button variant="secondary" size="small" onClick={() => props.onMigrationClick?.("legacy")}>
            {language.t("settings.legacyMigration.link")}
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => props.onMigrationClick?.("roo")}
            title={language.t("settings.aboutKiloCode.rooImport.description")}
          >
            {language.t("settings.aboutKiloCode.rooImport.button")}
          </Button>
        </div>
      </div>
      {/* legacy-migration end */}

      {/* Reset Settings */}
      <div style={sectionStyle}>
        <h4 style={headingStyle}>{language.t("settings.aboutKiloCode.resetSettings.title")}</h4>
        <p
          style={{
            "font-size": "var(--kilo-font-size-12)",
            color: "var(--vscode-descriptionForeground)",
            margin: "0 0 12px 0",
            "line-height": "1.5",
          }}
        >
          {language.t("settings.aboutKiloCode.resetSettings.description")}
        </p>
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
          <Button variant="primary" size="small" onClick={() => vscode.postMessage({ type: "resetAllSettings" })}>
            {language.t("settings.aboutKiloCode.resetSettings.button")}
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => vscode.postMessage({ type: "resetReadNotifications" })}
          >
            {language.t("settings.aboutKiloCode.resetSettings.notificationsButton")}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default AboutKiloCodeTab

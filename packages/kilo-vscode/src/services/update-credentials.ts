import * as vscode from "vscode"

const key = "raya.update.token"

/** Serialize migration and explicit edits so an old setting cannot replace a new secret. */
export class UpdateCredentials {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly secrets: Pick<vscode.SecretStorage, "get" | "store" | "delete">,
    private readonly config: () => Pick<vscode.WorkspaceConfiguration, "inspect" | "update">,
  ) {}

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work, work)
    this.pending = next
    return next
  }

  get(): Promise<string> {
    return this.queue(async () => {
      try {
        const cfg = this.config()
        const legacy = cfg.inspect<string>("token")?.globalValue?.trim()
        const saved = await this.secrets.get(key)
        if (!legacy) return saved ?? ""
        if (saved && saved !== legacy) throw new Error("conflicting credentials")
        if (!saved) await this.secrets.store(key, legacy)
        if ((await this.secrets.get(key)) !== legacy) throw new Error("secret verification failed")
        await cfg.update("token", undefined, vscode.ConfigurationTarget.Global)
        return legacy
      } catch {
        throw new Error(
          "Raya update credential migration could not finish. Use Raya: Set Update Token to resolve it. Existing credentials have not been logged.",
        )
      }
    })
  }

  set(value: string): Promise<void> {
    return this.queue(async () => {
      try {
        const token = value.trim()
        if (token) await this.secrets.store(key, token)
        if (!token) await this.secrets.delete(key)
        if (((await this.secrets.get(key)) ?? "") !== token) throw new Error("secret verification failed")
        await this.config().update("token", undefined, vscode.ConfigurationTarget.Global)
      } catch {
        throw new Error(
          "Could not finish saving the Raya update credential. Retry Set Update Token; no credential was written to settings.",
        )
      }
    })
  }
}

export async function configure(credentials: UpdateCredentials) {
  const value = await vscode.window.showInputBox({
    title: "Raya Update Token",
    prompt: "Enter a token for private GitHub releases. Submit an empty value to remove it.",
    password: true,
    ignoreFocusOut: true,
  })
  if (value === undefined) return
  try {
    await credentials.set(value)
    await vscode.window.showInformationMessage(value.trim() ? "Raya update token saved." : "Raya update token removed.")
  } catch (error) {
    await vscode.window.showErrorMessage(
      error instanceof Error ? error.message : "Could not save the Raya update credential.",
    )
  }
}

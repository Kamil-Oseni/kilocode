import * as vscode from "vscode"
import { join } from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"

const key = "raya.update.token"
type Config = {
  inspect(key: string):
    | {
        globalValue?: string
        workspaceValue?: string
        workspaceFolderValue?: string
      }
    | undefined
  update(key: string, value: undefined, target: vscode.ConfigurationTarget): PromiseLike<void>
}

function entries(cfg: Pick<Config, "inspect">) {
  const value = cfg.inspect("token")
  if (!value) return []
  return [
    { target: vscode.ConfigurationTarget.Global, value: value.globalValue },
    { target: vscode.ConfigurationTarget.Workspace, value: value.workspaceValue },
    { target: vscode.ConfigurationTarget.WorkspaceFolder, value: value.workspaceFolderValue },
  ].filter((entry) => entry.value !== undefined)
}

async function clear(cfg: Config) {
  for (const entry of entries(cfg)) await cfg.update("token", undefined, entry.target)
}

/** Serialize migration and explicit edits so an old setting cannot replace a new secret. */
export class UpdateCredentials {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly locks: string | undefined

  constructor(
    private readonly secrets: Pick<vscode.SecretStorage, "get" | "store" | "delete">,
    private readonly config: () => Config,
    root?: string,
  ) {
    this.locks = root ? join(root, ".update-locks") : undefined
  }

  private lock<T>(work: () => Promise<T>) {
    if (!this.locks) return work()
    return Flock.withLock("raya-update-credentials", work, {
      dir: this.locks,
      staleMs: 60_000,
      timeoutMs: 30_000,
    })
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(
      () => this.lock(work),
      () => this.lock(work),
    )
    this.pending = next
    return next
  }

  get(): Promise<string> {
    return this.queue(async () => {
      try {
        const cfg = this.config()
        const found = entries(cfg)
        const values = [
          ...new Set(found.map((entry) => entry.value?.trim()).filter((value): value is string => !!value)),
        ]
        if (values.length > 1) throw new Error("conflicting legacy credentials")
        const legacy = values[0]
        const saved = await this.secrets.get(key)
        if (!found.length) return saved ?? ""
        if (legacy && saved && saved !== legacy) throw new Error("conflicting credentials")
        if (legacy && !saved) await this.secrets.store(key, legacy)
        if (legacy && (await this.secrets.get(key)) !== legacy) throw new Error("secret verification failed")
        await clear(cfg)
        return saved ?? legacy ?? ""
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
        const cfg = this.config()
        if (token) {
          await this.secrets.store(key, token)
          if ((await this.secrets.get(key)) !== token) throw new Error("secret verification failed")
          await clear(cfg)
          return
        }
        await clear(cfg)
        await this.secrets.delete(key)
        if (await this.secrets.get(key)) throw new Error("secret verification failed")
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

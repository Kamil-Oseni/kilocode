/**
 * VS Code adapter implementing the TerminalHost interface.
 */

import * as vscode from "vscode"
import type { TerminalHost, TerminalHandle } from "./SessionTerminalManager"
import path from "node:path"
import { bindTask } from "./run/task-native"
import { TerminalClosure } from "./terminal-closure"

export function createTerminalHost(): TerminalHost {
  const terminalMap = new WeakMap<vscode.Terminal, TerminalHandle>()
  const owners = new WeakMap<vscode.Terminal, TerminalClosure>()

  const wrap = (terminal: vscode.Terminal): TerminalHandle => {
    const existing = terminalMap.get(terminal)
    if (existing) return existing
    const handle: TerminalHandle = {
      show: (preserveFocus) => terminal.show(preserveFocus),
      dispose: () => terminal.dispose(),
      close: () => {
        const owner = owners.get(terminal)
        if (!owner) return Promise.reject(new Error("Terminal native ownership is unavailable"))
        return owner.close(() => terminal.dispose())
      },
      get exitStatus() {
        return terminal.exitStatus ? { code: terminal.exitStatus.code } : undefined
      },
    }
    terminalMap.set(terminal, handle)
    return handle
  }

  return {
    createTerminal: (opts) => {
      const terminal = vscode.window.createTerminal({
        cwd: opts.cwd,
        name: opts.name,
        iconPath: new vscode.ThemeIcon("terminal"),
      })
      const extension = vscode.extensions.getExtension("eden.raya")
      owners.set(
        terminal,
        new TerminalClosure(terminal.processId, (pid) => {
          if (process.platform !== "win32" || !extension)
            return Promise.reject(new Error("Terminal native ownership is unavailable"))
          return bindTask(pid, path.join(extension.extensionPath, "bin", "raya-process-host.exe"))
        }),
      )
      return wrap(terminal)
    },
    activeTerminal: () => {
      const t = vscode.window.activeTerminal
      return t ? wrap(t) : undefined
    },
    repoPath: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    showWarning: (msg) => void vscode.window.showWarningMessage(msg),
    setContext: (key, value) => void vscode.commands.executeCommand("setContext", key, value),
    onTerminalClosed: (cb) =>
      vscode.window.onDidCloseTerminal((terminal) => {
        owners.get(terminal)?.closed()
        cb(wrap(terminal))
      }),
    onActiveTerminalChanged: (cb) =>
      vscode.window.onDidChangeActiveTerminal((terminal) => cb(terminal ? wrap(terminal) : undefined)),
    registerCommand: (id, handler) => vscode.commands.registerCommand(id, handler),
    executeCommand: (id, ...args) => Promise.resolve(vscode.commands.executeCommand(id, ...args)),
  }
}

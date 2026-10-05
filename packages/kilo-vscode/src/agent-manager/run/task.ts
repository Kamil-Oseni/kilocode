/**
 * Legacy integrated terminal Run adapter.
 *
 * Kept while the Agent Manager terminal dropdown offers the "VS Code
 * terminal" option so both execution paths can be compared. Remove this
 * file together with that dropdown option and the integrated `pickRunStart`
 * branch.
 */
import * as vscode from "vscode"
import type { RunHandle } from "./manager"

import path from "node:path"
import { bindTask } from "./task-native"
import { TaskLifetime } from "./task-lifetime"

export interface RunTaskConfig {
  worktreeId: string
  branch: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface RunTaskExit {
  exitCode?: number
  error?: string
}

export async function startVscodeRunTask(config: RunTaskConfig, done: (exit: RunTaskExit) => void): Promise<RunHandle> {
  const proc = new vscode.ProcessExecution(config.command, config.args, {
    cwd: config.cwd,
    env: config.env,
  })
  const task = new vscode.Task(
    { type: "kilo-worktree-run" },
    vscode.TaskScope.Workspace,
    `Run: ${config.branch}`,
    "Raya",
    proc,
    [],
  )
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    showReuseMessage: false,
  }

  const extension = vscode.extensions.getExtension("eden.raya")
  if (process.platform === "win32" && !extension) throw new Error("Run task packaged extension unavailable")
  const events: (
    | { type: "start"; value: vscode.TaskProcessStartEvent }
    | { type: "process"; value: vscode.TaskProcessEndEvent }
    | { type: "end"; value: vscode.TaskEndEvent }
  )[] = []
  let execution: vscode.TaskExecution | undefined
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    for (const listener of listeners) listener.dispose()
    lifetime.dispose()
  }
  const lifetime = new TaskLifetime(
    (exit) => {
      cleanup()
      done(exit)
    },
    process.platform === "win32"
      ? (pid) => bindTask(pid, path.join(extension!.extensionPath, "bin", "raya-process-host.exe"))
      : undefined,
  )
  const dispatch = (event: (typeof events)[number]) => {
    if (!execution) {
      events.push(event)
      return
    }
    if (event.value.execution !== execution) return
    if (event.type === "start") lifetime.started(event.value.processId)
    if (event.type === "process") lifetime.ended(event.value.exitCode)
    if (event.type === "end") lifetime.end()
  }
  const listeners = [
    vscode.tasks.onDidStartTaskProcess((value) => dispatch({ type: "start", value })),
    vscode.tasks.onDidEndTaskProcess((value) => dispatch({ type: "process", value })),
    vscode.tasks.onDidEndTask((value) => dispatch({ type: "end", value })),
  ]
  try {
    execution = await vscode.tasks.executeTask(task)
    for (const event of events.splice(0)) dispatch(event)
  } catch (err) {
    cleanup()
    throw err
  }
  return {
    stop: () => lifetime.stop(() => execution!.terminate()),
    dispose: cleanup,
  }
}

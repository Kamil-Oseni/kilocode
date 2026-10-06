import * as fs from "node:fs"
import * as path from "node:path"
import { getShellEnvironment } from "../shell-env"
import { RunScriptManager, type RunHandle, type RunStatus } from "./manager"
import { RunScriptService } from "./service"
import type { WorktreeStateManager } from "../WorktreeStateManager"
import type { RunTerminalDestination } from "./destination"

export interface RunTaskConfig {
  destination: RunTerminalDestination
  worktreeId: string
  branch: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface RunTaskExit {
  exitCode?: number
  stopped?: boolean
  error?: string
}

export type StartTask = (config: RunTaskConfig, done: (exit: RunTaskExit) => void) => Promise<RunHandle>

interface Options {
  root: () => string | undefined
  state: () => WorktreeStateManager | undefined
  open: (path: string) => Promise<void>
  start: StartTask
  reserve?: () => { start: StartTask; release(): void }
  post: (status: RunStatus) => void
  error: (msg: string) => void
  log: (msg: string) => void
  refresh?: () => void
  env?: () => Promise<Record<string, string>>
}

export class RunController {
  private service: RunScriptService | undefined
  private serviceRoot: string | undefined
  private readonly manager: RunScriptManager
  private retired = false
  private closing: Promise<void> | undefined
  private readonly pending = new Set<Promise<void>>()
  private readonly failures: unknown[] = []

  constructor(private readonly opts: Options) {
    this.manager = new RunScriptManager(opts.log, opts.post)
  }

  state(): { runStatuses: RunStatus[]; runScriptConfigured: boolean; runScriptPath?: string } {
    const service = this.getService()
    const script = service?.resolveScript()
    return {
      runStatuses: this.manager.all(),
      runScriptConfigured: !!script,
      runScriptPath: script?.path,
    }
  }

  configure(): Promise<void> {
    return this.accept(() => this.settings())
  }

  private async settings(): Promise<void> {
    const service = this.getService()
    if (!service) return
    if (!service.hasScript()) await service.createDefaultScript()
    const script = service.resolveScript()
    await this.opts.open(script?.path ?? service.getScriptPath())
    this.opts.refresh?.()
  }

  run(worktreeId: string, destination: RunTerminalDestination): Promise<void> {
    if (this.retired) return Promise.reject(new Error("Run controller intake is retired"))
    const reservation = this.opts.reserve?.()
    return this.accept(() => this.execute(worktreeId, destination, reservation?.start ?? this.opts.start)).finally(() =>
      reservation?.release(),
    )
  }

  private async execute(worktreeId: string, destination: RunTerminalDestination, launch: StartTask): Promise<void> {
    const status = this.manager.status(worktreeId)
    if (status.state !== "idle") {
      this.stop(worktreeId)
      return
    }

    const root = this.opts.root()
    const service = this.getService()
    if (!root || !service) return

    // Resolve cwd and branch: "local" runs from repo root, worktrees from their path.
    // Multi-project qualifies the local key as "<projectId>:local" (see run/message.ts).
    const local = worktreeId === "local" || worktreeId.endsWith(":local")
    const state = this.opts.state()
    const worktree = local ? undefined : state?.getWorktree(worktreeId)
    if (!local && !worktree) {
      this.opts.error("Worktree not found")
      return
    }

    const cwd = local ? root : worktree!.path
    if (!cwd || !path.isAbsolute(cwd)) {
      this.opts.error("Invalid working directory")
      return
    }
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        this.opts.error("Working directory is not a directory")
        return
      }
    } catch {
      this.opts.error("Working directory does not exist")
      return
    }

    const script = service.resolveTask()
    if (!script) {
      await this.settings()
      return
    }

    const branch = local ? "local" : worktree!.branch
    const env = {
      ...(await (this.opts.env ?? getShellEnvironment)()),
      WORKTREE_PATH: cwd,
      REPO_PATH: root,
    }

    const start = () =>
      launch({ destination, worktreeId, branch, command: script.command, args: script.args, cwd, env }, (exit) =>
        this.manager.finish(worktreeId, exit),
      )
    await this.manager.start(worktreeId, start)
  }

  stop(worktreeId: string): void {
    void this.manager.stop(worktreeId).catch((err: unknown) => {
      this.failures.push(err)
    })
  }

  remove(worktreeId: string): Promise<void> {
    return this.accept(() => this.manager.remove(worktreeId))
  }

  fence(): void {
    this.retired = true
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.fence()
    this.closing = (async () => {
      while (this.pending.size) await Promise.all([...this.pending])
      const result = await this.manager.dispose().then(
        () => undefined,
        (err: unknown) => err,
      )
      const errors = [...this.failures, ...(result ? [result] : [])]
      if (errors.length) throw new AggregateError(errors, "Run controller retirement failed")
    })()
    return this.closing
  }

  private accept(body: () => Promise<void>): Promise<void> {
    if (this.retired) return Promise.reject(new Error("Run controller intake is retired"))
    const result = Promise.resolve().then(body)
    const task = result.then(
      () => undefined,
      (err: unknown) => {
        this.failures.push(err)
      },
    )
    this.pending.add(task)
    void task.then(() => this.pending.delete(task))
    return result
  }

  private getService(): RunScriptService | undefined {
    const root = this.opts.root()
    if (!root) return undefined
    if (this.service && this.serviceRoot === root) return this.service
    this.serviceRoot = root
    this.service = new RunScriptService(root)
    return this.service
  }
}

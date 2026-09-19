// raya_change - Milestone E testable live-refresh coordinator
import { resolve } from "node:path"
import type { CanvasBuild } from "./canvas-compiler"
import { CanvasCompiler } from "./canvas-compiler"

function normalize(path: string) {
  const value = resolve(path)
  return process.platform === "win32" ? value.toLowerCase() : value
}

export class CanvasRefresh {
  private active: { root: string; name: string } | undefined

  constructor(
    private readonly compiler: CanvasCompiler,
    private readonly render: (build: CanvasBuild) => Promise<CanvasBuild>,
  ) {}

  use(root: string, name: string) {
    this.active = { root, name }
  }

  async change(path: string) {
    const active = this.active
    if (!active) return
    const source = this.compiler.source(active.root, active.name)
    const data = this.compiler.data(active.root, active.name)
    const changed = normalize(path)
    if (changed !== normalize(source) && changed !== normalize(data)) return
    return this.render(await this.compiler.rebuild(source))
  }
}

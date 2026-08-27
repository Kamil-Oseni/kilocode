// raya_change - Milestone E testable live-refresh coordinator
import type { CanvasBuild } from "./canvas-compiler"
import { CanvasCompiler } from "./canvas-compiler"

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
    if (path !== source && path !== data) return
    return this.render(await this.compiler.rebuild(source))
  }
}

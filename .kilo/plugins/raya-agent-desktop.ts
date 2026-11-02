import type { Plugin } from "@kilocode/plugin"
import desktop from "../skills/raya-agent-desktop/tool"

const plugin: Plugin = async () => ({ tool: { background_desktop: desktop } })

export default plugin

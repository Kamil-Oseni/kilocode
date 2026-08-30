// raya_change - /canvas slash command steers the agent to the create_canvas tool
// instead of hand-rolling a static .html file with the write tool.
import type { Command } from "@/command"

const TEMPLATE = `The user wants a live, interactive canvas rendered beside the chat — not a static file.

Your first tool call MUST be \`create_canvas\`: pass a stable kebab-case \`name\` and a \`source\` that is a single default-exported React TSX component receiving a \`data\` prop. React and the useState, useEffect, useMemo, useCallback, and useRef hooks are already in scope — do not add any \`import\`/\`require\` statements and do not install packages. Use the \`update_canvas\` tool to iterate on the same canvas afterwards.

Do NOT create a standalone .html/.htm file, do NOT use write or edit to hand-roll a page, and do NOT open the in-editor browser for this. The canvas tool compiles the artifact, opens it in the canvas panel, and returns any compile or runtime errors for you to repair in place.

Request:
$ARGUMENTS`

export function canvasCommand(): Command.Info {
  return {
    name: "canvas",
    description: "build a live React canvas beside chat",
    source: "command",
    template: TEMPLATE,
    hints: ["$ARGUMENTS"],
  }
}

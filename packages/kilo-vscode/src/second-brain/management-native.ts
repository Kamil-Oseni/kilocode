import * as vscode from "vscode"
import { randomUUID } from "node:crypto"
import type { Proposal } from "./management-wire"

/** Native review of the exact retained revision; the conversation/model never grants apply authority. */
export async function review(proposal: Proposal, signal: AbortSignal, check: () => void) {
  check()
  const text = JSON.stringify(proposal, null, 2)
  if (Buffer.byteLength(text) > 1048576) throw new Error("Personal Memory review exceeds its bound")
  const uri = vscode.Uri.from({ scheme: "raya-memory-proposal", path: `/${randomUUID()}.txt` })
  const provider = vscode.workspace.registerTextDocumentContentProvider("raya-memory-proposal", {
    provideTextDocumentContent: (requested) => (requested.toString() === uri.toString() ? text : ""),
  })
  try {
    const document = await vscode.workspace.openTextDocument(uri)
    check()
    await vscode.window.showTextDocument(document, { preview: false })
    const answer = await vscode.window.showWarningMessage(
      `Apply only the exact personal Memory change shown? Review SHA-256: ${proposal.digest}. Forgetting removes active recall; existing journals and backups retain history.`,
      { modal: true },
      "Apply reviewed personal change",
    )
    signal.throwIfAborted()
    check()
    return answer === "Apply reviewed personal change" && !document.isClosed && document.getText() === text
  } finally {
    provider.dispose()
  }
}

// raya_change - Raya extension namespace
import * as vscode from "vscode"

export class KiloCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (range.isEmpty) return []

    const actions: vscode.CodeAction[] = []

    const add = new vscode.CodeAction("Add to Raya", vscode.CodeActionKind.RefactorRewrite)
    add.command = { command: "raya.addToContext", title: "Add to Raya" }
    actions.push(add)

    const hasDiagnostics = context.diagnostics.length > 0

    if (hasDiagnostics) {
      const fix = new vscode.CodeAction("Fix with Raya", vscode.CodeActionKind.QuickFix)
      fix.command = { command: "raya.fixCode", title: "Fix with Raya" }
      fix.isPreferred = true
      actions.push(fix)
    }

    if (!hasDiagnostics) {
      const explain = new vscode.CodeAction("Explain with Raya", vscode.CodeActionKind.RefactorRewrite)
      explain.command = { command: "raya.explainCode", title: "Explain with Raya" }
      actions.push(explain)

      const improve = new vscode.CodeAction("Improve with Raya", vscode.CodeActionKind.RefactorRewrite)
      improve.command = { command: "raya.improveCode", title: "Improve with Raya" }
      actions.push(improve)
    }

    return actions
  }
}

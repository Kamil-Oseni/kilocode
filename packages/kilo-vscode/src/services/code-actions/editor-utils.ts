import * as vscode from "vscode"

export interface EditorContext {
  filePath: string
  selectedText: string
  startLine: number
  endLine: number
  diagnostics: vscode.Diagnostic[]
}

export function getEditorContext(): EditorContext | undefined {
  const editor = vscode.window.activeTextEditor
  if (!editor) return undefined
  const selection = editor.selection
  if (selection.isEmpty) return undefined
  const doc = editor.document
  return {
    filePath: vscode.workspace.asRelativePath(doc.uri),
    selectedText: doc.getText(selection),
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    diagnostics: vscode.languages.getDiagnostics(doc.uri).filter((d) => d.range.intersection(selection) !== undefined),
  }
}

// Like getEditorContext, but falls back to the cursor's current line when there
// is no selection, so an inline-edit trigger (Cmd/Ctrl+I) works even without
// the user first selecting text.
export function getEditorContextOrLine(): EditorContext | undefined {
  const editor = vscode.window.activeTextEditor
  if (!editor) return undefined
  const doc = editor.document
  const selection = editor.selection
  const range = selection.isEmpty ? doc.lineAt(selection.active.line).range : selection
  return {
    filePath: vscode.workspace.asRelativePath(doc.uri),
    selectedText: doc.getText(range),
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
    diagnostics: vscode.languages.getDiagnostics(doc.uri).filter((d) => d.range.intersection(range) !== undefined),
  }
}

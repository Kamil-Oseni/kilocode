import * as vscode from "vscode"

/** Cancellation asks the native prompt to close; its original operation must still settle. */
export async function pick<T>(signal: AbortSignal, work: (token: vscode.CancellationToken) => Thenable<T>): Promise<T> {
  signal.throwIfAborted()
  const source = new vscode.CancellationTokenSource()
  const cancel = () => source.cancel()
  signal.addEventListener("abort", cancel, { once: true })
  try {
    const result = await work(source.token)
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener("abort", cancel)
    source.dispose()
  }
}

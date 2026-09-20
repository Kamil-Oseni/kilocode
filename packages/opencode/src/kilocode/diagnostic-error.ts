// raya_change - secret-safe diagnostic receipts shared by session and HTTP boundaries
import { NamedError } from "@opencode-ai/core/util/error"

export namespace DiagnosticError {
  export function make(input: { code: string; message: string }) {
    const ref = `err_${crypto.randomUUID().slice(0, 8)}`
    return {
      ref,
      error: new NamedError.Unknown({ message: input.message, code: input.code, ref }).toObject(),
    }
  }
}

export const recoveryCopy = {
  startup: {
    preserved: "Your conversations and drafts remain saved.",
    next: "Retry the connection. Open technical details if it fails again.",
  },
  assistant: {
    preserved: "Your prompt, conversation, and completed work remain available.",
    next: "Review the technical details, then retry or choose another configured model.",
    auth: "Your prompt and conversation remain available while you reconnect.",
  },
  turn: {
    preserved: "Your prompt, conversation, and completed work remain available.",
    continue: "Review the partial result, then continue the conversation when ready.",
    filtered: "Revise the request or choose another configured model before continuing.",
    error: "Open the error details, then retry or choose another configured model.",
  },
} as const

// raya_change - new file. The server stamps every new session with a default title of the form
// "New session - <ISO>" and only replaces it asynchronously once auto-title generation finishes.
// The native editor tab already masks that placeholder (see native-tab-title.ts), but the webview
// tab strip, task header, and history list showed the raw default, which read to users as
// "New session..."/"Newsession...". Mask it here so those surfaces show a clean label until the
// generated title arrives, mirroring the native behavior.
const DEFAULT_SESSION_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function displayTitle(title: string | undefined | null, fallback: string): string {
  const trimmed = title?.trim()
  return trimmed && !DEFAULT_SESSION_TITLE.test(trimmed) ? trimmed : fallback
}

// The visible tab is authoritative while a fresh draft is being promoted. A
// late session event must not lend its old title to another tab's header.
export function tabSession<T extends { id: string }>(
  active: string | undefined,
  session: T | undefined,
): T | undefined {
  return !active || session?.id === active ? session : undefined
}

export function tabTitle(
  active: string | undefined,
  session: { id: string; title?: string | null } | undefined,
  fallback: string,
): string {
  return displayTitle(tabSession(active, session)?.title, fallback)
}

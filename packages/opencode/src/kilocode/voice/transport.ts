import type { ContextItem } from "./protocol"

/** Voice context stays at the configured media destination; redirects cannot grant another recipient access. */
export async function post(url: string, id: string, item: typeof ContextItem.Type) {
  const response = await fetch(`${url.replace(/\/$/, "")}/v1/sessions/${id}/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item }),
    redirect: "manual",
    signal: AbortSignal.timeout(1000),
  })
  if (!response.ok) throw new Error(`Media injection failed with status ${response.status}`)
}

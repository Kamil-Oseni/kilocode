import type { KiloClient } from "@kilocode/sdk/v2/client"

/** Observe the connected backend's identity, rather than infer it from the extension version. */
export async function build(client: KiloClient) {
  const result = await client.global.health({ signal: AbortSignal.timeout(3000), throwOnError: true })
  const version = result.data?.version
  if (
    result.data?.healthy !== true ||
    typeof version !== "string" ||
    !version.trim() ||
    version.length > 256 ||
    /[\x00-\x1f\x7f]/.test(version)
  )
    throw new Error("The connected backend did not report a valid build identity")
  return version
}

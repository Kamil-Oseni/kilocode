import { For, Show } from "solid-js"
import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import type { provenance } from "../../../../src/shared/memory-provenance"

export function MemoryProvenance(props: { receipt: NonNullable<ReturnType<typeof provenance>>; partID: string }) {
  const title = () =>
    props.receipt.type === "startup" ? "Memory prepared for this step" : "Memory retrieved during this step"
  return (
    <div data-component="memory-provenance" data-part-id={props.partID}>
      <Collapsible variant="ghost">
        <Collapsible.Trigger>
          <span>{title()}</span>
          <span>
            {props.receipt.count === undefined
              ? "Item count not recorded"
              : `${props.receipt.count.toLocaleString()} recorded items`}
          </span>
          <Collapsible.Arrow />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="memory-provenance-body">
            <p>This receipt is not a complete context inventory or proof that the answer relied on this memory.</p>
            <p>
              {props.receipt.tokens === undefined
                ? "Token estimate was not recorded."
                : `${props.receipt.tokens.toLocaleString()} estimated tokens recorded.`}
            </p>
            <Show when={props.receipt.files.length} fallback={<p>Source filenames were not recorded.</p>}>
              <div>
                <strong>Recorded sources</strong>
                <ul>
                  <For each={props.receipt.files}>{(file) => <li>{file}</li>}</For>
                </ul>
                <Show when={props.receipt.truncated}>
                  <p>Showing up to five recorded sources.</p>
                </Show>
              </div>
            </Show>
            <p>
              {props.receipt.captured === undefined
                ? "Preparation or retrieval time was not recorded."
                : `Prepared or retrieved at ${new Date(props.receipt.captured).toLocaleString()}.`}{" "}
              This does not establish whether the stored facts are still current.
            </p>
            <Show when={props.receipt.type === "startup"}>
              <p>Startup memory can be reused from the session's prepared snapshot.</p>
            </Show>
            <p>
              {props.receipt.directory
                ? `Recorded working directory: ${props.receipt.directory}`
                : "Working-directory scope was not recorded."}
            </p>
            <p>
              {props.receipt.project
                ? `Recorded memory scope: ${props.receipt.project}`
                : "Memory-project scope was not recorded."}
            </p>
            <p>
              This historical receipt is read-only. To review or correct stored memory, first open the intended project,
              then use Context settings or the /memory command. This view does not verify that the current workspace
              owns these sources.
            </p>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

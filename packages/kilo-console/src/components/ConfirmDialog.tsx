import { createUniqueId, Show } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Icon } from "@kilocode/kilo-web-ui/icon"
import { focus } from "./dialog-focus"

type Props = {
  open: boolean
  title: string
  message?: string
  confirm?: string
  cancel?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog(props: Props) {
  let cancel: HTMLButtonElement | undefined
  const id = createUniqueId()
  const title = `${id}-title`
  const message = `${id}-message`
  focus(
    () => props.open,
    () => cancel,
  )

  return (
    <Show when={props.open}>
      <div class="confirm-scrim" onKeyDown={(event) => event.key === "Escape" && props.onCancel()}>
        <section
          class="confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={title}
          aria-describedby={props.message ? message : undefined}
        >
          <div class="confirm-body">
            <div class="confirm-icon" aria-hidden="true">
              <Icon name="warning" />
            </div>
            <div>
              <h2 id={title}>{props.title}</h2>
              <Show when={props.message}>{(text) => <p id={message}>{text()}</p>}</Show>
            </div>
          </div>
          <footer class="confirm-actions">
            <Button
              ref={(node: HTMLButtonElement) => (cancel = node)}
              intent="quiet"
              disabled={props.busy}
              onClick={props.onCancel}
            >
              {props.cancel ?? "Cancel"}
            </Button>
            <Button intent="destructive" pending={props.busy} onClick={props.onConfirm}>
              {props.confirm ?? "Confirm"}
            </Button>
          </footer>
        </section>
      </div>
    </Show>
  )
}

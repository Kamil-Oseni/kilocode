import { Checkbox } from "@kilocode/kilo-ui/checkbox"

export function LocalServer(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  t: (key: string) => string
}) {
  return (
    <Checkbox
      checked={props.checked}
      onChange={props.onChange}
      description={props.t("provider.custom.field.localInference.description")}
    >
      {props.t("provider.custom.field.localInference.label")}
    </Checkbox>
  )
}

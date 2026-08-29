// KiloClaw SolidJS webview entry point

import { render } from "solid-js/web"
import "@kilocode/kilo-ui/styles"
import "../src/styles/eden.css" // raya_change - apply Raya typography in auxiliary webviews
import "./kiloclaw.css"
import { KiloClawApp } from "./KiloClawApp"

const root = document.getElementById("root")
if (root) {
  render(() => <KiloClawApp />, root)
}

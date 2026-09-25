// raya_change - production RoutinesView fixture for light/dark and narrow/wide checks
import { createComponent, type Component } from "solid-js"
import { DialogProvider } from "@kilocode/kilo-ui/context/dialog"
import RoutinesView from "../src/components/routines/RoutinesView"
import { LanguageProvider } from "../src/context/language"
import { SessionContext } from "../src/context/session"
import { VSCodeProvider } from "../src/context/vscode"

const session = { agents: () => [] }
const target = new URLSearchParams(location.search).get("target")
const focus =
  target === "organization"
    ? { nonce: "preview-organization", organizationID: "org_11111111111111111111111111111111" }
    : target === "worker"
      ? { nonce: "preview-worker", agentID: "routine" }
      : undefined

export const RoutinesPreview: Component = () =>
  createComponent(VSCodeProvider, {
    get children() {
      return createComponent(LanguageProvider, {
        get children() {
          return createComponent(SessionContext.Provider, {
            value: session as never,
            get children() {
              return createComponent(DialogProvider, {
                get children() {
                  return createComponent(RoutinesView, {
                    workspace: "C:/Projects/preview",
                    focus,
                    onAskRaya: (text: string) => document.documentElement.setAttribute("data-routines-request", text),
                  })
                },
              })
            },
          })
        },
      })
    },
  })

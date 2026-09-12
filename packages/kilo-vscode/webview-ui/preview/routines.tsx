// raya_change - production RoutinesView fixture for light/dark and narrow/wide checks
import { createComponent, type Component } from "solid-js"
import { DialogProvider } from "@kilocode/kilo-ui/context/dialog"
import RoutinesView from "../src/components/routines/RoutinesView"
import { LanguageProvider } from "../src/context/language"
import { SessionContext } from "../src/context/session"
import { VSCodeProvider } from "../src/context/vscode"

const session = { agents: () => [] }

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
                  return createComponent(RoutinesView, { workspace: "C:/Projects/preview" })
                },
              })
            },
          })
        },
      })
    },
  })

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorize, Destination, Message, Receipt } from "@/kilocode/contact/outbox"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { ApiNotFoundError, ConflictError, InvalidRequestError } from "@/server/routes/instance/httpapi/errors"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

const root = "/raya/contact"

export const ContactPaths = {
  destinations: `${root}/destinations`,
  destination: `${root}/destinations/:destinationID`,
  revoke: `${root}/destinations/:destinationID/revoke`,
  messages: `${root}/messages`,
  message: `${root}/messages/:messageID`,
} as const

const DestinationID = Schema.String.check(Schema.isPattern(/^ctd_[a-f0-9]{48}$/))
const MessageID = Schema.String.check(Schema.isPattern(/^ctm_[a-f0-9]{48}$/))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const errors = [InvalidRequestError, ApiNotFoundError, ConflictError] as const

export const ContactListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
})

export const ContactRevokePayload = Schema.Struct({ revision: Revision })

export const ContactMessageView = Schema.Struct({
  version: Message.fields.version,
  id: Message.fields.id,
  source: Message.fields.source,
  destinationID: Message.fields.destinationID,
  destinationRevision: Message.fields.destinationRevision,
  agentID: Message.fields.agentID,
  organizationID: Message.fields.organizationID,
  sessionID: Message.fields.sessionID,
  body: Message.fields.body,
  state: Message.fields.state,
  attempts: Message.fields.attempts,
  availableAt: Message.fields.availableAt,
  leaseUntil: Message.fields.leaseUntil,
  createdAt: Message.fields.createdAt,
  updatedAt: Message.fields.updatedAt,
  receipt: Schema.optional(Receipt),
})

export const ContactApi = HttpApi.make("raya-contact").add(
  HttpApiGroup.make("raya-contact")
    .add(
      HttpApiEndpoint.get("contactDestinationList", ContactPaths.destinations, {
        query: ContactListQuery,
        success: described(Schema.Array(Destination), "Authorized contact destinations"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.contact.destination.list",
          summary: "List contact destinations",
          description: "List up to 100 owner-authorized contact destinations for this Raya workspace.",
        }),
      ),
      HttpApiEndpoint.post("contactDestinationAuthorize", ContactPaths.destinations, {
        query: WorkspaceRoutingQuery,
        payload: Authorize,
        success: described(Destination, "Authorized contact destination"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.contact.destination.authorize",
          summary: "Authorize a contact destination",
          description: "Save an idempotent, scope-bound destination before Raya can enqueue delivery to it.",
        }),
      ),
      HttpApiEndpoint.get("contactDestinationGet", ContactPaths.destination, {
        params: { destinationID: DestinationID },
        query: WorkspaceRoutingQuery,
        success: described(Destination, "Authorized contact destination"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "raya.contact.destination.get", summary: "Get a contact destination" }),
      ),
      HttpApiEndpoint.post("contactDestinationRevoke", ContactPaths.revoke, {
        params: { destinationID: DestinationID },
        query: WorkspaceRoutingQuery,
        payload: ContactRevokePayload,
        success: described(Destination, "Revoked contact destination"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.contact.destination.revoke",
          summary: "Revoke a contact destination",
          description: "Revoke the exact saved revision and fence its pending delivery work.",
        }),
      ),
      HttpApiEndpoint.get("contactMessageList", ContactPaths.messages, {
        query: ContactListQuery,
        success: described(Schema.Array(ContactMessageView), "Contact outbox messages"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.contact.message.list",
          summary: "List contact messages",
          description: "List up to 100 durable outbox messages without exposing dispatcher lease credentials.",
        }),
      ),
      HttpApiEndpoint.get("contactMessageGet", ContactPaths.message, {
        params: { messageID: MessageID },
        query: WorkspaceRoutingQuery,
        success: described(ContactMessageView, "Contact outbox message"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "raya.contact.message.get", summary: "Get a contact message" }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)

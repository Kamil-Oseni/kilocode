import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorize, Destination, Enqueue, Message, Policy, Receipt } from "@/kilocode/contact/outbox"
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
  policy: `${root}/destinations/:destinationID/policy`,
  revoke: `${root}/destinations/:destinationID/revoke`,
  messages: `${root}/messages`,
  message: `${root}/messages/:messageID`,
} as const

const DestinationID = Schema.String.check(Schema.isPattern(/^ctd_[a-f0-9]{48}$/))
const MessageID = Schema.String.check(Schema.isPattern(/^ctm_[a-f0-9]{48}$/))
const AgentID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const errors = [InvalidRequestError, ApiNotFoundError, ConflictError] as const

export const ContactListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  agentID: Schema.optional(AgentID),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
})

export const ContactDestinationListQuery = Schema.Struct({
  ...ContactListQuery.fields,
  organizationID: Schema.optional(AgentID),
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
        query: ContactDestinationListQuery,
        success: described(Schema.Array(Destination), "Authorized contact destinations"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.contact.destination.list",
          summary: "List contact destinations",
          description:
            "List up to 100 owner-authorized contact destinations for this Raya workspace, optionally limited to one Routine worker or organization Raya inbox scope.",
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
          description: "Save or restore an idempotent, scope-bound destination before Raya can enqueue delivery to it.",
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
      HttpApiEndpoint.post("contactDestinationPolicyUpdate", ContactPaths.policy, {
        params: { destinationID: DestinationID },
        query: WorkspaceRoutingQuery,
        payload: Policy,
        success: described(Destination, "Updated contact destination"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.contact.destination.policy.update",
          summary: "Update contact quiet hours",
          description:
            "Update or clear quiet hours on the exact enabled destination revision without changing its authorization scope.",
        }),
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
      HttpApiEndpoint.post("contactMessageSend", ContactPaths.messages, {
        query: WorkspaceRoutingQuery,
        payload: Enqueue,
        success: described(ContactMessageView, "Raya Messenger delivery result"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "raya.contact.message.send",
          summary: "Send a Raya Messenger report",
          description:
            "Idempotently deliver a report to the exact Routine worker conversation through an authorized Raya destination.",
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

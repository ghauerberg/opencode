export * as ModelPickV1 from "./model-pick"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { statics } from "../schema"
import { SessionID } from "../session-id"
import { SessionV1 } from "./session"

export const ID = Schema.String.check(Schema.isStartsWith("mpk")).pipe(
  Schema.brand("ModelPickID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "mpk_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Tool = Schema.Struct({ messageID: SessionV1.MessageID, callID: Schema.String }).annotate({
  identifier: "ModelPickTool",
})
export type Tool = typeof Tool.Type

export const Answer = Schema.Struct({
  providerID: Schema.String.annotate({ description: "Provider of the selected model" }),
  modelID: Schema.String.annotate({ description: "Model to run the advisor on" }),
}).annotate({ identifier: "ModelPickAnswer" })
export type Answer = typeof Answer.Type

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  role: Schema.String.annotate({ description: "Advisory role being consulted (e.g. 'architect')" }),
  subproblem: Schema.optional(Schema.String).annotate({
    description: "Short subproblem name for context",
  }),
  tool: Schema.optional(Tool),
}).annotate({ identifier: "ModelPickRequest" })
export type Request = typeof Request.Type

export const Reply = Schema.Struct({
  answer: Answer.annotate({ description: "The model selected by the user" }),
}).annotate({ identifier: "ModelPickReply" })

export const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: ID,
  answer: Answer,
}).annotate({ identifier: "ModelPickReplied" })

export const Rejected = Schema.Struct({ sessionID: SessionID, requestID: ID }).annotate({
  identifier: "ModelPickRejected",
})

const Asked = define({ type: "modelpick.asked", schema: Request.fields })
const RepliedEvent = define({ type: "modelpick.replied", schema: Replied.fields })
const RejectedEvent = define({ type: "modelpick.rejected", schema: Rejected.fields })
export const Event = {
  Asked,
  Replied: RepliedEvent,
  Rejected: RejectedEvent,
  Definitions: inventory(Asked, RepliedEvent, RejectedEvent),
}

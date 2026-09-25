import { Schema } from "effect"

export const Trigger = Schema.Literals(["model", "user", "automatic"]).annotate({ identifier: "AdvisorTrigger" })
export type Trigger = Schema.Schema.Type<typeof Trigger>

export const Response = Schema.String.annotate({ identifier: "AdvisorResponse" })
export type Response = Schema.Schema.Type<typeof Response>

export const Review = Schema.Struct({
  sessionID: Schema.String,
  trigger: Trigger,
  cycle: Schema.Number,
  reason: Schema.optional(Schema.String),
  response: Response,
  createdAt: Schema.Number,
}).annotate({ identifier: "AdvisorReview" })
export type Review = Schema.Schema.Type<typeof Review>

export interface State {
  steps: number
  cycle: number
  lastReview?: Review
  history: Review[]
  advisorRunning: boolean
}

export const defaultState: State = {
  steps: 0,
  cycle: 0,
  history: [],
  advisorRunning: false,
}

export * as Advisor from "./schema"

import { Schema } from "effect"

export const Trigger = Schema.Literals(["model", "user", "automatic"]).annotate({ identifier: "AdvisorTrigger" })
export type Trigger = Schema.Schema.Type<typeof Trigger>

export const Response = Schema.String.annotate({ identifier: "AdvisorResponse" })
export type Response = Schema.Schema.Type<typeof Response>

/**
 * Result of an automatic review checkpoint: `none` means no review was due,
 * `reviewed` means advice was injected and the loop should continue, and
 * `halt` means the review failed under `failMode: "pause"` and the worker must
 * stop.
 */
export type AutoOutcome = "none" | "reviewed" | "halt"

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

/**
 * Durable subset of {@link State} stored in session metadata so the review
 * cycle and prior advice survive a process restart. `advisorRunning` is
 * intentionally excluded: it is a transient in-flight flag and must never be
 * persisted, or a crash mid-review would leave the session permanently blocked.
 */
export const Persisted = Schema.Struct({
  steps: Schema.Number,
  cycle: Schema.Number,
  history: Schema.Array(Review),
  lastReview: Schema.optional(Review),
}).annotate({ identifier: "AdvisorPersistedState" })
export type Persisted = Schema.Schema.Type<typeof Persisted>

export const toPersisted = (state: State): Persisted => ({
  steps: state.steps,
  cycle: state.cycle,
  history: state.history,
  ...(state.lastReview ? { lastReview: state.lastReview } : {}),
})

export const fromPersisted = (value: Persisted): State => ({
  steps: value.steps,
  cycle: value.cycle,
  history: [...value.history],
  ...(value.lastReview ? { lastReview: value.lastReview } : {}),
  advisorRunning: false,
})

export * as Advisor from "./schema"

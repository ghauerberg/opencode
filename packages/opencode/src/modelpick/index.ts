import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { ModelPickV1 } from "@opencode-ai/schema/model-pick-v1"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { ModelPickID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"

export const ID = ModelPickV1.ID
export const Answer = ModelPickV1.Answer
export type Answer = typeof Answer.Type
export const Request = ModelPickV1.Request
export type Request = typeof Request.Type
export const Tool = ModelPickV1.Tool
export type Tool = typeof Tool.Type
export const Reply = ModelPickV1.Reply
export const Replied = ModelPickV1.Replied
export const Rejected = ModelPickV1.Rejected
export const Event = ModelPickV1.Event

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<Answer, RejectedError>
}

interface State {
  pending: Map<ModelPickID, PendingEntry>
}

// Service

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("ModelPickRejectedError", {}) {
  override get message() {
    return "The user dismissed the model picker"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ModelPick.NotFoundError", {
  requestID: ModelPickID,
}) {}

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    role: string
    subproblem?: string
    tool?: Tool
  }) => Effect.Effect<Answer, RejectedError>
  readonly reply: (input: { requestID: ModelPickID; answer: Answer }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: ModelPickID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelPick") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("ModelPick.state")(function* () {
        const state: State = {
          pending: new Map<ModelPickID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("ModelPick.ask")(function* (input: {
      sessionID: SessionID
      role: string
      subproblem?: string
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = ModelPickID.ascending()
      yield* Effect.logInfo("asking", { id, role: input.role })

      const deferred = yield* Deferred.make<Answer, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        role: input.role,
        ...(input.subproblem !== undefined ? { subproblem: input.subproblem } : {}),
        ...(input.tool !== undefined ? { tool: input.tool } : {}),
      }
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)

      return yield* Effect.ensuring(Deferred.await(deferred), Effect.sync(() => pending.delete(id)))
    })

    const reply = Effect.fn("ModelPick.reply")(function* (input: { requestID: ModelPickID; answer: Answer }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      pending.delete(input.requestID)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answer: input.answer })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answer: input.answer,
      })
      yield* Deferred.succeed(existing.deferred, input.answer)
    })

    const reject = Effect.fn("ModelPick.reject")(function* (requestID: ModelPickID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      pending.delete(requestID)
      yield* Effect.logInfo("rejected", { requestID })
      yield* events.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    const list = Effect.fn("ModelPick.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as ModelPick from "."

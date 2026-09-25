import { ModelPick } from "@/modelpick"
import { ModelPickID } from "@/modelpick/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ModelPickNotFoundError } from "../errors"

export const modelpickHandlers = HttpApiBuilder.group(InstanceHttpApi, "modelpick", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* ModelPick.Service

    const list = Effect.fn("ModelPickHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("ModelPickHttpApi.reply")(function* (ctx: {
      params: { requestID: ModelPickID }
      payload: { providerID: string; modelID: string }
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answer: { providerID: ctx.payload.providerID, modelID: ctx.payload.modelID },
        })
        .pipe(
          Effect.catchTag("ModelPick.NotFoundError", (error) =>
            Effect.fail(
              new ModelPickNotFoundError({
                requestID: String(error.requestID),
                message: `Model pick request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    const reject = Effect.fn("ModelPickHttpApi.reject")(function* (ctx: { params: { requestID: ModelPickID } }) {
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("ModelPick.NotFoundError", (error) =>
          Effect.fail(
            new ModelPickNotFoundError({
              requestID: String(error.requestID),
              message: `Model pick request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
import { ModelPick } from "@/modelpick"
import { ModelPickID } from "@/modelpick/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ModelPickNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/modelpick"
const ReplyPayload = Schema.Struct({
  providerID: Schema.String.annotate({ description: "Provider of the selected model" }),
  modelID: Schema.String.annotate({ description: "Model to run the advisor on" }),
}).annotate({ identifier: "ModelPickReplyPayload" })

export const ModelPickApi = HttpApi.make("modelpick")
  .add(
    HttpApiGroup.make("modelpick")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(ModelPick.Request), "List of pending model pick requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "modelpick.list",
            summary: "List pending model pick requests",
            description: "Get all pending model pick requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: ModelPickID },
          query: WorkspaceRoutingQuery,
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Model pick answered successfully"),
          error: [HttpApiError.BadRequest, ModelPickNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "modelpick.reply",
            summary: "Reply to model pick request",
            description: "Provide the selected model for a model pick request.",
          }),
        ),
        HttpApiEndpoint.post("reject", `${root}/:requestID/reject`, {
          params: { requestID: ModelPickID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Model pick rejected successfully"),
          error: [HttpApiError.BadRequest, ModelPickNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "modelpick.reject",
            summary: "Reject model pick request",
            description: "Reject a model pick request from the AI assistant.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "modelpick",
          description: "Model pick routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
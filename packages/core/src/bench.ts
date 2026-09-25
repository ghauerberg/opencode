import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"

export interface Info {
  readonly id: string
  readonly name: string
  readonly scores: Record<string, number>
}

export interface Definition {
  readonly id: string
  readonly name: string
  readonly defaultSource: string
  readonly source: () => string
  readonly ttl: Duration.Duration
  readonly parse: (doc: unknown) => Record<string, number>
}

export interface Interface {
  readonly get: () => Effect.Effect<Info[]>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Bench") {}

const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`

const DeepSweRow = Schema.Struct({
  model: Schema.String,
  pass_at_1: Schema.Finite,
})

const DeepSweLeaderboard = Schema.Struct({
  rows: Schema.Array(DeepSweRow),
})

const decodeDeepSwe = Schema.decodeUnknownOption(DeepSweLeaderboard)

// Manual scores let models that are absent from a public leaderboard (for
// example a local model) still carry a score. Keys are model IDs and values
// override the fetched leaderboard for that benchmark.
const ManualScores = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Finite))

const manualPath = () =>
  Flag.OPENCODE_BENCH_SCORES_PATH || path.join(Global.Path.config, "benchmarks.json")

const parseDeepSwe = (doc: unknown): Record<string, number> => {
  const rows = Option.getOrUndefined(decodeDeepSwe(doc))
  if (!rows) return {}
  const best = new Map<string, number>()
  for (const row of rows.rows) {
    // Best configuration per model (highest pass rate across effort levels).
    const score = Math.round(row.pass_at_1 * 1000) / 10
    const prev = best.get(row.model)
    if (prev === undefined || score > prev) best.set(row.model, score)
  }
  return Object.fromEntries(best)
}

const all: Definition[] = [
  {
    id: "deepswe",
    name: "DeepSWE",
    defaultSource: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
    source: () => Flag.OPENCODE_BENCH_DEEPSWE_URL || "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
    ttl: Duration.days(1),
    parse: parseDeepSwe,
  },
]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const filepath = (def: Definition) =>
      path.join(
        Global.Path.cache,
        `bench-${def.id}${def.source() === def.defaultSource ? "" : `-${Hash.fast(def.source())}`}.json`,
      )

    const fresh = Effect.fnUntraced(function* (def: Definition) {
      const fp = filepath(def)
      const stat = yield* fs.stat(fp).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(def.ttl)
    })

    const fetchAndWrite = Effect.fn("Bench.fetchAndWrite")(function* (def: Definition) {
      const fp = filepath(def)
      const text = yield* HttpClientRequest.get(def.source()).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
      const tempfile = `${fp}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, text).pipe(
        Effect.andThen(fs.rename(tempfile, fp)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
    })

    const load = Effect.fn("Bench.load")(function* (def: Definition) {
      const fp = filepath(def)
      const doc = yield* fs.readJson(fp).pipe(
        Effect.catch((error) => {
          if (error._tag === "FileSystemError" && error.method === "readJson") {
            return fs.remove(fp, { force: true }).pipe(Effect.ignore, Effect.as(undefined))
          }
          return Effect.succeed(undefined)
        }),
      )
      if (doc === undefined) return undefined
      return def.parse(doc)
    })

    const loadManual = Effect.fnUntraced(function* () {
      const doc = yield* fs.readJson(manualPath()).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const parsed =
        doc === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(ManualScores)(doc))
      return parsed ?? ({} as Record<string, Record<string, number>>)
    })

    const get = Effect.fn("Bench.get")(function* () {
      const manual = yield* loadManual()
      return yield* Effect.all(
        all.map((def) =>
          load(def).pipe(
            Effect.map((scores) => ({
              id: def.id,
              name: def.name,
              scores: { ...scores, ...manual[def.id] },
            })),
          ),
        ),
      )
    })

    const refreshOne = Effect.fn("Bench.refreshOne")(function* (def: Definition, force: boolean) {
      if (!force && (yield* fresh(def))) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(`bench:${filepath(def)}`)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh(def))) return
          yield* fetchAndWrite(def)
        }),
      ).pipe(
        Effect.tapCause((cause) => Effect.logError(`Failed to fetch benchmark ${def.id}`, { cause: cause })),
        Effect.ignore,
      )
    })

    const refresh = Effect.fn("Bench.refresh")(function* (force = false) {
      yield* Effect.forEach(all, (def) => refreshOne(def, force))
    })

    if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      // Each definition skips the fetch while its cache is fresh, so this keeps
      // every leaderboard at most one TTL behind.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, httpClient] })

export * as Bench from "./bench"

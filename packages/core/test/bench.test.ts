import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Bench } from "@opencode-ai/core/bench"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { it } from "./lib/effect"
import { mkdir, readFile, rm, utimes, writeFile } from "fs/promises"
import path from "path"

const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH
const ORIGINAL_SCORES_PATH = Flag.OPENCODE_BENCH_SCORES_PATH
const cacheFile = path.join(Global.Path.cache, "bench-deepswe.json")
const scoresFile = path.join(Global.Path.cache, "bench-scores.test.json")
beforeAll(() => {
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
  Flag.OPENCODE_BENCH_SCORES_PATH = scoresFile
})
afterAll(() => {
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
  Flag.OPENCODE_BENCH_SCORES_PATH = ORIGINAL_SCORES_PATH
})

const leaderboard = {
  generated_at: "2026-09-22T06:27:15.860279+00:00",
  rows: [
    { model: "gpt-6-astra", harness: "mini-swe-agent", reasoning_effort: "xhigh", pass_at_1: 0.7411504424778761 },
    { model: "gpt-6-astra", harness: "mini-swe-agent", reasoning_effort: "medium", pass_at_1: 0.7278761061946902 },
    { model: "gemini-3-8-flash", harness: "mini-swe-agent", reasoning_effort: "high", pass_at_1: 0.738255033557047 },
  ],
}

const expected = {
  "gpt-6-astra": 74.1,
  "gemini-3-8-flash": 73.8,
}

interface MockState {
  body: string
  status: number
  calls: Array<{ url: string; userAgent: string | null }>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({
        ...s,
        calls: [...s.calls, { url: request.url, userAgent: request.headers["user-agent"] ?? null }],
      }))
      const s = yield* Ref.get(state)
      return HttpClientResponse.fromWeb(request, new Response(s.body, { status: s.status }))
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  // Layer.fresh because the Bench layer is a module-level constant and Effect
  // memoizes it process-globally across tests.
  Layer.fresh(
    AppNodeBuilder.build(Bench.node, [
      [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, makeMockClient(state))],
    ]),
  )

const writeCacheText = (text: string, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(cacheFile, text)
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000
      await utimes(cacheFile, t, t)
    }
  })

const writeCache = (data: object, mtimeMs?: number) => writeCacheText(JSON.stringify(data), mtimeMs)

const writeScoresText = (text: string) =>
  Effect.promise(async () => {
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(scoresFile, text)
  })

const writeScores = (data: object) => writeScoresText(JSON.stringify(data))

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, Bench.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

beforeEach(async () => {
  await rm(cacheFile, { force: true })
  await rm(scoresFile, { force: true })
})

afterAll(async () => {
  await rm(cacheFile, { force: true })
  await rm(scoresFile, { force: true })
})

const initialState: MockState = {
  body: JSON.stringify(leaderboard),
  status: 200,
  calls: [],
}

describe("Bench Service", () => {
  it.live("get() parses the cached leaderboard, keeping the best score per model", () =>
    Effect.gen(function* () {
      yield* writeCache(leaderboard)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        Bench.Service.use((s) => s.get()),
      )
      expect(result).toEqual([{ id: "deepswe", name: "DeepSWE", scores: expected }])
      expect((yield* Ref.get(state)).calls).toEqual([])
    }),
  )

  it.live("get() lists benchmarks with empty scores when nothing is cached", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        Bench.Service.use((s) => s.get()),
      )
      expect(result).toEqual([{ id: "deepswe", name: "DeepSWE", scores: {} }])
      expect((yield* Ref.get(state)).calls).toEqual([])
    }),
  )

  it.live("get() drops a corrupted cache file instead of failing", () =>
    Effect.gen(function* () {
      yield* writeCacheText("{")
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        Bench.Service.use((s) => s.get()),
      )
      expect(result).toEqual([{ id: "deepswe", name: "DeepSWE", scores: {} }])
      expect(yield* Effect.promise(() => readFile(cacheFile, "utf8").catch(() => "missing"))).toBe("missing")
    }),
  )

  it.live("refresh(false) skips the fetch while the cache is within the one-day TTL", () =>
    Effect.gen(function* () {
      yield* writeCache(leaderboard, Date.now() - 1000)
      const state = yield* Ref.make(initialState)
      yield* provided(
        state,
        Bench.Service.use((s) => s.refresh(false)),
      )
      expect((yield* Ref.get(state)).calls).toEqual([])
    }),
  )

  it.live("refresh(false) fetches and rewrites the cache once it is stale", () =>
    Effect.gen(function* () {
      yield* writeCache({ rows: [] }, Date.now() - 2 * 24 * 60 * 60 * 1000)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* Bench.Service
          yield* svc.refresh(false)
          return yield* svc.get()
        }),
      )
      expect(result).toEqual([{ id: "deepswe", name: "DeepSWE", scores: expected }])
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(final.calls[0].url).toContain("leaderboard-live.json")
      expect(final.calls[0].userAgent).toContain("/cli")
      expect(yield* Effect.promise(() => readFile(cacheFile, "utf8"))).toBe(JSON.stringify(leaderboard))
    }),
  )

  it.live("refresh(true) keeps the stale cache when the fetch fails", () =>
    Effect.gen(function* () {
      yield* writeCache(leaderboard)
      const state = yield* Ref.make({ ...initialState, status: 500, body: "boom" })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* Bench.Service
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(result).toEqual([{ id: "deepswe", name: "DeepSWE", scores: expected }])
      expect((yield* Ref.get(state)).calls.length).toBeGreaterThanOrEqual(1)
    }),
  )
})

describe("Bench manual scores", () => {
  it.live("fills in models the leaderboard does not list", () =>
    Effect.gen(function* () {
      yield* writeCache(leaderboard)
      yield* writeScores({ deepswe: { "lmstudio/qwen": 42.2 } })
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        Bench.Service.use((s) => s.get()),
      )
      expect(result).toEqual([
        { id: "deepswe", name: "DeepSWE", scores: { ...expected, "lmstudio/qwen": 42.2 } },
      ])
    }),
  )

  it.live("overrides a fetched score for the same model", () =>
    Effect.gen(function* () {
      yield* writeCache(leaderboard)
      yield* writeScores({ deepswe: { "gpt-6-astra": 12.3 } })
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        Bench.Service.use((s) => s.get()),
      )
      expect(result).toEqual([
        { id: "deepswe", name: "DeepSWE", scores: { ...expected, "gpt-6-astra": 12.3 } },
      ])
    }),
  )

  it.live("ignores unknown benchmarks and malformed files", () =>
    Effect.gen(function* () {
      yield* writeCache(leaderboard)
      yield* writeScores({ other: { foo: 1 } })
      const state = yield* Ref.make(initialState)
      const unknown = yield* provided(
        state,
        Bench.Service.use((s) => s.get()),
      )
      expect(unknown).toEqual([{ id: "deepswe", name: "DeepSWE", scores: expected }])

      yield* writeScoresText("{ not json")
      const malformed = yield* provided(
        state,
        Bench.Service.use((s) => s.get()),
      )
      expect(malformed).toEqual([{ id: "deepswe", name: "DeepSWE", scores: expected }])
    }),
  )
})

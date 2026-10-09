import { Effect, Option, Schema } from "effect"
import * as nodepath from "node:path"
import { mkdir, rename, rm, writeFile } from "fs/promises"

const file = "consult-models.json"

const Model = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
})

const File = Schema.Record(Schema.String, Model)
const decodeFile = Schema.decodeUnknownOption(File)

export interface Entry {
  providerID: string
  modelID: string
}

export type Map = Record<string, Entry>

const pathFor = (configDir: string) => nodepath.join(configDir, file)

function readRaw(fp: string) {
  return Effect.tryPromise(() => Bun.file(fp).text()).pipe(
    Effect.map((text) => (text && text.trim() ? text : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  )
}

function failAfterCleanup(tmp: string, error: unknown) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() => rm(tmp, { force: true, recursive: true })).pipe(Effect.ignore, Effect.andThen(Effect.void))
    return yield* Effect.fail(error)
  })
}

function writeAtomic(fp: string, map: Map) {
  const text = JSON.stringify(map, null, 2) + "\n"
  const dir = nodepath.dirname(fp)
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(dir, { recursive: true }))
    yield* Effect.tryPromise(() => writeFile(tmp, text)).pipe(
      Effect.catch((error) => failAfterCleanup(tmp, error)),
    )
    yield* Effect.tryPromise(() => rename(tmp, fp)).pipe(
      Effect.catch((error) => failAfterCleanup(tmp, error)),
    )
  })
}

function readExisting(configDir: string) {
  return readRaw(pathFor(configDir)).pipe(Effect.map((raw) => (raw === undefined ? ({}) as Map : parseMap(raw))))
}

function parseMap(raw: string): Map {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return {}
  }
  return Option.getOrUndefined(decodeFile(doc)) ?? {}
}

export const find = Effect.fn("ModelPickStore.find")(function* (configDir: string, role: string) {
  const map = yield* readExisting(configDir)
  const entry = map[role]
  if (typeof entry?.providerID !== "string" || typeof entry.modelID !== "string") return undefined
  return entry
})

export const save = Effect.fn("ModelPickStore.save")(function* (configDir: string, role: string, model: Entry) {
  const map = yield* readExisting(configDir)
  map[role] = model
  yield* writeAtomic(pathFor(configDir), map)
})

export const clear = Effect.fn("ModelPickStore.clear")(function* (configDir: string, role: string) {
  const map = yield* readExisting(configDir)
  if (!(role in map)) return
  delete map[role]
  yield* writeAtomic(pathFor(configDir), map)
})

export const filePath = (configDir: string) => pathFor(configDir)

export * as ModelPickStore from "./store"

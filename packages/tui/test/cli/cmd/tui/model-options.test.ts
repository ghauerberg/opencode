import { describe, expect, test } from "bun:test"
import { formatPrice, sortBenchOptions, sortModelOptions } from "../../../../src/component/dialog-model"

describe("sortModelOptions", () => {
  test("orders provider-scoped model choices by newest release first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GPT 5.2", releaseDate: "2025-12-11" },
        { title: "GPT 5.4", releaseDate: "2026-03-05" },
        { title: "GPT 5.1", releaseDate: "2025-11-13" },
      ],
      true,
    )

    expect(sorted.map((model) => model.title)).toEqual(["GPT 5.4", "GPT 5.2", "GPT 5.1"])
  })

  test("orders regular model choices free-first and then newest-first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GLM 5", releaseDate: "2025-07-28" },
        { title: "GLM 5.1", releaseDate: "2025-12-09" },
        { title: "GLM 5.2", releaseDate: "2026-02-16" },
        { title: "Free old", releaseDate: "2024-01-01", footer: "Free" },
        { title: "Free new", releaseDate: "2025-01-01", footer: "Free" },
      ],
      false,
    )

    expect(sorted.map((model) => model.title)).toEqual(["Free new", "Free old", "GLM 5.2", "GLM 5.1", "GLM 5"])
  })
})

describe("sortBenchOptions", () => {
  test("orders scored models by highest score and keeps unscored ones last", () => {
    const sorted = sortBenchOptions([
      { title: "No score", releaseDate: "2026-01-01" },
      { title: "Mid", releaseDate: "2025-01-01", score: 61.2 },
      { title: "Top", releaseDate: "2025-01-01", score: 73.8 },
      { title: "Low", releaseDate: "2025-01-01", score: 11.7 },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Top", "Mid", "Low", "No score"])
  })

  test("falls back to free-first, newest-first, then title among unscored and ties", () => {
    const sorted = sortBenchOptions([
      { title: "GLM 5", releaseDate: "2025-07-28" },
      { title: "GLM 5.2", releaseDate: "2026-02-16" },
      { title: "Free old", releaseDate: "2024-01-01", footer: "Free" },
      { title: "Free new", releaseDate: "2025-01-01", footer: "Free" },
      { title: "Scored", releaseDate: "2024-01-01", score: 10 },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Scored", "Free new", "Free old", "GLM 5.2", "GLM 5"])
  })

  test("breaks score ties by newest release and then title", () => {
    const sorted = sortBenchOptions([
      { title: "B old", releaseDate: "2025-01-01", score: 50 },
      { title: "B new", releaseDate: "2026-01-01", score: 50 },
      { title: "A new", releaseDate: "2026-01-01", score: 50 },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["A new", "B new", "B old"])
  })
})

describe("formatPrice", () => {
  test("renders input and output cost per million tokens", () => {
    expect(formatPrice({ input: 5, output: 15 })).toBe("$5 / $15 per 1M")
    expect(formatPrice({ input: 0.25, output: 22.5 })).toBe("$0.25 / $22.5 per 1M")
    expect(formatPrice(undefined)).toBeUndefined()
  })
})

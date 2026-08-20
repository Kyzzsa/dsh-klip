// KInterval mini-language: parse text into endpoints, then instantiate(len)
// resolves them into concrete closed intervals. Indexing is 1-based.
//
// Grammar (clauses separated by commas):
//   x       → [x, x]
//   a..b    → [a, b]
//   a..     → a..-1
//   ..b     → 1..b
//   ..      → full set [1, len]
//   not I   → exclude interval I
//
// Endpoints stay raw at parse time (a.. → e=-1, .. → {1,-1}); instantiate
// mirrors negatives (x<0 → len+1+x, so -1 = last), clamps to [1, len], drops
// empty pieces, then subtracts exclusions. Whitespace is ignored.

// Inclusive endpoints; after instantiation 1 <= s <= e <= len.
interface Interval { s: number; e: number }

// Both from_string and instantiate are pure.
export class KInterval {
  readonly includes: Interval[]
  readonly excludes: Interval[]

  constructor(includes: Interval[], excludes: Interval[]) {
    this.includes = includes
    this.excludes = excludes
  }

  static from_string(text: string): KInterval {
    const includes: Interval[] = []
    const excludes: Interval[] = []

    for (const raw of text.split(",")) {
      const clause = parseClause(tokenize(raw))
      if (clause === null) continue
      if (clause.kind === "not") excludes.push(clause.interval)
      else includes.push(clause.interval)
    }
    return new KInterval(includes, excludes)
  }

  instantiate(len: number): Interval[] {
    if (len <= 0) return []

    const includes = project(this.includes, len)
    const excludes = project(this.excludes, len)

    return subtract(includes, excludes)
  }
}

function tokenize(text: string): string[] {
  return text.match(/-?\d+|\.\.|not/g) ?? []
}

type ParsedClause =
  | { kind: "include"; interval: Interval }
  | { kind: "not"; interval: Interval }

function parseClause(tokens: string[]): ParsedClause | null {
  if (tokens.length === 0) return null

  if (tokens[0] === "not") {
    const interval = parseBody(tokens.slice(1))
    return interval === null ? null : { kind: "not", interval }
  }

  const interval = parseBody(tokens)
  return interval === null ? null : { kind: "include", interval }
}

function parseBody(tokens: string[]): Interval | null {
  if (tokens.length === 0) return null

  const a = asNum(tokens[0])
  if (a !== null) {
    if (tokens.length === 1) return { s: a, e: a }
    if (tokens[1] !== "..") return null
    if (tokens.length === 2) {
      return { s: a, e: -1 }
    }
    const b = asNum(tokens[2])
    if (b === null || tokens.length > 3) return null

    return { s: a, e: b }
  } else if (tokens[0] === "..") {
    if (tokens.length === 1) {
      return { s: 1, e: -1 }
    }
    const b = asNum(tokens[1])
    if (b === null || tokens.length > 2) return null

    return { s: 1, e: b }
  } else {
    return null
  }
}

function asNum(s: string): number | null {
  const t = s.trim()
  return /^-?\d+$/.test(t) ? Number(t) : null
}

function project(intervals: Interval[], len: number): Interval[] {
  const mapIndex = (x: number): number => (x < 0 ? len + 1 + x : x)

  const out: Interval[] = []
  for (const { s, e } of intervals) {
    const start = Math.max(mapIndex(s), 1)
    const end = Math.min(mapIndex(e), len)
    if (start > end) continue

    out.push({ s: start, e: end })
  }
  return out
}

function subtract(incl: Interval[], excl: Interval[]): Interval[] {
  const includes = merge(incl)
  const excludes = merge(excl)

  const res: Interval[] = []
  for (const { s: is, e: ie } of includes) {
    let cursor = is
    for (const { s: es, e: ee } of excludes) {
      if (ee < cursor) continue
      if (es > ie) break
      if (es > cursor) res.push({ s: cursor, e: es - 1 })
      cursor = ee + 1
    }
    if (cursor <= ie) res.push({ s: cursor, e: ie })
  }
  return res
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((p, q) => p.s - q.s || p.e - q.e)

  const out: Interval[] = []
  let pending: Interval | null = null
  for (const it of sorted) {
    if (pending === null) {
      pending = { ...it }
    } else if (it.s <= pending.e + 1) {
      pending.e = Math.max(pending.e, it.e)
    } else {
      out.push(pending)
      pending = { ...it }
    }
  }

  if (pending !== null) out.push(pending)
  return out
}

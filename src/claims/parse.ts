import { compilePattern } from '../config'
import { stripHtmlComments } from '../text'
import type { ClaimPatternConfig, ClaimSource } from '../types'

export interface ParsedClaim {
  id: string
  evidence: ClaimPatternConfig['evidence']
  text: string
  source: ClaimSource
  commitSha?: string
  issueNumber?: number
  order: number
}

interface Hit extends ParsedClaim {
  start: number
  end: number
}

const NEGATION = /(?:^|[^A-Za-z])(?:not|no|never|don'?t|doesn'?t|without)\b/i
const ZH_NEGATION = /没有|未|并非|不是|并不/

export function parseClaims(input: {
  title: string
  body: string
  commits?: readonly { sha: string; message: string }[]
  patterns: readonly ClaimPatternConfig[]
  scanCommits: boolean
}): ParsedClaim[] {
  const found: Hit[] = []
  const take = (text: string, source: ClaimSource, document: number, commitSha?: string) => {
    found.push(...matchDocument(text, input.patterns, source, document, commitSha))
  }
  take(input.title, 'title', 0)
  take(input.body, 'description', 1)
  if (input.scanCommits) {
    for (const [index, commit] of (input.commits ?? []).entries()) {
      take(commit.message, 'commit', index + 2, commit.sha)
    }
  }
  return dedupe(found).map((claim) => ({
    id: claim.id,
    evidence: claim.evidence,
    text: claim.text,
    source: claim.source,
    ...(claim.commitSha ? { commitSha: claim.commitSha } : {}),
    ...(claim.issueNumber != null ? { issueNumber: claim.issueNumber } : {}),
    order: claim.order,
  }))
}

function matchDocument(
  text: string,
  patterns: readonly ClaimPatternConfig[],
  source: ClaimSource,
  document: number,
  commitSha: string | undefined,
): Hit[] {
  const visible = stripFenced(stripHtmlComments(text))
  const hits: Hit[] = []
  for (const pattern of patterns) {
    for (const sourcePattern of pattern.patterns) {
      for (const match of matchAll(sourcePattern, visible)) {
        const start = match.index ?? 0
        const raw = match[0]
        if (!raw || isNegated(visible, start)) continue
        const issueNumber = pattern.evidence === 'linked_issue' ? captureIssue(match[1]) : undefined
        hits.push({
          id: pattern.id,
          evidence: pattern.evidence,
          text: raw.replace(/\s+/g, ' ').trim(),
          source,
          ...(commitSha ? { commitSha } : {}),
          ...(issueNumber != null ? { issueNumber } : {}),
          order: document * 1_000_000 + start,
          start,
          end: start + raw.length,
        })
      }
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id))
  const kept: Hit[] = []
  let lastEnd = -1
  for (const hit of hits) {
    if (hit.start < lastEnd) continue
    kept.push(hit)
    lastEnd = hit.end
  }
  return kept
}

function matchAll(pattern: string, text: string): RegExpMatchArray[] {
  const compiled = compilePattern(pattern)
  const flags = compiled.flags.includes('g') ? compiled.flags : `${compiled.flags}g`
  return [...text.matchAll(new RegExp(compiled.source, flags))]
}

function captureIssue(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const number = Number(value)
  return number > 0 ? number : undefined
}

function isNegated(text: string, start: number): boolean {
  const raw = text.slice(Math.max(0, start - 32), start)
  const cut = Math.max(
    raw.lastIndexOf('\n'),
    raw.lastIndexOf('.'),
    raw.lastIndexOf('!'),
    raw.lastIndexOf('?'),
    raw.lastIndexOf('。'),
    raw.lastIndexOf('！'),
    raw.lastIndexOf('？'),
  )
  const window = cut >= 0 ? raw.slice(cut + 1) : raw
  return NEGATION.test(window) || ZH_NEGATION.test(window)
}

function dedupe(claims: readonly Hit[]): Hit[] {
  const seen = new Set<string>()
  const out: Hit[] = []
  const sorted = [...claims].sort((a, b) => a.order - b.order)
  for (const claim of sorted) {
    const identity = claim.issueNumber != null ? `#${claim.issueNumber}` : claim.text.toLowerCase()
    const key = claim.source === 'commit'
      ? `${claim.id}|${identity}|commit|${claim.commitSha ?? ''}`
      : `${claim.id}|${identity}|description`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(claim)
  }
  return out
}

function stripFenced(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ')
}

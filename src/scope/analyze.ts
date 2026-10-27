import { issueLabel } from '../text'
import type {
  ChangedFile,
  FileExplanation,
  FileVerdict,
  LinkedIssue,
  QuietNoIssue,
  ScopeConfig,
  ScopeFileReport,
  ScopeReport,
  ScopeSignal,
} from '../types'
import { isBotAuthor, matchingSkipLabel } from './author'
import { issueText } from './links'
import { activeSensitiveRules, matchDocs, matchIgnore, matchSensitive } from './sensitive'
import {
  allowsDiffKeywords,
  diffTokens,
  directoryKey,
  distinctiveKeywords,
  mentionedInText,
  pathTokens,
  quoteForToken,
  strongDiffOverlap,
  tokensOverlap,
  issueTokens,
} from './tokenize'

interface Candidate {
  rank: number
  specificity: number
  explanation: FileExplanation
}

export function analyzeScope(input: {
  prRepo: string
  files: ChangedFile[]
  issues: LinkedIssue[]
  config: ScopeConfig
  apiError?: string
  filesUnavailable?: boolean
  authorLogin?: string
  authorType?: string
  labels?: readonly string[]
}): ScopeReport {
  const rules = activeSensitiveRules(input.config.disabledSensitiveIds, input.config.extraSensitivePaths)
  const issueTexts = input.issues.map((issue) => issueText(issue))
  const keywords = distinctiveKeywords(issueTexts.join('\n'), 8)
  const refs = input.issues.map((issue) => issueLabel(input.prRepo, issue.repo, issue.number))
  const files = input.files.map((file) => judgeFile(file, input, rules, issueTexts, keywords, refs))
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const signals = collectSignals(files, input, keywords, refs, additions, deletions)
  return {
    enabled: true,
    status: scopeStatus(signals, files),
    issues: input.issues,
    files,
    signals,
    additions,
    deletions,
    fileCount: files.length,
  }
}

export function scopeStatus(signals: readonly ScopeSignal[], files: readonly ScopeFileReport[]): ScopeReport['status'] {
  if (signals.some((signal) => signal.level === 'error')) return 'error'
  if (signals.some((signal) => signal.level === 'warn')) return 'warn'
  if (files.some((file) => file.verdict === 'outside_scope')) return 'warn'
  return 'pass'
}

export function skippedScope(): ScopeReport {
  return {
    enabled: false,
    status: 'skipped',
    issues: [],
    files: [],
    signals: [],
    additions: 0,
    deletions: 0,
    fileCount: 0,
  }
}

function judgeFile(
  file: ChangedFile,
  input: { prRepo: string; issues: LinkedIssue[]; config: ScopeConfig },
  rules: ReturnType<typeof activeSensitiveRules>,
  issueTexts: string[],
  keywords: string[],
  refs: string[],
): ScopeFileReport {
  const sensitive = matchSensitive(file.filename, rules, issueTexts)
  if (file.previousFilename) {
    const previousHits = matchSensitive(file.previousFilename, rules, issueTexts)
    for (const hit of previousHits) {
      if (!sensitive.some((existing) => existing.ruleId === hit.ruleId && existing.pattern === hit.pattern)) {
        sensitive.push(hit)
      }
    }
  }
  const ignored = matchIgnore(file.filename, input.config.ignorePaths)
  const explanations: FileExplanation[] = []
  if (file.previousFilename) {
    explanations.push({ code: 'scope.renamed_from', previous: file.previousFilename })
  }
  for (const hit of sensitive) {
    explanations.push({
      code: 'scope.sensitive',
      reason: hit.reason,
      pattern: hit.pattern,
      ruleId: hit.ruleId,
      mentioned: hit.mentioned,
      ...(hit.mention ? { mention: hit.mention } : {}),
    })
  }

  let verdict: FileVerdict
  if (ignored) {
    verdict = 'ignored'
    explanations.unshift({ code: 'scope.ignored', pattern: ignored })
  } else if (input.issues.length === 0) {
    verdict = 'not_compared'
    explanations.unshift({ code: 'scope.no_linked_issue' })
  } else {
    const matched = bestMatch(file, input.prRepo, input.issues, sensitive.map((hit) => hit.reason))
    if (matched) {
      verdict = 'in_scope'
      explanations.unshift(matched)
    } else {
      verdict = 'outside_scope'
      explanations.unshift({
        code: 'scope.outside',
        issueRefs: refs,
        fileTokens: uniqueTokens(file),
        issueKeywords: keywords,
      })
    }
  }

  return {
    filename: file.filename,
    ...(file.previousFilename ? { previousFilename: file.previousFilename } : {}),
    changeStatus: file.status,
    additions: file.additions,
    deletions: file.deletions,
    verdict,
    sensitive,
    explanations,
  }
}

function bestMatch(
  file: ChangedFile,
  prRepo: string,
  issues: readonly LinkedIssue[],
  reasons: string[],
): FileExplanation | undefined {
  const candidates: Candidate[] = []
  const names = [file.filename, file.previousFilename].filter((name): name is string => Boolean(name))
  for (const issue of issues) {
    const text = issueText(issue)
    for (const name of names) {
      const viaPrevious = name === file.filename ? undefined : name
      const mention = mentionedInText(text, name)
      if (mention) {
        candidates.push({
          rank: 3,
          specificity: mention.matched.length,
          explanation: {
            code: 'scope.in_scope.path_mention',
            issueNumber: issue.number,
            repo: issue.repo,
            quoted: mention.matched,
            ...(viaPrevious ? { viaPrevious } : {}),
          },
        })
      }
      const overlap = tokensOverlap(pathTokens(name), issueTokens(text))
      if (overlap.length > 0) {
        candidates.push({
          rank: 2,
          specificity: overlap.length,
          explanation: {
            code: 'scope.in_scope.path_tokens',
            issueNumber: issue.number,
            repo: issue.repo,
            tokens: overlap,
            snippet: quoteForToken(text, overlap[0] ?? ''),
            ...(viaPrevious ? { viaPrevious } : {}),
          },
        })
      }
    }
    if (allowsDiffKeywords(reasons)) {
      const overlap = tokensOverlap(diffTokens(file.patch), issueTokens(text))
        .filter((token) => !pathTokens(file.filename).includes(token))
      if (strongDiffOverlap(overlap)) {
        candidates.push({
          rank: 1,
          specificity: overlap.length,
          explanation: {
            code: 'scope.in_scope.diff_keywords',
            issueNumber: issue.number,
            repo: issue.repo,
            tokens: overlap.slice(0, 6),
          },
        })
      }
    }
  }
  candidates.sort((a, b) => b.rank - a.rank || b.specificity - a.specificity)
  const winner = candidates[0]
  if (!winner) return undefined
  if (winner.explanation.code === 'scope.in_scope.path_mention') {
    winner.explanation.repo = winner.explanation.repo || prRepo
  }
  return winner.explanation
}

function uniqueTokens(file: ChangedFile): string[] {
  const tokens = new Set(pathTokens(file.filename))
  if (file.previousFilename) {
    for (const token of pathTokens(file.previousFilename)) tokens.add(token)
  }
  return [...tokens]
}

function collectSignals(
  files: readonly ScopeFileReport[],
  input: {
    prRepo: string
    issues: LinkedIssue[]
    config: ScopeConfig
    apiError?: string
    filesUnavailable?: boolean
    authorLogin?: string
    authorType?: string
    labels?: readonly string[]
  },
  keywords: string[],
  refs: string[],
  additions: number,
  deletions: number,
): ScopeSignal[] {
  const signals: ScopeSignal[] = []
  if (input.apiError) signals.push({ id: 'scope.api_error', level: 'warn', message: input.apiError })
  if (input.filesUnavailable) return signals
  if (files.length === 0) {
    signals.push({ id: 'scope.no_files', level: 'info' })
    return signals
  }
  if (input.issues.length === 0) {
    const missing = noLinkedIssueSignal(input, files)
    if (missing) signals.push(missing)
  }
  const unreadable = input.issues.filter((issue) => issue.unreadable)
  if (input.issues.length > 0 && unreadable.length === input.issues.length) {
    signals.push({
      id: 'scope.issue_unreadable',
      level: 'warn',
      issues: unreadable.map((issue) => issueLabel(input.prRepo, issue.repo, issue.number)),
    })
  }

  const judged = files.filter((file) => countsTowardOutsideRatio(file))
  const outside = judged.filter((file) => file.verdict === 'outside_scope')
  if (judged.length > 0 && outside.length >= input.config.outsideScopeErrorMin) {
    const ratio = outside.length / judged.length
    if (ratio >= input.config.outsideScopeErrorRatio) {
      signals.push({
        id: 'scope.outside_ratio',
        level: 'error',
        outside: outside.length,
        judged: judged.length,
        ratio,
        minFiles: input.config.outsideScopeErrorMin,
        threshold: input.config.outsideScopeErrorRatio,
      })
    }
  }

  const lines = additions + deletions
  const overLines = lines >= input.config.largeDiffLines
  const overFiles = files.length >= input.config.largeDiffFiles
  if (overLines || overFiles) {
    signals.push({
      id: 'scope.large_diff',
      level: 'warn',
      additions,
      deletions,
      files: files.length,
      lineThreshold: input.config.largeDiffLines,
      fileThreshold: input.config.largeDiffFiles,
      overLines,
      overFiles,
    })
  }

  for (const file of outside) {
    const size = file.additions + file.deletions
    if (size >= input.config.largeFileLines) {
      signals.push({
        id: 'scope.large_unrelated_file',
        level: 'warn',
        filename: file.filename,
        lines: size,
        threshold: input.config.largeFileLines,
      })
    }
  }

  const clusters = new Map<string, string[]>()
  for (const file of outside) {
    const key = directoryKey(file.filename)
    const list = clusters.get(key) ?? []
    list.push(file.filename)
    clusters.set(key, list)
  }
  for (const [directory, names] of [...clusters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (names.length < 2) continue
    signals.push({
      id: 'scope.outside_cluster',
      level: 'warn',
      directory,
      files: names,
      issueKeywords: keywords,
      issueRefs: refs,
    })
  }

  const surprise = files.flatMap((file) =>
    file.sensitive
      .filter((hit) => !hit.mentioned)
      .map((hit) => ({ filename: file.filename, reason: hit.reason, pattern: hit.pattern })),
  )
  if (surprise.length > 0) {
    signals.push({ id: 'scope.sensitive', level: 'warn', files: surprise })
  }
  return signals
}

function noLinkedIssueSignal(
  input: {
    config: ScopeConfig
    authorLogin?: string
    authorType?: string
    labels?: readonly string[]
  },
  files: readonly ScopeFileReport[],
): ScopeSignal | undefined {
  if (input.config.noLinkedIssue === 'skip') return undefined
  if (input.config.noLinkedIssue === 'info') {
    return { id: 'scope.no_linked_issue', level: 'info', quiet: 'config' }
  }
  const label = matchingSkipLabel(input.labels ?? [], input.config.skipLabels)
  if (label) return { id: 'scope.no_linked_issue', level: 'info', quiet: 'label', quietDetail: label }
  if (isBotAuthor(input.authorLogin, input.authorType)) {
    const detail = (input.authorLogin ?? '').trim() || (input.authorType ?? '').trim()
    return {
      id: 'scope.no_linked_issue',
      level: 'info',
      quiet: 'bot',
      ...(detail ? { quietDetail: detail } : {}),
    }
  }
  const filesReason = quietFilesReason(files, input.config)
  if (filesReason) return { id: 'scope.no_linked_issue', level: 'info', quiet: filesReason }
  return { id: 'scope.no_linked_issue', level: 'warn' }
}

function countsTowardOutsideRatio(file: ScopeFileReport): boolean {
  if (file.verdict !== 'in_scope' && file.verdict !== 'outside_scope') return false
  // An unmentioned lockfile or workflow already raises scope.sensitive.
  // Leave it out of the error ratio so infra files cannot trip that threshold alone.
  return !file.sensitive.some((hit) => !hit.mentioned)
}

function quietFilesReason(
  files: readonly ScopeFileReport[],
  config: ScopeConfig,
): Extract<QuietNoIssue, 'docs' | 'ignored' | 'docs_or_ignored'> | undefined {
  if (files.length === 0) return undefined
  let sawDocs = false
  let sawIgnoredOnly = false
  for (const file of files) {
    const names = [file.filename, file.previousFilename].filter((name): name is string => Boolean(name))
    let fileDocs = false
    let fileIgnored = false
    for (const name of names) {
      const docs = matchDocs(name, config.docsPaths) != null
      const ignored = matchIgnore(name, config.ignorePaths) != null
      if (!docs && !ignored) return undefined
      if (docs) fileDocs = true
      if (ignored) fileIgnored = true
    }
    if (fileDocs) sawDocs = true
    else if (fileIgnored) sawIgnoredOnly = true
  }
  if (sawDocs && sawIgnoredOnly) return 'docs_or_ignored'
  if (sawDocs) return 'docs'
  return 'ignored'
}

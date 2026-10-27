import { compilePattern, testPattern } from '../config'
import { matchIgnore } from '../scope/sensitive'
import type { ParsedClaim } from './parse'
import type {
  ChangedFile,
  CheckClaimKind,
  CheckRunInfo,
  ClaimReason,
  ClaimReport,
  ClaimResult,
  ClaimVerdict,
  ClaimsConfig,
  EvidenceJobReport,
  LinkedIssue,
  WorkflowJobInfo,
} from '../types'

const CLAIM_LIMIT = 40
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure'])
const PASSED = new Set(['success', 'neutral'])

export interface ResolvedIssue {
  number: number
  state: 'found' | 'missing' | 'error'
  title: string
  linked: boolean
}

export function skippedClaims(): ClaimReport {
  return { enabled: false, status: 'skipped', scannedCommits: false, results: [], omitted: 0 }
}

export function verifyClaims(input: {
  claims: readonly ParsedClaim[]
  config: ClaimsConfig
  testJobs: readonly EvidenceJobReport[]
  jobs: readonly WorkflowJobInfo[]
  checks: readonly CheckRunInfo[]
  files: readonly ChangedFile[] | null
  issues: readonly LinkedIssue[]
  resolvedIssues: ReadonlyMap<number, ResolvedIssue>
  ciError: boolean
  scanCommits: boolean
}): ClaimReport {
  const selected = input.claims.slice(0, CLAIM_LIMIT)
  const results = selected.map((claim) => judge(claim, input))
  return {
    enabled: true,
    status: claimStatus(results, input.config.contradicted),
    scannedCommits: input.scanCommits,
    results,
    omitted: Math.max(0, input.claims.length - selected.length),
  }
}

export function claimStatus(results: readonly ClaimResult[], contradicted: ClaimsConfig['contradicted']): ClaimReport['status'] {
  if (!results.some((result) => result.verdict === 'contradicted')) return 'pass'
  return contradicted === 'error' ? 'error' : 'warn'
}

export function confirmedIssue(issue: LinkedIssue): boolean {
  if (issue.unreadable) return false
  if (issue.source === 'api' || issue.source === 'both') return true
  return issue.title.length > 0 || issue.body.length > 0
}

function judge(
  claim: ParsedClaim,
  input: {
    config: ClaimsConfig
    testJobs: readonly EvidenceJobReport[]
    jobs: readonly WorkflowJobInfo[]
    checks: readonly CheckRunInfo[]
    files: readonly ChangedFile[] | null
    issues: readonly LinkedIssue[]
    resolvedIssues: ReadonlyMap<number, ResolvedIssue>
    ciError: boolean
  },
): ClaimResult {
  const reason = reasonFor(claim, input)
  return {
    id: claim.id,
    evidence: claim.evidence,
    text: claim.text,
    source: claim.source,
    ...(claim.commitSha ? { commitSha: claim.commitSha } : {}),
    ...(claim.issueNumber != null ? { issueNumber: claim.issueNumber } : {}),
    verdict: verdictFor(reason),
    reason,
  }
}

function reasonFor(
  claim: ParsedClaim,
  input: {
    config: ClaimsConfig
    testJobs: readonly EvidenceJobReport[]
    jobs: readonly WorkflowJobInfo[]
    checks: readonly CheckRunInfo[]
    files: readonly ChangedFile[] | null
    issues: readonly LinkedIssue[]
    resolvedIssues: ReadonlyMap<number, ResolvedIssue>
    ciError: boolean
  },
): ClaimReason {
  switch (claim.evidence) {
    case 'tests':
      return judgeTests(input.testJobs, input.ciError)
    case 'lint':
      return judgeNamed('lint', input.config.lintNamePatterns, input)
    case 'build':
      return judgeNamed('build', input.config.buildNamePatterns, input)
    case 'breaking':
      return judgeNamed('breaking', input.config.breakingNamePatterns, input)
    case 'test_files':
      return judgeFiles(input.files, input.config.testPaths)
    case 'linked_issue':
      return judgeIssue(claim, input.issues, input.resolvedIssues)
    default:
      return { code: 'tests.unverified_none' }
  }
}

function verdictFor(reason: ClaimReason): ClaimVerdict {
  switch (reason.code) {
    case 'tests.verified':
    case 'check.verified':
    case 'files.verified':
    case 'issue.verified':
    case 'issue.verified_any':
      return 'verified'
    case 'tests.contradicted':
    case 'check.contradicted':
    case 'files.contradicted':
    case 'issue.contradicted_missing':
      return 'contradicted'
    default:
      return 'unverified'
  }
}

function judgeTests(jobs: readonly EvidenceJobReport[], ciError: boolean): ClaimReason {
  if (ciError && jobs.length === 0) return { code: 'tests.unverified_api' }
  if (jobs.length === 0) return { code: 'tests.unverified_none' }
  const counted = collapseEventDuplicates(jobs)
  const counts = sumCounts(counted)
  const failed = counted.filter((job) => FAILED.has(job.conclusion ?? '') || (job.counts?.failed ?? 0) > 0)
  if (failed.length > 0) {
    return {
      code: 'tests.contradicted',
      jobs: names(failed.map(displayEvidence)),
      passed: counts?.passed ?? null,
      failed: counts?.failed ?? null,
    }
  }
  const running = counted.filter((job) => job.status !== 'completed')
  if (running.length > 0) return { code: 'tests.unverified_running', jobs: names(running.map(displayEvidence)) }
  const completed = counted.filter((job) => job.status === 'completed')
  const good = completed.filter((job) => PASSED.has(job.conclusion ?? ''))
  if (good.length === 0) return { code: 'tests.unverified_skipped' }
  const zeroOnly = good.every((job) => job.note === 'zero_tests' || (job.counts != null && job.counts.total === 0))
  if (zeroOnly && good.some((job) => job.counts != null || job.note === 'zero_tests')) {
    return { code: 'tests.unverified_zero', jobs: names(good.map(displayEvidence)) }
  }
  return {
    code: 'tests.verified',
    jobs: names(good.map(displayEvidence)),
    passed: counts?.passed ?? null,
    failed: counts?.failed ?? null,
    skipped: counts?.skipped ?? null,
  }
}

function judgeNamed(
  kind: CheckClaimKind,
  patterns: readonly string[],
  input: { jobs: readonly WorkflowJobInfo[]; checks: readonly CheckRunInfo[]; ciError: boolean },
): ClaimReason {
  if (input.ciError && input.jobs.length === 0 && input.checks.length === 0) return { code: 'check.unverified_api', kind }
  const matched = matchNamed(input.jobs, input.checks, patterns)
  if (matched.length === 0) return { code: 'check.unverified_none', kind }
  const failed = matched.filter((item) => FAILED.has(item.conclusion ?? ''))
  if (failed.length > 0) return { code: 'check.contradicted', kind, jobs: names(failed.map((item) => item.name)) }
  const running = matched.filter((item) => item.status !== 'completed')
  if (running.length > 0) return { code: 'check.unverified_running', kind, jobs: names(running.map((item) => item.name)) }
  const good = matched.filter((item) => PASSED.has(item.conclusion ?? ''))
  if (good.length === 0) return { code: 'check.unverified_none', kind }
  return { code: 'check.verified', kind, jobs: names(good.map((item) => item.name)) }
}

function judgeFiles(files: readonly ChangedFile[] | null, patterns: readonly string[]): ClaimReason {
  if (files == null) return { code: 'files.unverified' }
  const added = files.filter((file) => isAddedTest(file, patterns)).map((file) => file.filename)
  if (added.length > 0) return { code: 'files.verified', files: added.slice(0, 8) }
  return { code: 'files.contradicted', changed: files.length }
}

function judgeIssue(
  claim: ParsedClaim,
  issues: readonly LinkedIssue[],
  resolved: ReadonlyMap<number, ResolvedIssue>,
): ClaimReason {
  if (claim.issueNumber == null) {
    const readable = issues.filter(confirmedIssue)
    if (readable.length === 0) {
      return issues.length > 0 ? { code: 'issue.unverified_unreadable' } : { code: 'issue.unverified_none' }
    }
    return { code: 'issue.verified_any', numbers: readable.map((issue) => issue.number).slice(0, 8) }
  }
  const known = resolved.get(claim.issueNumber)
  if (!known || known.state === 'error') return { code: 'issue.unverified_unreadable', number: claim.issueNumber }
  if (known.state === 'missing') return { code: 'issue.contradicted_missing', number: claim.issueNumber }
  return { code: 'issue.verified', number: claim.issueNumber, title: known.title, linked: known.linked }
}

function isAddedTest(file: ChangedFile, patterns: readonly string[]): boolean {
  if (file.status === 'removed') return false
  const names = [file.filename, file.previousFilename].filter((name): name is string => Boolean(name))
  if (!names.some((name) => matchIgnore(name, patterns))) return false
  return file.additions > 0 || file.status === 'added' || file.status === 'renamed' || file.status === 'copied'
}

interface NamedCheck {
  name: string
  status: string
  conclusion: string | null
}

function matchNamed(
  jobs: readonly WorkflowJobInfo[],
  checks: readonly CheckRunInfo[],
  patterns: readonly string[],
): NamedCheck[] {
  const include = patterns.map(compilePattern)
  const matches = (name: string) => include.some((pattern) => testPattern(pattern, name))
  const matchedJobs = jobs.filter((job) => matches(job.name) || matches(`${job.workflowName} / ${job.name}`))
  const jobNames = new Set(jobs.map((job) => job.name.toLowerCase()))
  const matchedChecks = checks.filter((check) => !jobNames.has(check.name.toLowerCase()) && matches(check.name))
  return [
    ...matchedJobs.map((job) => ({
      name: job.workflowName ? `${job.workflowName} / ${job.name}` : job.name,
      status: job.status,
      conclusion: job.conclusion,
    })),
    ...matchedChecks.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion })),
  ]
}

function collapseEventDuplicates(jobs: readonly EvidenceJobReport[]): EvidenceJobReport[] {
  const buckets = new Map<string, EvidenceJobReport[]>()
  const rest: EvidenceJobReport[] = []
  for (const job of jobs) {
    if (job.event !== 'push' && job.event !== 'pull_request') {
      rest.push(job)
      continue
    }
    const key = `${job.workflowName ?? ''}\0${job.name}`.toLowerCase()
    const bucket = buckets.get(key)
    if (bucket) bucket.push(job)
    else buckets.set(key, [job])
  }
  const chosen: EvidenceJobReport[] = []
  for (const bucket of buckets.values()) {
    const events = new Set(bucket.map((job) => job.event))
    if (bucket.length > 1 && events.has('push') && events.has('pull_request')) chosen.push(representDuplicate(bucket))
    else chosen.push(...bucket)
  }
  return [...rest, ...chosen]
}

function representDuplicate(jobs: readonly EvidenceJobReport[]): EvidenceJobReport {
  const preferred = [...jobs].sort(byPreferredRun)[0]
  if (!preferred) return jobs[0] as EvidenceJobReport
  const failing = jobs.find((job) => FAILED.has(job.conclusion ?? '') || (job.counts?.failed ?? 0) > 0)
  if (!failing) return preferred
  if (FAILED.has(preferred.conclusion ?? '') || (preferred.counts?.failed ?? 0) > 0) return preferred
  return { ...preferred, conclusion: FAILED.has(failing.conclusion ?? '') ? failing.conclusion : 'failure' }
}

function byPreferredRun(a: EvidenceJobReport, b: EvidenceJobReport): number {
  const completed = Number(b.status === 'completed') - Number(a.status === 'completed')
  if (completed !== 0) return completed
  const time = completedMillis(b) - completedMillis(a)
  if (time !== 0) return time
  const pullRequest = Number(b.event === 'pull_request') - Number(a.event === 'pull_request')
  if (pullRequest !== 0) return pullRequest
  return (b.runId ?? 0) - (a.runId ?? 0)
}

function completedMillis(job: EvidenceJobReport): number {
  if (job.status !== 'completed' || !job.completedAt) return 0
  const parsed = Date.parse(job.completedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function sumCounts(jobs: readonly EvidenceJobReport[]): { passed: number; failed: number; skipped: number } | null {
  const counted = jobs.filter((job) => job.counts)
  if (counted.length === 0) return null
  return counted.reduce((total, job) => ({
    passed: total.passed + (job.counts?.passed ?? 0),
    failed: total.failed + (job.counts?.failed ?? 0),
    skipped: total.skipped + (job.counts?.skipped ?? 0),
  }), { passed: 0, failed: 0, skipped: 0 })
}

function displayEvidence(job: EvidenceJobReport): string {
  return job.workflowName ? `${job.workflowName} / ${job.name}` : job.name
}

function names(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

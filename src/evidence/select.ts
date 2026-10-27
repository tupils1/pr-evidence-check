import { compilePattern, testPattern } from '../config'
import type {
  CheckRunInfo,
  EvidenceItem,
  EvidenceJobReport,
  EvidenceReport,
  EvidenceSignal,
  TestEvidenceConfig,
  WorkflowJobInfo,
} from '../types'
import { parseTestOutput } from './parse'

const SPECIFIC_RUNNERS = [
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bpytest\b/i,
  /\bpy-?test\b/i,
  /\bgo[- ]test\b/i,
  /\bcargo[- ]test\b/i,
  /\bphpunit\b/i,
  /\bjunit\b/i,
  /\bmocha\b/i,
  /\bplaywright\b/i,
  /\bcypress\b/i,
  /\brspec\b/i,
  /\bctest\b/i,
  /\bunittest\b/i,
]

export function selectEvidence(input: {
  jobs: readonly WorkflowJobInfo[]
  checks: readonly CheckRunInfo[]
  config: TestEvidenceConfig
}): { jobs: WorkflowJobInfo[]; checks: CheckRunInfo[] } {
  const include = input.config.jobNamePatterns.map(compilePattern)
  const exclude = input.config.excludeNamePatterns.map(compilePattern)
  const jobs = input.jobs.filter((job) => matchesTestName(job.name, include, exclude))
  const jobNames = new Set(input.jobs.map((job) => job.name.toLowerCase()))
  const checks = input.checks.filter((check) => {
    if (jobNames.has(check.name.toLowerCase())) return false
    return matchesTestName(check.name, include, exclude)
  })
  return { jobs, checks }
}

export function matchesTestName(name: string, include: readonly RegExp[], exclude: readonly RegExp[]): boolean {
  if (!include.some((pattern) => testPattern(pattern, name))) return false
  if (SPECIFIC_RUNNERS.some((pattern) => testPattern(pattern, name))) return true
  if (exclude.some((pattern) => testPattern(pattern, name))) return false
  return true
}

export function buildEvidence(input: {
  sha: string
  items: readonly EvidenceItem[]
  config: TestEvidenceConfig
  apiError?: string
  shaMismatch?: { eventSha: string; apiSha: string }
  consideredJobs: number
  consideredChecks: number
}): EvidenceReport {
  const jobs = input.items.map((item) => toJobReport(item, input.config.parseLogs))
  const signals = evidenceSignals(jobs, input)
  return {
    enabled: true,
    status: evidenceStatus(signals),
    sha: input.sha,
    jobs,
    signals,
    consideredJobs: input.consideredJobs,
    consideredChecks: input.consideredChecks,
  }
}

export function skippedEvidence(sha: string): EvidenceReport {
  return {
    enabled: false,
    status: 'skipped',
    sha,
    jobs: [],
    signals: [],
    consideredJobs: 0,
    consideredChecks: 0,
  }
}

export function evidenceStatus(signals: readonly EvidenceSignal[]): EvidenceReport['status'] {
  if (signals.some((signal) => signal.level === 'error')) return 'error'
  if (signals.some((signal) => signal.level === 'warn')) return 'warn'
  return 'pass'
}

function toJobReport(item: EvidenceItem, parseLogs: boolean): EvidenceJobReport {
  const base = {
    source: item.source,
    name: item.name,
    ...(item.workflowName ? { workflowName: item.workflowName } : {}),
    status: item.status,
    conclusion: item.conclusion,
    ...(item.url ? { url: item.url } : {}),
    ...(item.event ? { event: item.event } : {}),
    ...(item.completedAt ? { completedAt: item.completedAt } : {}),
    ...(item.runId != null ? { runId: item.runId } : {}),
  }
  if (item.status !== 'completed') {
    return { ...base, counts: null, note: 'in_progress' }
  }
  if (!parseLogs && item.source === 'workflow_job') {
    return { ...base, counts: null, note: 'not_downloaded' }
  }
  if (item.logError && !item.text) {
    return { ...base, counts: null, note: 'logs_unreadable', logError: item.logError }
  }
  const counts = item.text ? parseTestOutput(item.text) : null
  if (!counts) return { ...base, counts: null, note: item.text ? 'no_summary' : 'logs_unreadable' }
  if (counts.total === 0) return { ...base, counts, note: 'zero_tests' }
  return { ...base, counts }
}

function evidenceSignals(
  jobs: readonly EvidenceJobReport[],
  input: { config: TestEvidenceConfig; apiError?: string; shaMismatch?: { eventSha: string; apiSha: string } },
): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [{ id: 'test_evidence.not_rerun', level: 'info' }]
  if (input.apiError) signals.push({ id: 'test_evidence.api_error', level: 'warn', message: input.apiError })
  if (input.shaMismatch) {
    signals.push({
      id: 'test_evidence.sha_mismatch',
      level: 'warn',
      eventSha: input.shaMismatch.eventSha,
      apiSha: input.shaMismatch.apiSha,
    })
  }
  if (jobs.length === 0) {
    if (!input.apiError) signals.push({ id: 'test_evidence.none', level: input.config.noEvidence })
    return signals
  }
  const running = jobs.filter((job) => job.status !== 'completed')
  if (running.length > 0) signals.push({ id: 'test_evidence.in_progress', level: 'warn', count: running.length })
  const failed = jobs.filter((job) => isFailedConclusion(job.conclusion))
  if (failed.length > 0) {
    signals.push({
      id: 'test_evidence.failed',
      level: input.config.requirePassed ? 'error' : 'warn',
      jobs: failed.map(displayName),
    })
  }
  const completed = jobs.filter((job) => job.status === 'completed')
  if (completed.length > 0 && completed.every((job) => job.conclusion === 'skipped')) {
    signals.push({ id: 'test_evidence.skipped_only', level: 'warn' })
  }
  const unreadable = jobs.filter((job) => job.note === 'logs_unreadable').map(displayName)
  if (unreadable.length > 0) signals.push({ id: 'test_evidence.logs_unreadable', level: 'info', jobs: unreadable })
  const noSummary = jobs.filter((job) => job.note === 'no_summary').map(displayName)
  if (noSummary.length > 0) signals.push({ id: 'test_evidence.no_summary', level: 'info', jobs: noSummary })
  const zero = jobs.filter((job) => job.note === 'zero_tests').map(displayName)
  if (zero.length > 0 && failed.length === 0) signals.push({ id: 'test_evidence.zero_tests', level: 'warn', jobs: zero })
  const green = jobs.filter((job) => job.conclusion === 'success' || job.conclusion === 'neutral')
  if (green.length === jobs.length) signals.push({ id: 'test_evidence.passed', level: 'info', jobs: green.length })
  return signals
}

function isFailedConclusion(conclusion: string | null): boolean {
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled' || conclusion === 'startup_failure'
}

function displayName(job: EvidenceJobReport): string {
  return job.workflowName ? `${job.workflowName} / ${job.name}` : job.name
}

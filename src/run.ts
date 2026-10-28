import { parseClaims } from './claims/parse'
import { confirmedIssue, skippedClaims, verifyClaims, type ResolvedIssue } from './claims/verify'
import { loadConfig, parseFailOn, parseLanguage } from './config'
import { resolvePrContext } from './context'
import { ActionFailure, GitHubHttpError } from './errors'
import { buildEvidence, selectEvidence, skippedEvidence } from './evidence/select'
import type { GitHubClient } from './github/client'
import { analyzePacket, skippedPacket } from './packet/analyze'
import { analyzeLockfiles, filesUnavailableProvenance, skippedProvenance } from './provenance/analyze'
import { createRegistryProvenanceClient, type ProvenanceClient } from './provenance/lookup'
import { renderComment, renderSummary } from './render'
import { analyzeScope, skippedScope } from './scope/analyze'
import { extractClosingReferences, issueKey, mergeLinkedIssues } from './scope/links'
import { findSticky } from './sticky'
import { inlineText } from './text'
import { thresholdFailure } from './threshold'
import type { ChangedFile, CheckRunInfo, EvidenceItem, EvidenceJobReport, LinkedIssue, Report, WorkflowJobInfo } from './types'

export interface ActionIO {
  info(message: string): void
  warning(message: string): void
  error(message: string): void
  setOutput(name: string, value: string): void
  writeSummary(markdown: string): Promise<void>
}

export interface RunInput {
  token: string
  configPath: string
  failOn: string
  commentLanguage: string
  eventName: string
  owner: string
  repo: string
  payload: Record<string, unknown>
}

export async function run(deps: {
  io: ActionIO
  input: RunInput
  createClient: (token: string, owner: string, repo: string) => GitHubClient
  now?: () => Date
  /** Defaults to public registry lookups. Tests pass a stub so they do not use the network. */
  lookupProvenance?: ProvenanceClient
}): Promise<{ commentUrl?: string; skipped?: boolean }> {
  const context = resolvePrContext(deps.input)
  if (context.kind === 'skip') {
    deps.io.info(context.reason)
    return { skipped: true }
  }
  if (context.kind === 'error') throw new ActionFailure('misconfigured', context.reason)
  if (!deps.input.token.trim()) {
    throw new ActionFailure('misconfigured', 'The token input is empty.')
  }
  const failOn = parseFailOn(deps.input.failOn)
  const client = deps.createClient(deps.input.token, context.owner, context.repo)
  const prRepo = `${context.owner}/${context.repo}`

  let pr
  try {
    pr = await client.getPullRequest(context.number)
  } catch (error) {
    throw new ActionFailure('misconfigured', `Cannot read pull request #${context.number}: ${errorMessage(error)} Grant pull-requests: read.`)
  }

  const configFile = await client.getRepoFile(deps.input.configPath, pr.baseSha)
  if (configFile.error) {
    deps.io.warning(`Could not read ${deps.input.configPath} at ${pr.baseSha}: ${configFile.error}. Using defaults.`)
  } else if (configFile.text == null) {
    deps.io.info(`No ${deps.input.configPath} on the base branch. Using defaults.`)
  }
  const config = loadConfig(configFile.error ? null : configFile.text, deps.input.configPath, (message) => {
    deps.io.warning(message)
  })
  const language = parseLanguage(deps.input.commentLanguage) ?? config.language

  const needFiles = config.checks.scope || config.checks.claims || config.checks.lockfileProvenance
  const needIssues = config.checks.scope || config.checks.claims
  const fileResult = needFiles ? await loadFiles(client, pr.number) : undefined
  const issueResult = needIssues ? await loadLinkedIssues(client, pr, context.number, config, prRepo) : undefined
  const scope = config.checks.scope
    ? analyzeScope({
      prRepo,
      files: fileResult?.files ?? [],
      issues: issueResult?.issues ?? [],
      config: config.scope,
      authorLogin: pr.authorLogin,
      authorType: pr.authorType,
      labels: pr.labels,
      ...(fileResult?.error || issueResult?.error ? { apiError: fileResult?.error ?? issueResult?.error } : {}),
      ...(fileResult?.error ? { filesUnavailable: true } : {}),
    })
    : skippedScope()
  const ci = await collectCi(client, context.sha, pr.headSha, config, {
    evidence: config.checks.testEvidence,
    claims: config.checks.claims,
  })
  const packet = config.checks.reviewPacket
    ? analyzePacket(pr.body, config.reviewPacket)
    : skippedPacket()
  const claims = config.checks.claims
    ? await collectClaims(client, deps.io, pr, prRepo, config, {
      files: fileResult?.error ? null : (fileResult?.files ?? null),
      issues: issueResult?.issues ?? [],
      testJobs: ci.testJobs,
      jobs: ci.jobs,
      checks: ci.checks,
      ciError: ci.ciError,
    })
    : skippedClaims()
  const provenance = config.checks.lockfileProvenance
    ? await collectProvenance(client, pr, fileResult, config.lockfileProvenance.maxLookups, deps.lookupProvenance)
    : skippedProvenance()

  const report: Report = {
    language,
    failOn,
    headSha: context.sha,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    scope,
    evidence: ci.evidence,
    packet,
    claims,
    provenance,
  }
  const body = renderComment(report, prRepo)
  let comments
  try {
    comments = await client.listComments(context.number)
  } catch (error) {
    throw commentFailure(context.number, error)
  }
  const sticky = findSticky(comments)
  if (sticky.length > 1) {
    deps.io.warning(`Found ${sticky.length} pr-evidence-check comments. Updating the oldest.`)
  }
  let posted: { id: number; url: string }
  try {
    const existing = sticky[0]
    posted = existing
      ? await client.updateComment(existing.id, body)
      : await client.createComment(context.number, body)
  } catch (error) {
    throw commentFailure(context.number, error)
  }

  deps.io.setOutput('scope-status', scope.status)
  deps.io.setOutput('test-evidence-status', ci.evidence.status)
  deps.io.setOutput('review-packet-status', packet.status)
  deps.io.setOutput('claims-status', claims.status)
  deps.io.setOutput('lockfile-provenance-status', provenance.status)
  deps.io.setOutput('comment-url', posted.url)
  deps.io.setOutput('head-sha', context.sha)
  await deps.io.writeSummary(renderSummary(report, prRepo))
  deps.io.info(`Updated PR evidence comment: ${posted.url}`)

  const contradicted = claims.results.filter((claim) => claim.verdict === 'contradicted')
  if (contradicted.length > 0) {
    const message = `Contradicted claim${contradicted.length === 1 ? '' : 's'} (${config.claims.contradicted}): ${contradicted.map((claim) => inlineText(claim.text, 80)).join('; ')}`
    if (config.claims.contradicted === 'error') deps.io.error(message)
    else deps.io.warning(message)
  }

  // Report-only. Unknown provenance and registry errors stay out of fail-on.
  const failure = thresholdFailure(failOn, [
    { name: 'scope', status: scope.status },
    { name: 'test-evidence', status: ci.evidence.status },
    { name: 'review-packet', status: packet.status },
    { name: 'claims', status: claims.status },
  ])
  if (failure) throw new ActionFailure('threshold', failure)
  return { commentUrl: posted.url }
}

async function loadFiles(client: GitHubClient, number: number): Promise<{ files: ChangedFile[]; error?: string }> {
  try {
    return { files: await client.listFiles(number) }
  } catch (error) {
    return { files: [], error: errorMessage(error) }
  }
}

async function loadLinkedIssues(
  client: GitHubClient,
  pr: { title: string; body: string },
  number: number,
  config: ReturnType<typeof loadConfig>,
  prRepo: string,
): Promise<{ issues: LinkedIssue[]; error?: string }> {
  try {
    const linked = await client.listClosingIssues(number)
    const refs = extractClosingReferences(`${pr.title}\n${pr.body}`, prRepo, config.scope.closingKeywords)
    const known = new Set(linked.issues.map((issue) => issueKey(issue.repo, issue.number)))
    const fetched = new Map<string, LinkedIssue | null>()
    for (const ref of refs) {
      const key = issueKey(ref.repo, ref.number)
      if (known.has(key)) continue
      try {
        fetched.set(key, await client.getIssue(ref.repo, ref.number))
      } catch {
        fetched.set(key, null)
      }
    }
    const issues = mergeLinkedIssues(linked.issues, refs, fetched)
    const apiError = issues.length === 0 && linked.error ? linked.error : undefined
    return { issues, ...(apiError ? { error: apiError } : {}) }
  } catch (error) {
    return { issues: [], error: errorMessage(error) }
  }
}

async function collectCi(
  client: GitHubClient,
  eventSha: string,
  apiSha: string,
  config: ReturnType<typeof loadConfig>,
  want: { evidence: boolean; claims: boolean },
): Promise<{
  evidence: Report['evidence']
  testJobs: EvidenceJobReport[]
  jobs: WorkflowJobInfo[]
  checks: CheckRunInfo[]
  ciError: boolean
}> {
  if (!want.evidence && !want.claims) {
    return { evidence: skippedEvidence(eventSha), testJobs: [], jobs: [], checks: [], ciError: false }
  }
  const mismatch = eventSha !== apiSha ? { shaMismatch: { eventSha, apiSha } } : {}
  try {
    const jobs = await client.listWorkflowJobs(eventSha)
    const checks = await client.listCheckRuns(eventSha)
    const selected = selectEvidence({ jobs, checks, config: config.testEvidence })
    const downloadable = selected.jobs.filter((job) => job.status === 'completed').slice(0, config.testEvidence.maxLogJobs)
    const downloadIds = new Set(downloadable.map((job) => job.id))
    const items: EvidenceItem[] = []
    for (const job of selected.jobs) {
      let text: string | null = null
      let logError: string | undefined
      if (job.status === 'completed' && config.testEvidence.parseLogs) {
        if (downloadIds.has(job.id)) {
          const log = await client.getJobLog(job.id, config.testEvidence.maxLogBytes)
          text = log.text
          logError = log.error
        } else {
          logError = 'log download cap reached'
        }
      }
      items.push({
        source: 'workflow_job',
        name: job.name,
        workflowName: job.workflowName,
        status: job.status,
        conclusion: job.conclusion,
        ...(job.htmlUrl ? { url: job.htmlUrl } : {}),
        ...(job.event ? { event: job.event } : {}),
        ...(job.completedAt ? { completedAt: job.completedAt } : {}),
        runId: job.runId,
        text,
        ...(logError ? { logError } : {}),
      })
    }
    for (const check of selected.checks) {
      items.push({
        source: 'check_run',
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        ...(check.htmlUrl ? { url: check.htmlUrl } : {}),
        text: check.summary ?? null,
      })
    }
    const parsed = buildEvidence({
      sha: eventSha,
      items,
      config: config.testEvidence,
      consideredJobs: jobs.length,
      consideredChecks: checks.length,
      ...mismatch,
    })
    return {
      evidence: want.evidence ? parsed : skippedEvidence(eventSha),
      testJobs: parsed.jobs,
      jobs,
      checks,
      ciError: false,
    }
  } catch (error) {
    const parsed = buildEvidence({
      sha: eventSha,
      items: [],
      config: config.testEvidence,
      apiError: errorMessage(error),
      consideredJobs: 0,
      consideredChecks: 0,
      ...mismatch,
    })
    return {
      evidence: want.evidence ? parsed : skippedEvidence(eventSha),
      testJobs: [],
      jobs: [],
      checks: [],
      ciError: true,
    }
  }
}

async function collectClaims(
  client: GitHubClient,
  io: ActionIO,
  pr: { number: number; title: string; body: string },
  prRepo: string,
  config: ReturnType<typeof loadConfig>,
  evidence: {
    files: ChangedFile[] | null
    issues: LinkedIssue[]
    testJobs: EvidenceJobReport[]
    jobs: WorkflowJobInfo[]
    checks: CheckRunInfo[]
    ciError: boolean
  },
): Promise<Report['claims']> {
  let commits: { sha: string; message: string }[] = []
  let scannedCommits = false
  if (config.claims.scanCommits) {
    try {
      commits = await client.listPullCommits(pr.number)
      scannedCommits = true
    } catch (error) {
      io.warning(`Could not read pull request commits: ${errorMessage(error)}. Commit messages were not scanned.`)
    }
  }
  const parsed = parseClaims({
    title: pr.title,
    body: pr.body,
    commits,
    patterns: config.claims.patterns,
    scanCommits: scannedCommits,
  })
  const resolvedIssues = await resolveClaimIssues(client, prRepo, parsed, evidence.issues)
  return verifyClaims({
    claims: parsed,
    config: config.claims,
    testJobs: evidence.testJobs,
    jobs: evidence.jobs,
    checks: evidence.checks,
    files: evidence.files,
    issues: evidence.issues,
    resolvedIssues,
    ciError: evidence.ciError,
    scanCommits: scannedCommits,
  })
}

async function resolveClaimIssues(
  client: GitHubClient,
  prRepo: string,
  claims: readonly { issueNumber?: number }[],
  issues: readonly LinkedIssue[],
): Promise<Map<number, ResolvedIssue>> {
  const resolved = new Map<number, ResolvedIssue>()
  const numbers = [...new Set(claims.flatMap((claim) => claim.issueNumber == null ? [] : [claim.issueNumber]))]
  for (const number of numbers) {
    const known = issues.filter((issue) => issue.number === number && issue.repo.toLowerCase() === prRepo.toLowerCase())
    const confirmed = known.find(confirmedIssue)
    if (confirmed) {
      resolved.set(number, { number, state: 'found', title: confirmed.title, linked: true })
      continue
    }
    try {
      const loaded = await client.getIssue(prRepo, number)
      if (!loaded) {
        resolved.set(number, { number, state: 'missing', title: '', linked: known.length > 0 })
        continue
      }
      resolved.set(number, { number, state: 'found', title: loaded.title, linked: known.length > 0 })
    } catch {
      resolved.set(number, { number, state: 'error', title: '', linked: known.length > 0 })
    }
  }
  return resolved
}

async function collectProvenance(
  client: GitHubClient,
  pr: { baseSha: string; headSha: string },
  fileResult: { files: ChangedFile[]; error?: string } | undefined,
  maxLookups: number,
  lookup: ProvenanceClient | undefined,
): Promise<Report['provenance']> {
  if (fileResult?.error) return filesUnavailableProvenance(fileResult.error)
  return analyzeLockfiles({
    files: fileResult?.files ?? [],
    maxLookups,
    lookup: lookup ?? createRegistryProvenanceClient(),
    read: async (path, which) => {
      try {
        return await client.getRepoFile(path, which === 'base' ? pr.baseSha : pr.headSha)
      } catch (error) {
        return { text: null, error: errorMessage(error) }
      }
    },
  })
}

function commentFailure(number: number, error: unknown): ActionFailure {
  if (error instanceof GitHubHttpError && (error.status === 401 || error.status === 403 || error.status === 404)) {
    return new ActionFailure(
      'delivery',
      `Cannot comment on pull request #${number} (${error.status}). Grant pull-requests: write.`,
    )
  }
  return new ActionFailure('delivery', `Cannot comment on pull request #${number}: ${errorMessage(error)}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import { describe, expect, it } from 'vitest'
import { DEFAULT_CLAIM_PATTERNS } from '../src/claims/defaults'
import { parseClaims } from '../src/claims/parse'
import { claimStatus, confirmedIssue, skippedClaims, verifyClaims, type ResolvedIssue } from '../src/claims/verify'
import { emptyProvenance } from '../src/provenance/analyze'
import { defaultConfig, loadConfig } from '../src/config'
import { buildEvidence } from '../src/evidence/select'
import { renderComment } from '../src/render'
import { analyzePacket } from '../src/packet/analyze'
import { analyzeScope } from '../src/scope/analyze'
import type { ChangedFile, ClaimReason, ClaimResult, EvidenceJobReport, LinkedIssue, ParsedCounts, Report } from '../src/types'

const patterns = defaultConfig().claims.patterns

function parse(text: string, extra?: { title?: string; commits?: { sha: string; message: string }[]; scanCommits?: boolean }) {
  return parseClaims({
    title: extra?.title ?? '',
    body: text,
    commits: extra?.commits,
    patterns,
    scanCommits: extra?.scanCommits ?? false,
  })
}

function job(partial: Partial<EvidenceJobReport> & Pick<EvidenceJobReport, 'name' | 'conclusion'>): EvidenceJobReport {
  return {
    source: 'workflow_job',
    status: 'completed',
    counts: null,
    ...partial,
  }
}

function counts(passed: number, failed = 0, skipped = 0): ParsedCounts {
  return {
    framework: 'vitest',
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    detail: 'vitest',
  }
}

function file(filename: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { filename, status: 'added', additions: 4, deletions: 0, ...extra }
}

function issue(number: number, extra: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    repo: 'acme/app',
    number,
    title: `Issue ${number}`,
    body: 'body',
    url: `https://github.com/acme/app/issues/${number}`,
    source: 'api',
    ...extra,
  }
}

function resolved(number: number, state: ResolvedIssue['state'], extra: Partial<ResolvedIssue> = {}): ResolvedIssue {
  return { number, state, title: state === 'found' ? `Issue ${number}` : '', linked: true, ...extra }
}

function verify(text: string, extra: Partial<Parameters<typeof verifyClaims>[0]> = {}) {
  const config = defaultConfig().claims
  return verifyClaims({
    config,
    testJobs: [],
    jobs: [],
    checks: [],
    files: [],
    issues: [],
    resolvedIssues: new Map(),
    ciError: false,
    scanCommits: false,
    ...extra,
    claims: extra.claims ?? parse(text),
  })
}

describe('claim phrases', () => {
  it('matches the built-in English and Chinese phrases once each', () => {
    const text = [
      'All tests pass.',
      'tests passing',
      'lint clean',
      'build succeeds',
      'no breaking changes',
      'added tests',
      'Fixed #12',
      '测试全部通过',
      '已通过 lint',
      '新增了测试',
      '已修复',
    ].join('\n')
    const claims = parse(text)
    expect(claims.map((claim) => claim.text)).toEqual([
      'All tests pass',
      'tests passing',
      'lint clean',
      'build succeeds',
      'no breaking changes',
      'added tests',
      'Fixed #12',
      '测试全部通过',
      '已通过 lint',
      '新增了测试',
      '已修复',
    ])
    expect(claims.find((claim) => claim.text === 'Fixed #12')?.issueNumber).toBe(12)
    expect(claims.find((claim) => claim.text === '已修复')?.issueNumber).toBeUndefined()
    expect(DEFAULT_CLAIM_PATTERNS.map((pattern) => pattern.id)).toEqual([
      'tests_pass',
      'lint_clean',
      'build_succeeds',
      'no_breaking_changes',
      'added_tests',
      'fixed_issue',
    ])
  })

  it('keeps the longer phrase, ignores negation, fences, and comments, and can read commits', () => {
    const claims = parse([
      'not all tests pass',
      '没有测试全部通过',
      'all tests pass',
      '```',
      'build succeeds',
      '```',
      '<!-- lint clean -->',
      '已修复 #7 and also 已修复',
    ].join('\n'), {
      title: 'tests passing',
      commits: [{ sha: 'abc1234fff', message: 'Added tests' }],
      scanCommits: true,
    })
    expect(claims.map((claim) => `${claim.source}:${claim.text}`)).toEqual([
      'title:tests passing',
      'description:all tests pass',
      'description:已修复 #7',
      'description:已修复',
      'commit:Added tests',
    ])
    expect(claims.find((claim) => claim.issueNumber === 7)?.source).toBe('description')
    const bodyOnly = parse('all tests pass', {
      commits: [{ sha: 'abc1234fff', message: 'lint clean' }],
      scanCommits: false,
    })
    expect(bodyOnly.map((claim) => claim.text)).toEqual(['all tests pass'])
  })

  it('dedupes the same phrase in the title and description and keeps two issue numbers', () => {
    const claims = parse('Fixes #12\nfixed #12\nFixes #13', { title: 'Fixes #12' })
    expect(claims.map((claim) => claim.issueNumber)).toEqual([12, 13])
    expect(claims[0]?.source).toBe('title')
  })
})

describe('claim verdicts', () => {
  it('verifies, contradicts, and leaves test claims unverified', () => {
    const passing = verify('all tests pass', {
      testJobs: [job({ name: 'unit', workflowName: 'CI', conclusion: 'success', counts: { framework: 'vitest', passed: 4, failed: 0, skipped: 1, total: 5, detail: 'vitest: 4 passed' } })],
    })
    expect(passing.results[0]?.verdict).toBe('verified')
    expect(passing.results[0]?.reason).toMatchObject({ code: 'tests.verified', passed: 4, failed: 0, skipped: 1 })
    expect(passing.status).toBe('pass')

    const failing = verify('测试全部通过', {
      testJobs: [job({ name: 'unit', conclusion: 'failure' })],
    })
    expect(failing.results[0]?.verdict).toBe('contradicted')
    expect(failing.status).toBe('warn')

    const counted = verify('tests passing', {
      testJobs: [job({
        name: 'unit',
        conclusion: 'success',
        counts: { framework: 'jest', passed: 3, failed: 1, skipped: 0, total: 4, detail: 'jest' },
      })],
    })
    expect(counted.results[0]?.reason.code).toBe('tests.contradicted')

    expect(verify('all tests pass').results[0]?.reason.code).toBe('tests.unverified_none')
    expect(verify('all tests pass', {
      testJobs: [job({ name: 'unit', conclusion: null, status: 'in_progress' })],
    }).results[0]?.reason.code).toBe('tests.unverified_running')
    expect(verify('all tests pass', {
      testJobs: [job({ name: 'unit', conclusion: 'skipped' })],
    }).results[0]?.reason.code).toBe('tests.unverified_skipped')
    expect(verify('all tests pass', {
      testJobs: [job({
        name: 'unit',
        conclusion: 'success',
        note: 'zero_tests',
        counts: { framework: 'jest', passed: 0, failed: 0, skipped: 0, total: 0, detail: 'zero' },
      })],
    }).results[0]?.reason.code).toBe('tests.unverified_zero')
    expect(verify('all tests pass', { ciError: true }).results[0]?.reason.code).toBe('tests.unverified_api')
  })

  it('counts one run when push and pull_request repeat the same job', () => {
    const later = verify('all tests pass', {
      testJobs: [
        job({
          name: 'test',
          workflowName: 'CI',
          conclusion: 'success',
          event: 'push',
          completedAt: '2026-10-27T15:50:00Z',
          runId: 1,
          counts: counts(87),
        }),
        job({
          name: 'Test',
          workflowName: 'ci',
          conclusion: 'success',
          event: 'pull_request',
          completedAt: '2026-10-27T15:51:00Z',
          runId: 2,
          counts: counts(87, 0, 2),
        }),
        job({
          name: 'integration',
          workflowName: 'CI',
          conclusion: 'success',
          event: 'pull_request',
          completedAt: '2026-10-27T15:51:00Z',
          runId: 2,
          counts: counts(3),
        }),
      ],
    })
    expect(later.results[0]?.reason).toMatchObject({ code: 'tests.verified', passed: 90, failed: 0, skipped: 2 })

    const tied = verify('all tests pass', {
      testJobs: [
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'push', completedAt: '2026-10-27T15:50:00Z', runId: 9, counts: counts(1) }),
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'pull_request', completedAt: '2026-10-27T15:50:00Z', runId: 2, counts: counts(4, 0, 1) }),
      ],
    })
    expect(tied.results[0]?.reason).toMatchObject({ code: 'tests.verified', passed: 4, failed: 0, skipped: 1 })

    const newestFailure = verify('tests pass', {
      testJobs: [
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'pull_request', completedAt: '2026-10-27T15:50:00Z', runId: 2, counts: counts(87) }),
        job({ name: 'test', workflowName: 'CI', conclusion: 'failure', event: 'push', completedAt: '2026-10-27T15:52:00Z', runId: 3, counts: counts(86, 1) }),
      ],
    })
    expect(newestFailure.results[0]?.reason).toMatchObject({ code: 'tests.contradicted', jobs: ['CI / test'], passed: 86, failed: 1 })

    const olderFailure = verify('测试全部通过', {
      testJobs: [
        job({ name: 'test', workflowName: 'CI', conclusion: 'failure', event: 'push', completedAt: '2026-10-27T15:50:00Z', runId: 1, counts: counts(86, 1) }),
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'pull_request', completedAt: '2026-10-27T15:51:00Z', runId: 2, counts: counts(87) }),
      ],
    })
    expect(olderFailure.results[0]?.verdict).toBe('contradicted')
    expect(olderFailure.results[0]?.reason).toMatchObject({ code: 'tests.contradicted', passed: 87, failed: 0 })

    const parsedFailure = verify('all tests pass', {
      testJobs: [
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'push', completedAt: '2026-10-27T15:49:00Z', runId: 1, counts: counts(3, 1) }),
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'pull_request', completedAt: '2026-10-27T15:51:00Z', runId: 2, counts: counts(4) }),
      ],
    })
    expect(parsedFailure.results[0]?.verdict).toBe('contradicted')
    expect(parsedFailure.results[0]?.reason).toMatchObject({ passed: 4, failed: 0 })

    const sameEvent = verify('all tests pass', {
      testJobs: [
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'pull_request', runId: 1, counts: counts(2) }),
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'pull_request', runId: 2, counts: counts(2) }),
      ],
    })
    expect(sameEvent.results[0]?.reason).toMatchObject({ passed: 4, failed: 0 })

    const otherEvent = verify('all tests pass', {
      testJobs: [
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'push', completedAt: '2026-10-27T15:50:00Z', runId: 1, counts: counts(10) }),
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'pull_request', completedAt: '2026-10-27T15:51:00Z', runId: 2, counts: counts(10) }),
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'workflow_dispatch', completedAt: '2026-10-27T15:52:00Z', runId: 3, counts: counts(10) }),
      ],
    })
    expect(otherEvent.results[0]?.reason).toMatchObject({ passed: 20, failed: 0 })

    const running = verify('all tests pass', {
      testJobs: [
        job({ name: 'test', workflowName: 'CI', conclusion: 'success', event: 'push', completedAt: '2026-10-27T15:50:00Z', runId: 1, counts: counts(5) }),
        job({ name: 'test', workflowName: 'CI', conclusion: null, status: 'in_progress', event: 'pull_request', runId: 4, counts: null }),
      ],
    })
    expect(running.results[0]?.reason).toMatchObject({ code: 'tests.verified', passed: 5, failed: 0 })
  })

  it('judges lint, build, and breaking checks from job and check names', () => {
    const lint = verify('lint clean and build succeeds and no breaking changes', {
      jobs: [
        { id: 1, name: 'lint', workflowName: 'CI', status: 'completed', conclusion: 'success', runId: 1 },
        { id: 2, name: 'build', workflowName: 'CI', status: 'completed', conclusion: 'failure', runId: 1 },
      ],
      checks: [{ name: 'lint', status: 'completed', conclusion: 'failure' }],
    })
    const byId = Object.fromEntries(lint.results.map((result) => [result.id, result.verdict]))
    expect(byId.lint_clean).toBe('verified')
    expect(byId.build_succeeds).toBe('contradicted')
    expect(byId.no_breaking_changes).toBe('unverified')
    expect(verify('已通过 lint', {
      jobs: [{ id: 1, name: 'eslint', workflowName: 'CI', status: 'in_progress', conclusion: null, runId: 1 }],
    }).results[0]?.reason.code).toBe('check.unverified_running')
    expect(verify('build succeeds', { ciError: true }).results[0]?.reason.code).toBe('check.unverified_api')
  })

  it('requires a changed test file for added tests', () => {
    expect(verify('added tests', { files: [file('src/app.ts')] }).results[0]).toMatchObject({
      verdict: 'contradicted',
      reason: { code: 'files.contradicted', changed: 1 },
    })
    expect(verify('新增了测试', { files: [file('tests/demo.test.ts')] }).results[0]?.verdict).toBe('verified')
    expect(verify('添加了测试', {
      files: [file('src/app.test.ts', { status: 'modified', additions: 2 })],
    }).results[0]?.verdict).toBe('verified')
    expect(verify('新增测试', {
      files: [file('tests/old.test.ts', { status: 'removed', additions: 0, deletions: 3 })],
    }).results[0]?.verdict).toBe('contradicted')
    expect(verify('added tests', { files: null }).results[0]?.reason.code).toBe('files.unverified')
  })

  it('checks linked issues without treating a missing number as a fix', () => {
    const found = verify('Fixed #12', {
      issues: [issue(12)],
      resolvedIssues: new Map([[12, resolved(12, 'found', { title: 'Session' })]]),
    })
    expect(found.results[0]?.reason).toMatchObject({ code: 'issue.verified', number: 12, linked: true })

    const missing = verify('fixes #99', {
      resolvedIssues: new Map([[99, resolved(99, 'missing', { linked: false, title: '' })]]),
    })
    expect(missing.results[0]?.verdict).toBe('contradicted')

    const unread = verify('已修复 #4', {
      resolvedIssues: new Map([[4, resolved(4, 'error', { title: '' })]]),
    })
    expect(unread.results[0]?.reason.code).toBe('issue.unverified_unreadable')

    expect(verify('已修复').results[0]?.reason.code).toBe('issue.unverified_none')
    expect(verify('已修复', { issues: [issue(3, { unreadable: 'missing' })] }).results[0]?.reason.code).toBe('issue.unverified_unreadable')
    const any = verify('已修复', { issues: [issue(3), issue(4)] })
    expect(any.results[0]?.reason).toMatchObject({ code: 'issue.verified_any', numbers: [3, 4] })
    expect(confirmedIssue(issue(3))).toBe(true)
    expect(confirmedIssue(issue(3, { source: 'closing_keyword', title: '', body: '', unreadable: 'missing' }))).toBe(false)
  })

  it('uses the configured contradicted severity and skips when disabled', () => {
    const failing = verify('all tests pass', {
      testJobs: [job({ name: 'unit', conclusion: 'failure' })],
      config: { ...defaultConfig().claims, contradicted: 'error' },
    })
    expect(failing.status).toBe('error')
    expect(claimStatus([], 'warn')).toBe('pass')
    expect(skippedClaims().status).toBe('skipped')
    const custom = loadConfig([
      'claims:',
      '  scan-commits: true',
      '  contradicted: error',
      '  patterns:',
      '    - id: ship',
      '      evidence: tests',
      '      patterns:',
      '        - "(?i)ship it"',
    ].join('\n'), 'cfg')
    expect(custom.claims.scanCommits).toBe(true)
    expect(custom.claims.contradicted).toBe('error')
    expect(custom.claims.patterns).toEqual([{ id: 'ship', evidence: 'tests', patterns: ['(?i)ship it'] }])
    expect(() => loadConfig('claims:\n  patterns:\n    - id: a\n      evidence: vibe\n      patterns: ["x"]\n', 'cfg')).toThrow(/evidence/)
    expect(() => loadConfig('claims:\n  patterns:\n    - id: a\n      evidence: tests\n      patterns: ["("]\n', 'cfg')).toThrow(/regex/i)
    expect(() => loadConfig('claims:\n  contradicted: info\n', 'cfg')).toThrow(/warn or error/)
  })
})

describe('claim comment', () => {
  it('renders every verdict in English and Chinese inside the sticky comment', () => {
    const reasons: ClaimReason[] = [
      { code: 'tests.verified', jobs: ['CI / unit'], passed: 4, failed: 0, skipped: 0 },
      { code: 'tests.contradicted', jobs: ['CI / unit'], passed: 1, failed: 1 },
      { code: 'tests.unverified_none' },
      { code: 'tests.unverified_running', jobs: ['CI / unit'] },
      { code: 'tests.unverified_skipped' },
      { code: 'tests.unverified_zero', jobs: ['CI / unit'] },
      { code: 'tests.unverified_api' },
      { code: 'check.verified', kind: 'lint', jobs: ['CI / lint'] },
      { code: 'check.contradicted', kind: 'build', jobs: ['CI / build'] },
      { code: 'check.unverified_none', kind: 'breaking' },
      { code: 'check.unverified_running', kind: 'lint', jobs: ['CI / lint'] },
      { code: 'check.unverified_api', kind: 'build' },
      { code: 'files.verified', files: ['tests/demo.test.ts'] },
      { code: 'files.contradicted', changed: 2 },
      { code: 'files.unverified' },
      { code: 'issue.verified', number: 12, title: 'Session', linked: true },
      { code: 'issue.verified_any', numbers: [3] },
      { code: 'issue.contradicted_missing', number: 99 },
      { code: 'issue.unverified_none' },
      { code: 'issue.unverified_unreadable', number: 4 },
      { code: 'issue.unverified_unreadable' },
    ]
    const results: ClaimResult[] = reasons.map((reason, index) => ({
      id: `claim-${index}`,
      evidence: 'tests',
      text: `claim ${index}`,
      source: index === 1 ? 'commit' : index === 2 ? 'title' : 'description',
      ...(index === 1 ? { commitSha: 'abc1234fff' } : {}),
      verdict: reason.code.includes('contradicted') ? 'contradicted' : reason.code.includes('unverified') ? 'unverified' : 'verified',
      reason,
    }))
    const config = defaultConfig()
    const report = (language: Report['language']): Report => ({
      language,
      failOn: 'none',
      headSha: 'a'.repeat(40),
      generatedAt: '2026-10-27T00:00:00.000Z',
      scope: analyzeScope({ prRepo: 'acme/app', config: config.scope, issues: [], files: [] }),
      evidence: buildEvidence({ sha: 'a'.repeat(40), items: [], config: config.testEvidence, consideredJobs: 0, consideredChecks: 0 }),
      packet: analyzePacket('', config.reviewPacket),
      claims: { enabled: true, status: 'warn', scannedCommits: true, results, omitted: 2 },
      provenance: emptyProvenance(),
    })
    const english = renderComment(report('en'), 'acme/app')
    const chinese = renderComment(report('zh'), 'acme/app')
    expect(english).toContain('claims=warn')
    expect(english).toContain('### Claim verification')
    expect(english).toContain('contradicted')
    expect(english).toContain('commit `abc1234`')
    expect(english).toContain('2 more were omitted')
    expect(english).toContain('Issue #99 does not exist')
    expect(chinese).toContain('### 声明核验')
    expect(chinese).toContain('相矛盾')
    expect(chinese).toContain('已证实')
    expect(chinese).toContain('未证实')
    expect(chinese).toContain('issue #99 不存在')
    const empty = renderComment({ ...report('en'), claims: { enabled: true, status: 'pass', scannedCommits: false, results: [], omitted: 0 } }, 'acme/app')
    expect(empty).toContain('No configured claim')
  })
})

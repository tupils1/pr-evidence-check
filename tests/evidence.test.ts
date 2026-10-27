import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config'
import { parseCargo, parseGo, parseJest, parseJunit, parsePytest, parseTestOutput, parseVitest } from '../src/evidence/parse'
import { buildEvidence, matchesTestName, selectEvidence } from '../src/evidence/select'
import { compilePattern } from '../src/config'
import type { CheckRunInfo, TestEvidenceConfig, WorkflowJobInfo } from '../src/types'

function evidenceConfig(overrides: Partial<TestEvidenceConfig> = {}): TestEvidenceConfig {
  return { ...defaultConfig().testEvidence, ...overrides }
}

function job(partial: Partial<WorkflowJobInfo> & Pick<WorkflowJobInfo, 'id' | 'name'>): WorkflowJobInfo {
  return {
    workflowName: 'CI',
    status: 'completed',
    conclusion: 'success',
    runId: 1,
    ...partial,
  }
}

describe('test log parsers', () => {
  it('parses jest, including failures, skips, and ANSI color', () => {
    const text = [
      'PASS src/a.test.ts',
      'Tests:       1 failed, 1 skipped, 2 todo, 10 passed, 14 total',
    ].join('\n')
    expect(parseJest(text)).toMatchObject({ framework: 'jest', passed: 10, failed: 1, skipped: 3, total: 14 })
    const colored = text.replace('Tests:', '\u001b[32mTests:\u001b[0m')
    expect(parseTestOutput(colored)?.framework).toBe('jest')
    expect(parseTestOutput(colored)?.passed).toBe(10)
  })

  it('parses the last vitest summary and does not treat it as jest', () => {
    const text = [
      ' Test Files  1 failed | 2 passed (3)',
      '      Tests  1 failed | 1 skipped | 10 passed (12)',
    ].join('\n')
    expect(parseVitest(text)).toMatchObject({ framework: 'vitest', passed: 10, failed: 1, skipped: 1, total: 12 })
    expect(parseJest(text)).toBeNull()
  })

  it('parses pytest summaries, including errors and no tests ran', () => {
    expect(parsePytest('============================== 12 passed in 0.42s =============================='))
      .toMatchObject({ framework: 'pytest', passed: 12, failed: 0, total: 12 })
    expect(parsePytest('========== 1 failed, 2 passed, 3 skipped, 1 error in 0.50s =========='))
      .toMatchObject({ passed: 2, failed: 2, skipped: 3 })
    expect(parsePytest('============================ no tests ran in 0.01s ============================'))
      .toMatchObject({ total: 0, detail: 'pytest: no tests ran' })
  })

  it('counts go tests and falls back to package lines', () => {
    const tests = ['--- PASS: TestAdd (0.00s)', '--- FAIL: TestSub (0.00s)', '--- SKIP: TestOld (0.00s)', 'FAIL\texample.com/mod\t0.01s'].join('\n')
    expect(parseGo(tests)).toMatchObject({ passed: 1, failed: 1, skipped: 1, total: 3 })
    const packages = ['ok  \texample.com/a\t0.1s', 'FAIL\texample.com/b\t0.1s'].join('\n')
    expect(parseGo(packages)?.detail).toContain('packages')
    expect(parseGo(packages)).toMatchObject({ passed: 1, failed: 1, total: 2 })
  })

  it('sums cargo targets', () => {
    const text = [
      'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
      'test result: FAILED. 0 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out',
    ].join('\n')
    expect(parseCargo(text)).toMatchObject({ framework: 'cargo', passed: 2, failed: 1, skipped: 2, total: 5 })
  })

  it('parses junit XML and surefire text, preferring a testsuites total', () => {
    const xml = [
      '<testsuites tests="10" failures="1" errors="1" skipped="2">',
      '<testsuite name="a" tests="4" failures="0" errors="0" skipped="0"></testsuite>',
      '<testsuite name="b" tests="6" failures="1" errors="1" skipped="2"></testsuite>',
      '</testsuites>',
    ].join('')
    expect(parseJunit(xml)).toMatchObject({ framework: 'junit', total: 10, failed: 2, skipped: 2, passed: 6 })
    const siblings = '<testsuite tests="3" failures="0"></testsuite><testsuite tests="2" failures="1" errors="0" skipped="1"></testsuite>'
    expect(parseJunit(siblings)).toMatchObject({ total: 5, failed: 1, skipped: 1 })
    expect(parseJunit('Tests run: 10, Failures: 1, Errors: 0, Skipped: 2')).toMatchObject({
      total: 10,
      failed: 1,
      skipped: 2,
      passed: 7,
    })
  })

  it('prefers jest over a junit reporter in the same log and returns null when nothing matches', () => {
    const mixed = 'Tests:       4 passed, 4 total\n<testsuite tests="4" failures="0"></testsuite>'
    expect(parseTestOutput(mixed)?.framework).toBe('jest')
    expect(parseTestOutput('all good\nno framework here')).toBeNull()
  })

  it('keeps a summary that sits at the end of a truncated log', () => {
    const head = `${'x'.repeat(5000)}\n`
    const text = `${head}Tests:       3 passed, 3 total`
    expect(parseTestOutput(text.slice(-80))?.passed).toBe(3)
  })

  it('parses summaries inside timestamped Actions groups', () => {
    const vitest = [
      '2026-10-27T14:19:58.0000000Z ##[group]Run npm test',
      '2026-10-27T14:19:58.1000000Z \u001b[2m      Tests \u001b[22m 1 passed (1)\r\u001b[2m      Tests \u001b[22m 68 passed (68)',
      '2026-10-27T14:19:58.2000000Z ##[endgroup]',
    ].join('\n')
    expect(parseTestOutput(vitest)).toMatchObject({ framework: 'vitest', passed: 68, total: 68 })

    const jest = '2026-10-27T14:19:58.0000000Z ##[group]jest\n2026-10-27T14:19:59.0000000Z Tests:       4 passed, 4 total\n2026-10-27T14:19:59.1000000Z ::endgroup::'
    expect(parseTestOutput(jest)).toMatchObject({ framework: 'jest', passed: 4, total: 4 })

    const go = [
      '2026-10-27T14:19:58.0000000Z --- PASS: TestAdd (0.00s)',
      '2026-10-27T14:19:58.1000000Z --- FAIL: TestSub (0.00s)',
    ].join('\n')
    expect(parseTestOutput(go)).toMatchObject({ framework: 'go', passed: 1, failed: 1, total: 2 })
  })
})

describe('selecting existing CI', () => {
  const include = defaultConfig().testEvidence.jobNamePatterns.map(compilePattern)
  const exclude = defaultConfig().testEvidence.excludeNamePatterns.map(compilePattern)

  it('matches common test names and skips lint, coverage, and this action', () => {
    expect(matchesTestName('unit', include, exclude)).toBe(true)
    expect(matchesTestName('test (node 22)', include, exclude)).toBe(true)
    expect(matchesTestName('pytest', include, exclude)).toBe(true)
    expect(matchesTestName('cargo test', include, exclude)).toBe(true)
    expect(matchesTestName('lint', include, exclude)).toBe(false)
    expect(matchesTestName('test-coverage', include, exclude)).toBe(false)
    expect(matchesTestName('pr-evidence', include, exclude)).toBe(false)
    expect(matchesTestName('build', include, exclude)).toBe(false)
    expect(matchesTestName('jest coverage', include, exclude)).toBe(true)
  })

  it('drops check runs that duplicate a workflow job name', () => {
    const jobs = [job({ id: 1, name: 'unit' }), job({ id: 2, name: 'build' })]
    const checks: CheckRunInfo[] = [
      { name: 'unit', status: 'completed', conclusion: 'success', summary: 'Tests: 1 passed, 1 total' },
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'CircleCI: pytest', status: 'completed', conclusion: 'success' },
    ]
    const selected = selectEvidence({ jobs, checks, config: evidenceConfig() })
    expect(selected.jobs.map((item) => item.name)).toEqual(['unit'])
    expect(selected.checks.map((item) => item.name)).toEqual(['CircleCI: pytest'])
  })
})

describe('evidence status', () => {
  it('passes when a test job succeeded, with or without a parsed summary', () => {
    const parsed = buildEvidence({
      sha: 'abc',
      config: evidenceConfig(),
      consideredJobs: 2,
      consideredChecks: 0,
      items: [{
        source: 'workflow_job',
        name: 'unit',
        workflowName: 'CI',
        status: 'completed',
        conclusion: 'success',
        event: 'pull_request',
        completedAt: '2026-10-27T15:51:00Z',
        runId: 2,
        text: 'Tests:       4 passed, 4 total',
      }],
    })
    expect(parsed.status).toBe('pass')
    expect(parsed.jobs[0]?.counts?.passed).toBe(4)
    expect(parsed.jobs[0]).toMatchObject({ event: 'pull_request', completedAt: '2026-10-27T15:51:00Z', runId: 2 })
    expect(parsed.signals.some((signal) => signal.id === 'test_evidence.not_rerun')).toBe(true)

    const unparsed = buildEvidence({
      sha: 'abc',
      config: evidenceConfig(),
      consideredJobs: 1,
      consideredChecks: 0,
      items: [{
        source: 'workflow_job',
        name: 'unit',
        status: 'completed',
        conclusion: 'success',
        text: 'ran a custom runner',
      }],
    })
    expect(unparsed.status).toBe('pass')
    expect(unparsed.jobs[0]?.note).toBe('no_summary')
  })

  it('flags no test evidence, in-progress jobs, failures, skips, empty summaries, and API errors', () => {
    const none = buildEvidence({ sha: 'abc', config: evidenceConfig(), items: [], consideredJobs: 3, consideredChecks: 1 })
    expect(none.status).toBe('pass')
    expect(none.signals.find((signal) => signal.id === 'test_evidence.none')).toMatchObject({ level: 'info' })

    const warned = buildEvidence({
      sha: 'abc',
      config: evidenceConfig({ noEvidence: 'warn' }),
      items: [],
      consideredJobs: 1,
      consideredChecks: 0,
    })
    expect(warned.status).toBe('warn')

    const strict = buildEvidence({
      sha: 'abc',
      config: evidenceConfig({ noEvidence: 'error' }),
      items: [],
      consideredJobs: 0,
      consideredChecks: 0,
    })
    expect(strict.status).toBe('error')

    const api = buildEvidence({
      sha: 'abc',
      config: evidenceConfig({ noEvidence: 'error' }),
      items: [],
      consideredJobs: 0,
      consideredChecks: 0,
      apiError: 'GitHub API 500',
    })
    expect(api.status).toBe('warn')
    expect(api.signals.some((signal) => signal.id === 'test_evidence.none')).toBe(false)

    const running = buildEvidence({
      sha: 'abc',
      config: evidenceConfig(),
      consideredJobs: 1,
      consideredChecks: 0,
      items: [{ source: 'workflow_job', name: 'unit', status: 'in_progress', conclusion: null, text: null }],
    })
    expect(running.status).toBe('warn')
    expect(running.jobs[0]?.note).toBe('in_progress')

    const failed = buildEvidence({
      sha: 'abc',
      config: evidenceConfig(),
      consideredJobs: 1,
      consideredChecks: 0,
      items: [{
        source: 'workflow_job',
        name: 'unit',
        status: 'completed',
        conclusion: 'failure',
        text: '===== 1 failed, 1 passed in 0.2s =====',
      }],
    })
    expect(failed.status).toBe('warn')
    const required = buildEvidence({
      sha: 'abc',
      config: evidenceConfig({ requirePassed: true }),
      consideredJobs: 1,
      consideredChecks: 0,
      items: [{ source: 'workflow_job', name: 'unit', status: 'completed', conclusion: 'failure', text: null, logError: 'logs expired (410)' }],
    })
    expect(required.status).toBe('error')

    const skipped = buildEvidence({
      sha: 'abc',
      config: evidenceConfig(),
      consideredJobs: 1,
      consideredChecks: 0,
      items: [{ source: 'check_run', name: 'unit', status: 'completed', conclusion: 'skipped', text: null }],
    })
    expect(skipped.status).toBe('warn')

    const zero = buildEvidence({
      sha: 'abc',
      config: evidenceConfig(),
      consideredJobs: 1,
      consideredChecks: 0,
      items: [{
        source: 'workflow_job',
        name: 'pytest',
        status: 'completed',
        conclusion: 'success',
        text: '============================ no tests ran in 0.01s ============================',
      }],
    })
    expect(zero.status).toBe('warn')
    expect(zero.signals.some((signal) => signal.id === 'test_evidence.zero_tests')).toBe(true)
  })

  it('does not download logs when parsing is disabled', () => {
    const report = buildEvidence({
      sha: 'abc',
      config: evidenceConfig({ parseLogs: false }),
      consideredJobs: 1,
      consideredChecks: 0,
      items: [{ source: 'workflow_job', name: 'unit', status: 'completed', conclusion: 'success', text: null }],
    })
    expect(report.status).toBe('pass')
    expect(report.jobs[0]?.note).toBe('not_downloaded')
  })
})

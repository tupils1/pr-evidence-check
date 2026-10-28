import { describe, expect, it } from 'vitest'
import { ActionFailure } from '../src/errors'
import type { GitHubClient, PullRequestInfo } from '../src/github/client'
import { MARKER } from '../src/render'
import { run, type ActionIO, type RunInput } from '../src/run'
import type { ChangedFile, CheckRunInfo, LinkedIssue, WorkflowJobInfo } from '../src/types'

const SHA = 'a'.repeat(40)

function pull(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 7,
    title: 'Fix session timeout',
    body: [
      'Fixes #12',
      '## Intent',
      'Refresh the session token before it expires.',
      '## Risks',
      'Login could loop if refresh fails.',
      '## Tests run',
      'CI unit job passed.',
      '## Self-verification',
      'I logged in locally and waited past the old timeout.',
    ].join('\n'),
    headSha: SHA,
    baseSha: 'b'.repeat(40),
    baseRef: 'main',
    authorLogin: 'octocat',
    authorType: 'User',
    labels: [],
    ...overrides,
  }
}

class FakeClient {
  comments: { id: number; body: string }[] = []
  created = 0
  updated = 0
  files: ChangedFile[] = [{ filename: 'src/auth/session.ts', status: 'modified', additions: 12, deletions: 1 }]
  jobs: WorkflowJobInfo[] = [{
    id: 9,
    name: 'unit',
    workflowName: 'CI',
    status: 'completed',
    conclusion: 'success',
    htmlUrl: 'https://example.test/job',
    runId: 1,
  }]
  checks: CheckRunInfo[] = []
  issues: LinkedIssue[] = [{
    repo: 'acme/app',
    number: 12,
    title: 'Session timeout on login',
    body: 'The session token expires during login.',
    url: 'https://github.com/acme/app/issues/12',
    source: 'api',
  }]
  configText: string | null = null
  configError?: string
  fileError?: string
  commentError?: string
  logText = 'Tests:       4 passed, 4 total\nSECRET_TOKEN=abc'
  listFilesCalled = 0
  commitReads = 0
  commitError = ''
  commits: { sha: string; message: string }[] = []
  fetchedIssues = new Map<number, LinkedIssue | null>()
  repoFiles = new Map<string, { text: string | null; error?: string }>()

  client(): GitHubClient {
    return {
      getPullRequest: async () => pull(this.pullOverrides),
      getRepoFile: async (path, ref) => {
        if (path.includes('pr-evidence')) {
          return { text: this.configText, ...(this.configError ? { error: this.configError } : {}) }
        }
        return this.repoFiles.get(`${ref}\n${path}`) ?? { text: null }
      },
      listFiles: async () => {
        this.listFilesCalled += 1
        if (this.fileError) throw new Error(this.fileError)
        return this.files
      },
      listClosingIssues: async () => ({ issues: this.issues }),
      getIssue: async (_repo, number) => {
        if (this.fetchedIssues.has(number)) return this.fetchedIssues.get(number) ?? null
        return null
      },
      listPullCommits: async () => {
        this.commitReads += 1
        if (this.commitError) throw new Error(this.commitError)
        return this.commits
      },
      listCheckRuns: async () => this.checks,
      listWorkflowJobs: async () => this.jobs,
      getJobLog: async () => ({ text: this.logText }),
      listComments: async () => this.comments,
      createComment: async (_number, body) => {
        if (this.commentError) throw Object.assign(new Error(this.commentError), { status: 403 })
        this.created += 1
        this.comments.push({ id: 10, body })
        return { id: 10, url: 'https://example.test/comment/10' }
      },
      updateComment: async (id, body) => {
        this.updated += 1
        const existing = this.comments.find((comment) => comment.id === id)
        if (existing) existing.body = body
        return { id, url: `https://example.test/comment/${id}` }
      },
    }
  }

  pullOverrides: Partial<PullRequestInfo> = {}
}

function io(): ActionIO & { outputs: Record<string, string>; summary: string; warnings: string[]; infos: string[] } {
  const outputs: Record<string, string> = {}
  const warnings: string[] = []
  const infos: string[] = []
  let summary = ''
  return {
    outputs,
    warnings,
    infos,
    get summary() {
      return summary
    },
    info: (message) => infos.push(message),
    warning: (message) => warnings.push(message),
    error: (message) => warnings.push(`error: ${message}`),
    setOutput: (name, value) => {
      outputs[name] = value
    },
    writeSummary: async (markdown) => {
      summary = markdown
    },
  }
}

function input(overrides: Partial<RunInput> = {}): RunInput {
  return {
    token: 'token',
    configPath: '.github/pr-evidence.yml',
    failOn: 'none',
    commentLanguage: '',
    eventName: 'pull_request',
    owner: 'acme',
    repo: 'app',
    payload: { pull_request: { number: 7, head: { sha: SHA } } },
    ...overrides,
  }
}

describe('run', () => {
  it('posts one sticky comment for a clean pull request and does not fail', async () => {
    const fake = new FakeClient()
    const actions = io()
    const result = await run({
      io: actions,
      input: input(),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })
    expect(result.commentUrl).toBe('https://example.test/comment/10')
    expect(fake.created).toBe(1)
    expect(fake.comments[0]?.body).toContain(MARKER)
    expect(fake.comments[0]?.body).toContain('In scope for #12')
    expect(fake.comments[0]?.body).not.toContain('SECRET_TOKEN')
    expect(actions.outputs['scope-status']).toBe('pass')
    expect(actions.outputs['test-evidence-status']).toBe('pass')
    expect(actions.outputs['review-packet-status']).toBe('pass')
    expect(actions.summary).toContain('PR evidence')
  })

  it('updates the existing sticky comment instead of creating another', async () => {
    const fake = new FakeClient()
    fake.comments = [{ id: 4, body: `${MARKER}\nold` }, { id: 5, body: `${MARKER}\ndupe` }]
    const actions = io()
    await run({ io: actions, input: input(), createClient: () => fake.client(), now: () => new Date('2026-10-27T00:00:00.000Z') })
    expect(fake.created).toBe(0)
    expect(fake.updated).toBe(1)
    expect(fake.comments[0]?.body).toContain('path tokens')
    expect(actions.warnings.some((warning) => warning.includes('oldest'))).toBe(true)
  })

  it('stays green when checks warn unless fail-on says otherwise', async () => {
    const fake = new FakeClient()
    fake.files = [{ filename: 'src/billing/invoice.ts', status: 'modified', additions: 4, deletions: 0 }]
    fake.jobs = []
    await expect(run({
      io: io(),
      input: input({ failOn: 'none' }),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).resolves.toMatchObject({ commentUrl: 'https://example.test/comment/10' })
    expect(fake.comments[0]?.body).toContain('`scope.outside`')
    expect(fake.comments[0]?.body).toContain('test_evidence.none')

    await expect(run({
      io: io(),
      input: input({ failOn: 'warning' }),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).rejects.toMatchObject({ kind: 'threshold' })

    fake.files = [
      { filename: 'src/auth/session.ts', status: 'modified', additions: 1, deletions: 0 },
      { filename: 'src/billing/invoice.ts', status: 'modified', additions: 1, deletions: 0 },
      { filename: 'src/billing/tax.ts', status: 'modified', additions: 1, deletions: 0 },
      { filename: 'src/billing/refund.ts', status: 'modified', additions: 1, deletions: 0 },
    ]
    fake.jobs = [{ id: 1, name: 'unit', workflowName: 'CI', status: 'completed', conclusion: 'success', runId: 1 }]
    await expect(run({
      io: io(),
      input: input({ failOn: 'error' }),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).rejects.toMatchObject({ kind: 'threshold', message: expect.stringContaining('scope=error') })
  })

  it('keeps fail-on warning green when the only gap is missing test evidence', async () => {
    const fake = new FakeClient()
    fake.jobs = []
    fake.checks = []
    const actions = io()
    await expect(run({
      io: actions,
      input: input({ failOn: 'warning' }),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).resolves.toMatchObject({ commentUrl: 'https://example.test/comment/10' })
    expect(actions.outputs['test-evidence-status']).toBe('pass')
    expect(fake.comments[0]?.body).toContain('test_evidence.none')
  })

  it('does not warn a bot author who opened a pull request without an issue', async () => {
    const fake = new FakeClient()
    fake.issues = []
    fake.files = [{ filename: 'src/app.ts', status: 'modified', additions: 2, deletions: 0 }]
    fake.pullOverrides = {
      title: 'Bump lodash',
      body: 'Automated dependency update.',
      authorLogin: 'dependabot[bot]',
      authorType: 'Bot',
      labels: ['dependencies'],
    }
    const actions = io()
    await run({
      io: actions,
      input: input(),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })
    expect(actions.outputs['scope-status']).toBe('pass')
    expect(fake.comments[0]?.body).toContain('author is a bot')
    expect(fake.comments[0]?.body).toContain('dependabot[bot]')
  })

  it('reads config from the base ref and ignores a pull request that would disable checks', async () => {
    const fake = new FakeClient()
    fake.configText = 'checks:\n  review-packet: false\n'
    const actions = io()
    await run({ io: actions, input: input(), createClient: () => fake.client(), now: () => new Date('2026-10-27T00:00:00.000Z') })
    expect(actions.outputs['review-packet-status']).toBe('skipped')
    expect(fake.comments[0]?.body).toContain('Disabled in config')
  })

  it('does not list files when no check needs them, and still comments if the files API fails', async () => {
    const disabled = new FakeClient()
    disabled.configText = 'checks:\n  scope: false\n  claims: false\n  lockfile-provenance: false\n'
    const quiet = io()
    await run({ io: quiet, input: input(), createClient: () => disabled.client(), now: () => new Date('2026-10-27T00:00:00.000Z') })
    expect(disabled.listFilesCalled).toBe(0)
    expect(quiet.outputs['lockfile-provenance-status']).toBe('skipped')

    const provenanceOnly = new FakeClient()
    provenanceOnly.configText = 'checks:\n  scope: false\n  claims: false\n'
    await run({ io: io(), input: input(), createClient: () => provenanceOnly.client(), now: () => new Date('2026-10-27T00:00:00.000Z') })
    expect(provenanceOnly.listFilesCalled).toBe(1)

    const broken = new FakeClient()
    broken.fileError = 'GitHub API 500'
    const actions = io()
    await run({ io: actions, input: input(), createClient: () => broken.client(), now: () => new Date('2026-10-27T00:00:00.000Z') })
    expect(actions.outputs['scope-status']).toBe('warn')
    expect(actions.outputs['lockfile-provenance-status']).toBe('pass')
    expect(broken.comments[0]?.body).toContain('scope.api_error')
    expect(broken.comments[0]?.body).toContain('lockfile_provenance.files_unreadable')
    expect(broken.comments[0]?.body).not.toContain('changes no files')
  })

  it('skips a workflow_run with no pull request and fails on a push or a bad token', async () => {
    let created = 0
    const result = await run({
      io: io(),
      input: input({ eventName: 'workflow_run', payload: { workflow_run: { head_sha: SHA, pull_requests: [] } } }),
      createClient: () => {
        created += 1
        return new FakeClient().client()
      },
    })
    expect(result.skipped).toBe(true)
    expect(created).toBe(0)

    await expect(run({
      io: io(),
      input: input({ eventName: 'push', payload: {} }),
      createClient: () => new FakeClient().client(),
    })).rejects.toMatchObject({ kind: 'misconfigured' })

    await expect(run({
      io: io(),
      input: input({ token: '  ' }),
      createClient: () => new FakeClient().client(),
    })).rejects.toBeInstanceOf(ActionFailure)

    await expect(run({
      io: io(),
      input: input({ failOn: 'sometimes' }),
      createClient: () => new FakeClient().client(),
    })).rejects.toMatchObject({ kind: 'misconfigured' })
  })

  it('fails when the token cannot comment or the base config is invalid', async () => {
    const denied = new FakeClient()
    const client = denied.client()
    const { GitHubHttpError } = await import('../src/errors')
    client.createComment = async () => {
      throw new GitHubHttpError(403, 'nope')
    }
    await expect(run({
      io: io(),
      input: input(),
      createClient: () => client,
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).rejects.toMatchObject({ kind: 'delivery' })

    const invalid = new FakeClient()
    invalid.configText = 'scope:\n  large-diff-lines: "nope"\n'
    await expect(run({
      io: io(),
      input: input(),
      createClient: () => invalid.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).rejects.toMatchObject({ kind: 'misconfigured' })
  })

  it('notes a head SHA that moved and honors the comment language', async () => {
    const fake = new FakeClient()
    fake.pullOverrides = { headSha: 'c'.repeat(40) }
    const actions = io()
    await run({
      io: actions,
      input: input({ commentLanguage: 'zh' }),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })
    expect(fake.comments[0]?.body).toContain('test_evidence.sha_mismatch')
    expect(fake.comments[0]?.body).toContain('PR 证据')
  })

  it('warns when a claim is contradicted and does not fail unless fail-on says so', async () => {
    const fake = new FakeClient()
    fake.issues = []
    fake.jobs = [{ id: 3, name: 'unit', workflowName: 'CI', status: 'completed', conclusion: 'failure', runId: 2 }]
    fake.configText = 'checks:\n  scope: false\n  test-evidence: false\n'
    fake.pullOverrides = {
      title: 'Demo',
      body: [
        'All tests pass.',
        '## Intent',
        'Show a contradicted test claim.',
        '## Risks',
        'The unit job is red.',
        '## Tests run',
        'Watched the unit job.',
        '## Self-verification',
        'Read the failing assertion.',
      ].join('\n'),
    }
    const actions = io()
    await expect(run({
      io: actions,
      input: input({ failOn: 'none' }),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).resolves.toMatchObject({ commentUrl: 'https://example.test/comment/10' })
    expect(actions.outputs['claims-status']).toBe('warn')
    expect(actions.outputs['test-evidence-status']).toBe('skipped')
    expect(fake.commitReads).toBe(0)
    expect(fake.comments[0]?.body).toContain('contradicted')
    expect(actions.warnings.some((warning) => warning.includes('All tests pass'))).toBe(true)

    await expect(run({
      io: io(),
      input: input({ failOn: 'warning' }),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).rejects.toMatchObject({ kind: 'threshold', message: expect.stringContaining('claims=warn') })
  })

  it('scans commit messages only when claims.scan-commits is set', async () => {
    const fake = new FakeClient()
    fake.issues = []
    fake.files = [{ filename: 'README.md', status: 'modified', additions: 2, deletions: 0 }]
    fake.jobs = [{ id: 4, name: 'lint', workflowName: 'CI', status: 'completed', conclusion: 'success', runId: 3 }]
    fake.commits = [{ sha: 'abc1234fff', message: 'lint clean' }]
    fake.configText = 'checks:\n  scope: false\nclaims:\n  scan-commits: true\n'
    fake.pullOverrides = {
      title: 'Demo',
      body: [
        '## Intent',
        'The claim is only in the commit message.',
        '## Risks',
        'None for this fixture.',
        '## Tests run',
        'No test claim is made here.',
        '## Self-verification',
        'Checked the commit subject.',
      ].join('\n'),
    }
    const actions = io()
    await run({
      io: actions,
      input: input(),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })
    expect(fake.commitReads).toBe(1)
    expect(actions.outputs['claims-status']).toBe('pass')
    expect(fake.comments[0]?.body).toContain('verified')
    expect(fake.comments[0]?.body).toContain('commit `abc1234`')
  })

  it('verifies a numbered fix when the issue exists and warns if commits cannot be read', async () => {
    const fake = new FakeClient()
    fake.issues = []
    fake.files = [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0 }]
    fake.fetchedIssues.set(8, {
      repo: 'acme/app',
      number: 8,
      title: 'Real bug',
      body: 'details',
      url: 'https://github.com/acme/app/issues/8',
      source: 'closing_keyword',
    })
    fake.commitError = 'commits unavailable'
    fake.configText = 'checks:\n  scope: false\nclaims:\n  scan-commits: true\n'
    fake.pullOverrides = {
      title: 'Demo',
      body: [
        '已修复 #8',
        '## Intent',
        'Point at an existing issue.',
        '## Risks',
        'The Chinese keyword does not auto-close.',
        '## Tests run',
        'No test claim.',
        '## Self-verification',
        'Looked up issue 8.',
      ].join('\n'),
    }
    const actions = io()
    await run({
      io: actions,
      input: input(),
      createClient: () => fake.client(),
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })
    expect(actions.outputs['claims-status']).toBe('pass')
    expect(fake.comments[0]?.body).toContain('verified')
    expect(fake.comments[0]?.body).toContain('Real bug')
    expect(actions.warnings.some((warning) => warning.includes('commits unavailable'))).toBe(true)
  })

  it('warns and uses defaults when the base config cannot be read', async () => {
    const fake = new FakeClient()
    fake.configError = 'GitHub API 403'
    const actions = io()
    await run({ io: actions, input: input(), createClient: () => fake.client(), now: () => new Date('2026-10-27T00:00:00.000Z') })
    expect(actions.warnings.some((warning) => warning.includes('Using defaults'))).toBe(true)
    expect(actions.outputs['scope-status']).toBe('pass')
  })

  it('lists new lockfile packages and does not fail the job when provenance is unknown', async () => {
    const fake = new FakeClient()
    const base = 'b'.repeat(40)
    fake.files = [
      { filename: 'package-lock.json', status: 'modified', additions: 20, deletions: 2 },
      { filename: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    ]
    fake.repoFiles.set(`${base}\npackage-lock.json`, { text: npmLock(['left-pad@1.3.0']) })
    fake.repoFiles.set(`${SHA}\npackage-lock.json`, { text: npmLock(['left-pad@1.3.0', 'fresh@2.0.0', 'git-dep@1.0.0'], { 'git-dep@1.0.0': 'git+https://github.com/example/git-dep.git' }) })
    fake.configText = [
      'checks:',
      '  scope: false',
      '  test-evidence: false',
      '  review-packet: false',
      '  claims: false',
    ].join('\n')
    const seen: string[] = []
    const actions = io()
    await expect(run({
      io: actions,
      input: input({ failOn: 'error' }),
      createClient: () => fake.client(),
      lookupProvenance: {
        lookup: async (pkg) => {
          seen.push(`${pkg.name}@${pkg.version}`)
          if (pkg.name === 'fresh') return { state: 'present', detail: { code: 'npm_provenance' } }
          throw new Error('registry down')
        },
      },
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).resolves.toMatchObject({ commentUrl: 'https://example.test/comment/10' })
    expect(actions.outputs['lockfile-provenance-status']).toBe('pass')
    expect(actions.outputs['scope-status']).toBe('skipped')
    expect(seen).toEqual(['fresh@2.0.0'])
    expect(fake.comments[0]?.body).toContain('fresh@\u200b2.0.0')
    expect(fake.comments[0]?.body).toContain('npm registry provenance')
    expect(fake.comments[0]?.body).toContain('git-dep@\u200b1.0.0')
    expect(fake.comments[0]?.body).toContain('not a package from these public registries')
    expect(fake.comments[0]?.body).not.toContain('left-pad@1.3.0')
    expect(actions.warnings).toEqual([])

    const unreadable = new FakeClient()
    unreadable.files = [{ filename: 'Cargo.lock', status: 'modified', additions: 4, deletions: 0 }]
    unreadable.repoFiles.set(`${SHA}\nCargo.lock`, { text: '[[package]]\nname = "app"\nversion = "0.1.0"\n' })
    unreadable.repoFiles.set(`${base}\nCargo.lock`, { text: null, error: 'blob too large' })
    unreadable.configText = fake.configText
    const again = io()
    await expect(run({
      io: again,
      input: input({ failOn: 'warning' }),
      createClient: () => unreadable.client(),
      lookupProvenance: { lookup: async () => { throw new Error('should not be called') } },
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).resolves.toMatchObject({ commentUrl: 'https://example.test/comment/10' })
    expect(again.outputs['lockfile-provenance-status']).toBe('pass')
    expect(unreadable.comments[0]?.body).toContain('lockfile_provenance.unreadable')
    expect(unreadable.comments[0]?.body).toContain('blob too large')

    const throwing = new FakeClient()
    throwing.files = [{ filename: 'go.sum', status: 'added', additions: 1, deletions: 0 }]
    throwing.configText = fake.configText
    const client = throwing.client()
    client.getRepoFile = async (path) => {
      if (path.includes('pr-evidence')) return { text: throwing.configText }
      throw new Error('connection reset')
    }
    const dropped = io()
    await expect(run({
      io: dropped,
      input: input({ failOn: 'error' }),
      createClient: () => client,
      lookupProvenance: { lookup: async () => { throw new Error('should not be called') } },
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    })).resolves.toMatchObject({ commentUrl: 'https://example.test/comment/10' })
    expect(dropped.outputs['lockfile-provenance-status']).toBe('pass')
    expect(throwing.comments[0]?.body).toContain('connection reset')
  })
})

function npmLock(specs: string[], resolved: Record<string, string> = {}): string {
  const packages: Record<string, { version: string; resolved?: string }> = { '': { version: '1.0.0' } }
  for (const spec of specs) {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    const entry: { version: string; resolved?: string } = { version }
    const url = resolved[spec]
    if (url) entry.resolved = url
    packages[`node_modules/${name}`] = entry
  }
  return JSON.stringify({ lockfileVersion: 3, packages })
}

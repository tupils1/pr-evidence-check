import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config'
import { analyzeScope } from '../src/scope/analyze'
import { matchSensitive } from '../src/scope/sensitive'
import { activeSensitiveRules } from '../src/scope/sensitive'
import { issueTokens, pathTokens, tokensMatch } from '../src/scope/tokenize'
import type { ChangedFile, LinkedIssue, ScopeConfig } from '../src/types'

function issue(partial: Partial<LinkedIssue> & Pick<LinkedIssue, 'number' | 'title' | 'body'>): LinkedIssue {
  return {
    repo: 'acme/app',
    url: `https://github.com/acme/app/issues/${partial.number}`,
    source: 'both',
    ...partial,
  }
}

function changed(partial: Partial<ChangedFile> & Pick<ChangedFile, 'filename'>): ChangedFile {
  return { status: 'modified', additions: 10, deletions: 1, ...partial }
}

function scope(overrides: Partial<ScopeConfig> = {}): ScopeConfig {
  return { ...defaultConfig().scope, ...overrides }
}

function fileReport(filename: string, files: ReturnType<typeof analyzeScope>['files']) {
  const found = files.find((file) => file.filename === filename)
  if (!found) throw new Error(`missing ${filename}`)
  return found
}

const loginIssue = issue({
  number: 12,
  title: 'Session timeout on login',
  body: 'The session token expires during login. See `src/auth/login.ts`.',
})

describe('scope vs linked issue', () => {
  it('explains an in-scope file from path tokens and quotes the issue', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [loginIssue],
      files: [changed({ filename: 'src/auth/session.ts', additions: 40, deletions: 2 })],
    })
    const file = fileReport('src/auth/session.ts', report.files)
    expect(file.verdict).toBe('in_scope')
    const why = file.explanations[0]
    expect(why?.code).toBe('scope.in_scope.path_tokens')
    if (why?.code !== 'scope.in_scope.path_tokens') return
    expect(why.tokens).toContain('session')
    expect(why.snippet.toLowerCase()).toContain('session')
    expect(why.issueNumber).toBe(12)
    expect(report.status).toBe('pass')
  })

  it('does not treat a longer path mention as the whole parent directory', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 2, title: 'Touch one file', body: 'Only `src/auth/login.ts` needs a change.' })],
      files: [changed({ filename: 'src/auth/billing-export.ts' })],
    })
    const file = fileReport('src/auth/billing-export.ts', report.files)
    expect(file.verdict).toBe('in_scope')
    expect(file.explanations[0]?.code).toBe('scope.in_scope.path_tokens')
    if (file.explanations[0]?.code !== 'scope.in_scope.path_tokens') return
    expect(file.explanations[0].tokens).toEqual(['auth'])

    const directory = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 2, title: 'Auth module', body: 'The bug is in src/auth/.' })],
      files: [changed({ filename: 'src/auth/billing-export.ts' })],
    })
    expect(fileReport('src/auth/billing-export.ts', directory.files).explanations[0]?.code).toBe('scope.in_scope.path_mention')
  })

  it('prefers a literal path mention over a weaker token match', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [loginIssue],
      files: [changed({ filename: 'src/auth/login.ts' })],
    })
    expect(fileReport('src/auth/login.ts', report.files).explanations[0]?.code).toBe('scope.in_scope.path_mention')
  })

  it('explains files outside the issue, including a directory cluster and a large unrelated diff', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ largeFileLines: 50 }),
      issues: [loginIssue],
      files: [
        changed({ filename: 'src/auth/session.ts' }),
        changed({ filename: 'src/billing/invoice.ts', additions: 40, deletions: 20 }),
        changed({ filename: 'src/billing/tax.ts', additions: 4, deletions: 0 }),
      ],
    })
    expect(report.status).toBe('warn')
    const invoice = fileReport('src/billing/invoice.ts', report.files)
    expect(invoice.verdict).toBe('outside_scope')
    const outside = invoice.explanations.find((item) => item.code === 'scope.outside')
    expect(outside?.code).toBe('scope.outside')
    if (outside?.code !== 'scope.outside') return
    expect(outside.fileTokens).toEqual(expect.arrayContaining(['billing', 'invoice']))
    expect(outside.issueKeywords).toEqual(expect.arrayContaining(['session', 'login']))
    expect(outside.issueRefs).toEqual(['#12'])
    const cluster = report.signals.find((signal) => signal.id === 'scope.outside_cluster')
    expect(cluster?.id).toBe('scope.outside_cluster')
    if (cluster?.id !== 'scope.outside_cluster') return
    expect(cluster.directory).toBe('src/billing')
    expect(cluster.files).toEqual(['src/billing/invoice.ts', 'src/billing/tax.ts'])
    expect(report.signals.some((signal) => signal.id === 'scope.large_unrelated_file' && signal.filename === 'src/billing/invoice.ts')).toBe(true)
  })

  it('raises error only when enough judged files are outside scope', () => {
    const files = [
      changed({ filename: 'src/auth/session.ts' }),
      changed({ filename: 'src/billing/invoice.ts' }),
      changed({ filename: 'src/billing/tax.ts' }),
      changed({ filename: 'docs/unrelated-notes.txt' }),
    ]
    const strict = analyzeScope({ prRepo: 'acme/app', config: scope(), issues: [loginIssue], files })
    expect(strict.status).toBe('error')
    expect(strict.signals.some((signal) => signal.id === 'scope.outside_ratio')).toBe(true)

    const two = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [loginIssue],
      files: files.slice(0, 3).slice(1),
    })
    expect(two.files.filter((file) => file.verdict === 'outside_scope')).toHaveLength(2)
    expect(two.status).toBe('warn')

    const infra = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [loginIssue],
      files: [
        changed({ filename: 'src/billing/invoice.ts' }),
        changed({ filename: 'src/billing/tax.ts' }),
        changed({ filename: 'package-lock.json' }),
        changed({ filename: '.github/workflows/ci.yml' }),
      ],
    })
    expect(infra.files.filter((file) => file.verdict === 'outside_scope')).toHaveLength(4)
    expect(infra.signals.some((signal) => signal.id === 'scope.outside_ratio')).toBe(false)
    expect(infra.signals.some((signal) => signal.id === 'scope.sensitive')).toBe(true)
    expect(infra.status).toBe('warn')

    const mostlyOutside = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [loginIssue],
      files: [
        changed({ filename: 'src/billing/invoice.ts' }),
        changed({ filename: 'src/billing/tax.ts' }),
        changed({ filename: 'src/billing/refund.ts' }),
        changed({ filename: 'package-lock.json' }),
        changed({ filename: '.github/workflows/ci.yml' }),
      ],
    })
    expect(mostlyOutside.status).toBe('error')
    const ratio = mostlyOutside.signals.find((signal) => signal.id === 'scope.outside_ratio')
    expect(ratio && ratio.id === 'scope.outside_ratio' && ratio.outside).toBe(3)
    expect(ratio && ratio.id === 'scope.outside_ratio' && ratio.judged).toBe(3)
  })

  it('does not treat generic directories as scope evidence', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 1, title: 'Update src', body: 'Please update src and index.' })],
      files: [changed({ filename: 'src/index.ts' })],
    })
    expect(fileReport('src/index.ts', report.files).verdict).toBe('outside_scope')
    expect(pathTokens('src/index.ts')).toEqual([])
    expect(issueTokens('Update src and index')).not.toContain('src')
  })

  it('does not match auth inside author', () => {
    expect(tokensMatch('auth', 'author')).toBe(false)
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 1, title: 'Author bio', body: 'Update the author page copy.' })],
      files: [changed({ filename: 'src/auth/session.ts' })],
    })
    expect(fileReport('src/auth/session.ts', report.files).verdict).toBe('outside_scope')
  })

  it('matches a plural or a longer identifier by a specific prefix', () => {
    expect(tokensMatch('parser', 'parse')).toBe(true)
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 3, title: 'parseHeader crashes', body: 'parseHeader returns nil.' })],
      files: [changed({ filename: 'src/http/parser.ts' })],
    })
    const file = fileReport('src/http/parser.ts', report.files)
    expect(file.verdict).toBe('in_scope')
    expect(file.explanations[0]?.code).toBe('scope.in_scope.path_tokens')
  })

  it('can use diff identifiers when the path itself does not match, and says so', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 3, title: 'parseHeader crashes', body: 'The header parser breaks on timeout.' })],
      files: [changed({
        filename: 'src/http/server.ts',
        patch: '@@\n+func parseHeader(timeoutValue string) {}\n',
      })],
    })
    const file = fileReport('src/http/server.ts', report.files)
    expect(file.verdict).toBe('in_scope')
    expect(file.explanations[0]?.code).toBe('scope.in_scope.diff_keywords')
  })

  it('does not let a lockfile diff borrow keywords from the issue', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [loginIssue],
      files: [changed({
        filename: 'package-lock.json',
        additions: 800,
        deletions: 10,
        patch: '+\n+"sessionTimeout": "1"\n+"parseHeader"\n',
      })],
    })
    const file = fileReport('package-lock.json', report.files)
    expect(file.verdict).toBe('outside_scope')
    expect(file.sensitive.map((hit) => hit.reason)).toContain('lockfile')
    expect(file.sensitive[0]?.mentioned).toBe(false)
    expect(file.explanations.some((item) => item.code === 'scope.sensitive')).toBe(true)
    expect(report.signals.some((signal) => signal.id === 'scope.sensitive')).toBe(true)
    expect(report.status).toBe('warn')
  })

  it('treats a sensitive path as intentional when the issue names it', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({
        number: 4,
        title: 'Run tests in CI',
        body: 'Update `.github/workflows/ci.yml` so the unit job runs on pull requests.',
      })],
      files: [changed({ filename: '.github/workflows/ci.yml', additions: 12, deletions: 0 })],
    })
    const file = fileReport('.github/workflows/ci.yml', report.files)
    expect(file.verdict).toBe('in_scope')
    expect(file.sensitive[0]?.mentioned).toBe(true)
    expect(file.explanations.some((item) => item.code === 'scope.sensitive' && item.mentioned)).toBe(true)
    expect(report.signals.some((signal) => signal.id === 'scope.sensitive')).toBe(false)
    expect(report.status).toBe('pass')
  })

  it('flags built-in sensitive paths and ignores lookalikes', () => {
    const rules = activeSensitiveRules([], [])
    const texts: string[] = []
    expect(matchSensitive('src/clock.ts', rules, texts)).toEqual([])
    expect(matchSensitive('src/secretary.ts', rules, texts)).toEqual([])
    expect(matchSensitive('.env.local', rules, texts).map((hit) => hit.reason)).toEqual(['env_file'])
    expect(matchSensitive('Dockerfile', rules, texts).map((hit) => hit.reason)).toEqual(['container'])
    expect(matchSensitive('tsconfig.json', rules, texts).map((hit) => hit.reason)).toEqual(['tooling_config'])
    expect(matchSensitive('id_rsa', rules, texts).map((hit) => hit.reason)).toEqual(['credential'])
    expect(matchSensitive('package.json', rules, texts).map((hit) => hit.reason)).toEqual(['manifest'])
  })

  it('adds maintainer sensitive paths and can turn a built-in rule off', () => {
    const extra = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ extraSensitivePaths: ['infra/**'] }),
      issues: [loginIssue],
      files: [changed({ filename: 'infra/main.tf' })],
    })
    expect(fileReport('infra/main.tf', extra.files).sensitive[0]?.reason).toBe('custom')

    const disabled = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ disabledSensitiveIds: ['lockfiles'] }),
      issues: [loginIssue],
      files: [changed({ filename: 'package-lock.json' })],
    })
    expect(fileReport('package-lock.json', disabled.files).sensitive).toEqual([])
  })

  it('does not judge ignored paths, and still flags them when they are sensitive', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ ignorePaths: ['**/*.md', '**/package-lock.json'] }),
      issues: [loginIssue],
      files: [
        changed({ filename: 'README.md', additions: 3, deletions: 0 }),
        changed({ filename: 'package-lock.json' }),
      ],
    })
    expect(fileReport('README.md', report.files).verdict).toBe('ignored')
    expect(fileReport('package-lock.json', report.files).verdict).toBe('ignored')
    expect(fileReport('package-lock.json', report.files).sensitive).not.toEqual([])
    expect(report.status).toBe('warn')
    expect(report.signals.some((signal) => signal.id === 'scope.outside_ratio')).toBe(false)
  })

  it('uses the previous path when a rename moves a file out of its old name', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [loginIssue],
      files: [changed({
        filename: 'src/unrelated/name.ts',
        previousFilename: 'src/auth/session.ts',
        status: 'renamed',
      })],
    })
    const file = fileReport('src/unrelated/name.ts', report.files)
    expect(file.verdict).toBe('in_scope')
    const match = file.explanations.find((item) => item.code === 'scope.in_scope.path_tokens')
    expect(match && 'viaPrevious' in match && match.viaPrevious).toBe('src/auth/session.ts')
    expect(file.explanations.some((item) => item.code === 'scope.renamed_from')).toBe(true)
  })

  it('warns when nothing is linked, but still explains sensitive paths', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      files: [
        changed({ filename: 'src/auth/session.ts' }),
        changed({ filename: '.github/workflows/ci.yml' }),
      ],
    })
    expect(report.status).toBe('warn')
    expect(fileReport('src/auth/session.ts', report.files).verdict).toBe('not_compared')
    expect(fileReport('src/auth/session.ts', report.files).explanations[0]?.code).toBe('scope.no_linked_issue')
    expect(report.signals.some((signal) => signal.id === 'scope.no_linked_issue')).toBe(true)
    expect(report.signals.some((signal) => signal.id === 'scope.sensitive')).toBe(true)
  })

  it('warns on a large pull request even when every file matches', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ largeDiffLines: 30, largeDiffFiles: 10 }),
      issues: [loginIssue],
      files: [changed({ filename: 'src/auth/session.ts', additions: 20, deletions: 10 })],
    })
    expect(report.status).toBe('warn')
    const signal = report.signals.find((item) => item.id === 'scope.large_diff')
    expect(signal?.id).toBe('scope.large_diff')
    if (signal?.id !== 'scope.large_diff') return
    expect(signal.overLines).toBe(true)
    expect(signal.additions).toBe(20)
  })

  it('does not call an empty file list a successful empty PR when the API failed', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      files: [],
      apiError: 'GitHub API 500',
      filesUnavailable: true,
    })
    expect(report.status).toBe('warn')
    expect(report.signals.map((signal) => signal.id)).toEqual(['scope.api_error'])
  })

  it('passes a pull request that changes no files', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [loginIssue],
      files: [],
    })
    expect(report.status).toBe('pass')
    expect(report.signals.map((signal) => signal.id)).toEqual(['scope.no_files'])
  })

  it('explains a Chinese issue that names a path, and one that does not', () => {
    const named = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 8, title: '修复登录超时', body: '请看 `src/auth/login.ts`。' })],
      files: [changed({ filename: 'src/auth/login.ts' })],
    })
    expect(fileReport('src/auth/login.ts', named.files).verdict).toBe('in_scope')

    const unnamed = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 8, title: '修复登录超时', body: '登录一段时间后会话失效。' })],
      files: [changed({ filename: 'src/auth/login.ts' })],
    })
    const file = fileReport('src/auth/login.ts', unnamed.files)
    expect(file.verdict).toBe('outside_scope')
    const outside = file.explanations.find((item) => item.code === 'scope.outside')
    if (outside?.code !== 'scope.outside') throw new Error('expected outside')
    expect(outside.issueKeywords.some((keyword) => keyword.includes('登录'))).toBe(true)
  })

  it('warns when every linked issue body is unreadable', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({ number: 6, title: '', body: '', unreadable: 'issue body unavailable' })],
      files: [changed({ filename: 'src/auth/session.ts' })],
    })
    expect(report.signals.some((signal) => signal.id === 'scope.issue_unreadable')).toBe(true)
    expect(fileReport('src/auth/session.ts', report.files).verdict).toBe('outside_scope')
  })

  it('labels a cross-repo issue in the file explanation', () => {
    const report = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [issue({
        repo: 'acme/other',
        number: 2,
        title: 'session',
        body: 'session token',
        url: 'https://github.com/acme/other/issues/2',
      })],
      files: [changed({ filename: 'src/auth/session.ts' })],
    })
    const match = fileReport('src/auth/session.ts', report.files).explanations[0]
    expect(match && 'repo' in match && match.repo).toBe('acme/other')
  })

  it('records a missing issue as info for bots, docs, ignore-paths, and skip labels', () => {
    const code = [changed({ filename: 'src/app.ts' })]
    const bot = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      authorLogin: 'dependabot[bot]',
      authorType: 'Bot',
      files: code,
    })
    expect(bot.status).toBe('pass')
    expect(bot.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({
      level: 'info',
      quiet: 'bot',
      quietDetail: 'dependabot[bot]',
    })

    const renovate = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      authorLogin: 'renovate',
      authorType: 'User',
      files: code,
    })
    expect(renovate.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ level: 'info', quiet: 'bot' })

    const bracketBot = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      authorLogin: 'github-actions[bot]',
      authorType: 'User',
      files: code,
    })
    expect(bracketBot.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({
      quiet: 'bot',
      quietDetail: 'github-actions[bot]',
    })

    const extraDocs = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ docsPaths: ['notes/**'] }),
      issues: [],
      files: [changed({ filename: 'notes/a.txt' })],
    })
    expect(extraDocs.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ quiet: 'docs' })

    const human = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      authorLogin: 'octocat',
      authorType: 'User',
      files: code,
    })
    expect(human.status).toBe('warn')
    expect(human.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ level: 'warn' })

    const docs = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      authorLogin: 'octocat',
      files: [changed({ filename: 'README.md' }), changed({ filename: 'docs/guide.mdx' })],
    })
    expect(docs.status).toBe('pass')
    expect(docs.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ quiet: 'docs' })

    const mixed = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      files: [changed({ filename: 'README.md' }), changed({ filename: 'src/app.ts' })],
    })
    expect(mixed.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ level: 'warn' })

    const ignored = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ ignorePaths: ['generated/**'] }),
      issues: [],
      files: [changed({ filename: 'generated/types.ts' })],
    })
    expect(ignored.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ quiet: 'ignored' })

    const both = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ ignorePaths: ['generated/**'] }),
      issues: [],
      files: [
        changed({ filename: 'README.md' }),
        changed({ filename: 'generated/types.ts' }),
      ],
    })
    expect(both.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ quiet: 'docs_or_ignored' })

    const renamed = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      files: [changed({ filename: 'docs/moved.md', previousFilename: 'src/app.ts', status: 'renamed' })],
    })
    expect(renamed.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ level: 'warn' })

    const labeled = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ skipLabels: ['Dependencies'] }),
      issues: [],
      labels: ['dependencies'],
      files: code,
    })
    expect(labeled.status).toBe('pass')
    expect(labeled.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({
      quiet: 'label',
      quietDetail: 'dependencies',
    })

    const skipped = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ noLinkedIssue: 'skip' }),
      issues: [],
      files: code,
    })
    expect(skipped.signals.some((signal) => signal.id === 'scope.no_linked_issue')).toBe(false)
    expect(skipped.status).toBe('pass')

    const forced = analyzeScope({
      prRepo: 'acme/app',
      config: scope({ noLinkedIssue: 'info' }),
      issues: [],
      authorLogin: 'octocat',
      files: code,
    })
    expect(forced.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ quiet: 'config', level: 'info' })

    const botLockfile = analyzeScope({
      prRepo: 'acme/app',
      config: scope(),
      issues: [],
      authorLogin: 'dependabot',
      files: [changed({ filename: 'package-lock.json' })],
    })
    expect(botLockfile.signals.find((signal) => signal.id === 'scope.no_linked_issue')).toMatchObject({ level: 'info' })
    expect(botLockfile.signals.some((signal) => signal.id === 'scope.sensitive')).toBe(true)
    expect(botLockfile.status).toBe('warn')
  })
})

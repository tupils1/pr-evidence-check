import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config'
import { buildEvidence } from '../src/evidence/select'
import { analyzePacket } from '../src/packet/analyze'
import { renderComment, sortFiles } from '../src/render'
import { analyzeScope } from '../src/scope/analyze'
import { findSticky } from '../src/sticky'
import type { ChangedFile, LinkedIssue, Report } from '../src/types'

const issue: LinkedIssue = {
  repo: 'acme/app',
  number: 12,
  title: 'Session timeout on login',
  body: 'See `src/auth/login.ts`. The session token expires.',
  url: 'https://github.com/acme/app/issues/12',
  source: 'both',
}

function changed(filename: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { filename, status: 'modified', additions: 10, deletions: 1, ...extra }
}

function reportFor(language: Report['language']): Report {
  const config = defaultConfig()
  const scope = analyzeScope({
    prRepo: 'acme/app',
    config: config.scope,
    issues: [issue],
    files: [
      changed('src/auth/login.ts'),
      changed('src/billing/invoice.ts', { additions: 40, deletions: 20 }),
      changed('src/billing/tax.ts'),
      changed('src/billing/refund.ts'),
      changed('.github/workflows/ci.yml'),
      changed('package-lock.json', { additions: 500, deletions: 4, patch: '+\n+"session"\n' }),
    ],
  })
  const evidence = buildEvidence({
    sha: 'a'.repeat(40),
    config: config.testEvidence,
    consideredJobs: 1,
    consideredChecks: 0,
    items: [{
      source: 'workflow_job',
      name: 'unit',
      workflowName: 'CI',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/acme/app/actions/runs/1',
      text: 'Tests:       4 passed, 4 total\nSECRET_TOKEN=abc',
    }],
  })
  const packet = analyzePacket('## Intent\n\nRefresh sessions.\n', config.reviewPacket)
  return {
    language,
    failOn: 'none',
    headSha: 'a'.repeat(40),
    generatedAt: '2026-10-27T00:00:00.000Z',
    scope,
    evidence,
    packet,
  }
}

describe('comment rendering', () => {
  it('explains every file in English and does not leak log text or closing keywords', () => {
    const comment = renderComment(reportFor('en'), 'acme/app')
    expect(comment.startsWith('<!-- pr-evidence-check -->')).toBe(true)
    expect(comment).toContain('scope=error')
    expect(comment).toContain('src/billing/invoice.ts')
    expect(comment).toContain('`scope.outside`')
    expect(comment).toContain('`scope.in_scope.path_mention`')
    expect(comment).toContain('`scope.sensitive`')
    expect(comment).toContain('`scope.outside_cluster`')
    expect(comment).toContain('dependency lockfile')
    expect(comment).toContain('No shared keyword')
    expect(comment).not.toContain('SECRET_TOKEN')
    const withoutCode = comment.replace(/`[^`]*`/g, '')
    expect(withoutCode).not.toMatch(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+/i)
    expect(sortFiles(reportFor('en').scope.files)[0]?.filename).not.toBe('src/auth/login.ts')
  })

  it('explains an info-level missing issue without turning the check red', () => {
    const base = reportFor('en')
    const scope = analyzeScope({
      prRepo: 'acme/app',
      config: defaultConfig().scope,
      issues: [],
      authorLogin: 'renovate[bot]',
      authorType: 'Bot',
      files: [changed('README.md')],
    })
    const comment = renderComment({ ...base, scope }, 'acme/app')
    expect(comment).toContain('scope=pass')
    expect(comment).toContain('author is a bot')
    expect(comment).toContain('renovate[bot]')
    const zh = renderComment({ ...base, language: 'zh', scope }, 'acme/app')
    expect(zh).toContain('机器人')
    expect(zh).toContain('renovate[bot]')
  })

  it('renders the same signals in Chinese', () => {
    const comment = renderComment(reportFor('zh'), 'acme/app')
    expect(comment).toContain('范围与关联 issue')
    expect(comment).toContain('超出范围')
    expect(comment).toContain('没有共同关键词')
    expect(comment).toContain('依赖锁文件')
    expect(comment).toContain('测试证据')
    expect(comment).toContain('审查材料包')
    expect(comment).toContain('只读取已有 CI')
  })

  it('finds the sticky marker and ignores other comments', () => {
    const comments = [
      { id: 1, body: 'hello' },
      { id: 2, body: `<!-- pr-evidence-check -->\nold` },
      { id: 3, body: '<!-- pr-evidence-check -->\nother' },
    ]
    expect(findSticky(comments).map((comment) => comment.id)).toEqual([2, 3])
  })
})

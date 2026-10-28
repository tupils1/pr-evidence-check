import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActionFailure } from '../src/errors'
import { compilePattern, defaultConfig, loadConfig, loadConfigFile, parseFailOn, parseLanguage } from '../src/config'

describe('config', () => {
  it('uses defaults when the file is missing or empty', () => {
    const warnings: string[] = []
    const defaults = loadConfig(null, '.github/pr-evidence.yml', (message) => warnings.push(message))
    expect(defaults.checks.scope).toBe(true)
    expect(defaults.testEvidence.noEvidence).toBe('info')
    expect(defaults.scope.noLinkedIssue).toBe('warn')
    expect(defaults.scope.skipLabels).toEqual([])
    expect(loadConfig('# just a comment\n', 'x', (message) => warnings.push(message)).language).toBe('en')
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-evidence-'))
    expect(loadConfigFile(path.join(dir, 'missing.yml')).testEvidence.parseLogs).toBe(true)
    expect(warnings).toEqual([])
  })

  it('overlays a partial file and warns on unknown keys', () => {
    const warnings: string[] = []
    const config = loadConfig(
      [
        'language: zh',
        'extra: true',
        'checks:',
        '  scope: false',
        'scope:',
        '  large-diff-lines: 50',
        '  sensitive-paths:',
        '    - infra/**',
        'test-evidence:',
        '  no-evidence: error',
        '  job-name-patterns:',
        '    - "(?i)\\\\bcustom\\\\b"',
        'review-packet:',
        '  incomplete: error',
        '  headings:',
        '    intent: ["Why", "为何"]',
      ].join('\n'),
      '.github/pr-evidence.yml',
      (message) => warnings.push(message),
    )
    expect(config.language).toBe('zh')
    expect(config.checks.scope).toBe(false)
    expect(config.checks.testEvidence).toBe(true)
    expect(config.scope.largeDiffLines).toBe(50)
    expect(config.scope.extraSensitivePaths).toEqual(['infra/**'])
    expect(config.scope.largeDiffFiles).toBe(defaultConfig().scope.largeDiffFiles)
    expect(config.testEvidence.noEvidence).toBe('error')
    expect(config.reviewPacket.incomplete).toBe('error')
    expect(config.reviewPacket.headings.intent).toEqual(['Why', '为何'])
    expect(config.reviewPacket.headings.risks).toContain('风险')
    expect(warnings.some((warning) => warning.includes('extra'))).toBe(true)
    expect(compilePattern(config.testEvidence.jobNamePatterns[0] ?? '').test('Custom Job')).toBe(true)
  })

  it('fails closed on invalid config', () => {
    expect(() => loadConfig('scope: [1]', 'cfg')).toThrow(ActionFailure)
    expect(() => loadConfig('scope:\n  large-diff-lines: "400"\n', 'cfg')).toThrow(/number/)
    expect(() => loadConfig('test-evidence:\n  job-name-patterns:\n    - "("\n', 'cfg')).toThrow(/regex/i)
    expect(() => loadConfig('checks:\n  scope: yes\n', 'cfg')).toThrow(/boolean/)
    expect(() => parseFailOn('warn')).toThrow(/fail-on/)
    expect(parseFailOn('')).toBe('none')
    expect(parseFailOn('warning')).toBe('warning')
    expect(parseLanguage('')).toBeUndefined()
    expect(parseLanguage('zh-CN')).toBe('zh')
    expect(() => parseLanguage('fr')).toThrow(ActionFailure)
    expect(() => loadConfig('test-evidence:\n  no-evidence: loud\n', 'cfg')).toThrow(/info, warn, or error/)
    expect(() => loadConfig('scope:\n  no-linked-issue: maybe\n', 'cfg')).toThrow(/no-linked-issue/)
  })

  it('parses quiet-scope and info-level test evidence settings', () => {
    const config = loadConfig(
      [
        'scope:',
        '  no-linked-issue: skip',
        '  skip-labels:',
        '    - dependencies',
        '  docs-paths:',
        '    - notes/**',
        'test-evidence:',
        '  no-evidence: warning',
      ].join('\n'),
      'cfg',
    )
    expect(config.scope.noLinkedIssue).toBe('skip')
    expect(config.scope.skipLabels).toEqual(['dependencies'])
    expect(config.scope.docsPaths).toEqual(['notes/**'])
    expect(config.testEvidence.noEvidence).toBe('warn')
    expect(loadConfig('scope:\n  no-linked-issue: off\n', 'cfg').scope.noLinkedIssue).toBe('skip')
    expect(loadConfig('test-evidence:\n  no-evidence: info\n', 'cfg').testEvidence.noEvidence).toBe('info')
  })

  it('configures report-only lockfile provenance', () => {
    expect(defaultConfig().checks.lockfileProvenance).toBe(true)
    expect(defaultConfig().lockfileProvenance.maxLookups).toBe(30)
    const warnings: string[] = []
    const config = loadConfig(
      [
        'checks:',
        '  lockfile-provenance: false',
        'lockfile-provenance:',
        '  max-lookups: 0',
        '  extra: true',
      ].join('\n'),
      'cfg',
      (message) => warnings.push(message),
    )
    expect(config.checks.lockfileProvenance).toBe(false)
    expect(config.lockfileProvenance.maxLookups).toBe(0)
    expect(warnings.some((warning) => warning.includes('lockfile-provenance.extra'))).toBe(true)
    expect(loadConfig('lockfileProvenance:\n  maxLookups: 4\n', 'cfg').lockfileProvenance.maxLookups).toBe(4)
    expect(() => loadConfig('lockfile-provenance: []\n', 'cfg')).toThrow(/mapping/)
    expect(() => loadConfig('lockfile-provenance:\n  max-lookups: -1\n', 'cfg')).toThrow(/>= 0/)
    expect(() => loadConfig('checks:\n  lockfile-provenance: yes\n', 'cfg')).toThrow(/boolean/)
  })

  it('reports an unreadable config file as misconfiguration', () => {
    expect(() => loadConfigFile('/proc/does-not-exist-pr-evidence/nope.yml')).not.toThrow()
  })

  it('surfaces read errors that are not a missing file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-evidence-dir-'))
    expect(() => loadConfigFile(dir)).toThrow(ActionFailure)
    const file = path.join(dir, 'ok.yml')
    writeFileSync(file, 'language: en\n')
    expect(loadConfigFile(file).language).toBe('en')
  })
})

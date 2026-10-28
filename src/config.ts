import { readFileSync } from 'node:fs'
import YAML from 'js-yaml'
import {
  DEFAULT_BREAKING_PATTERNS,
  DEFAULT_BUILD_PATTERNS,
  DEFAULT_CLAIM_PATTERNS,
  DEFAULT_LINT_PATTERNS,
  DEFAULT_TEST_PATHS,
} from './claims/defaults'
import { ActionFailure } from './errors'
import type { ClaimEvidenceKind, ClaimPatternConfig, Config, FailOn, Language, ReviewPacketConfig, SensitiveReason } from './types'

const DEFAULT_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]

const DEFAULT_JOB_PATTERNS = [
  '(?i)\\btests?\\b',
  '(?i)\\bjest\\b',
  '(?i)\\bvitest\\b',
  '(?i)\\bpytest\\b',
  '(?i)\\bpy-?test\\b',
  '(?i)\\bgo[- ]test\\b',
  '(?i)\\bcargo[- ]test\\b',
  '(?i)\\brspec\\b',
  '(?i)\\bphpunit\\b',
  '(?i)\\bctest\\b',
  '(?i)\\bunittest\\b',
  '(?i)\\bmocha\\b',
  '(?i)\\bplaywright\\b',
  '(?i)\\bcypress\\b',
  '(?i)\\be2e\\b',
  '(?i)\\bintegration\\b',
  '(?i)\\bunit\\b',
  '(?i)\\bjunit\\b',
]

const DEFAULT_EXCLUDE_PATTERNS = [
  '(?i)\\bcoverage\\b',
  '(?i)\\blint\\b',
  '(?i)\\bformat\\b',
  '(?i)\\bprettier\\b',
  '(?i)\\beslint\\b',
  '(?i)pr-evidence',
  '(?i)evidence-check',
]

export function defaultHeadings(): ReviewPacketConfig['headings'] {
  return {
    intent: ['Intent', '意图', '目的'],
    risks: ['Risks', 'Risk', '风险'],
    testsRun: ['Tests run', 'Tests', '已运行测试', '测试'],
    selfVerification: [
      'Self-verification',
      'Self verification',
      'What I verified',
      '本人验证',
      '自验',
    ],
  }
}

export function defaultConfig(): Config {
  return {
    language: 'en',
    checks: { scope: true, testEvidence: true, reviewPacket: true, claims: true, lockfileProvenance: true },
    scope: {
      largeDiffLines: 400,
      largeDiffFiles: 20,
      largeFileLines: 300,
      outsideScopeErrorRatio: 0.5,
      outsideScopeErrorMin: 3,
      ignorePaths: [],
      extraSensitivePaths: [],
      disabledSensitiveIds: [],
      closingKeywords: [...DEFAULT_KEYWORDS],
      noLinkedIssue: 'warn',
      skipLabels: [],
      docsPaths: [],
    },
    testEvidence: {
      jobNamePatterns: [...DEFAULT_JOB_PATTERNS],
      excludeNamePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
      parseLogs: true,
      maxLogBytes: 1_500_000,
      maxLogJobs: 20,
      requirePassed: false,
      noEvidence: 'info',
    },
    reviewPacket: {
      headings: defaultHeadings(),
      minBodyChars: 8,
      incomplete: 'warn',
    },
    claims: {
      scanCommits: false,
      contradicted: 'warn',
      patterns: DEFAULT_CLAIM_PATTERNS.map((pattern) => ({ ...pattern, patterns: [...pattern.patterns] })),
      lintNamePatterns: [...DEFAULT_LINT_PATTERNS],
      buildNamePatterns: [...DEFAULT_BUILD_PATTERNS],
      breakingNamePatterns: [...DEFAULT_BREAKING_PATTERNS],
      testPaths: [...DEFAULT_TEST_PATHS],
    },
    lockfileProvenance: {
      maxLookups: 30,
    },
  }
}

export function loadConfig(
  text: string | null,
  fileLabel: string,
  warn: (message: string) => void = () => undefined,
): Config {
  if (text == null || text.trim() === '') return defaultConfig()
  let raw: unknown
  try {
    raw = YAML.load(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionFailure('misconfigured', `Invalid YAML in ${fileLabel}: ${message}`)
  }
  if (raw == null) return defaultConfig()
  if (!isRecord(raw)) {
    throw new ActionFailure('misconfigured', `${fileLabel} must be a YAML mapping.`)
  }
  const config = defaultConfig()
  warnUnknown(raw, ['language', 'checks', 'scope', 'test-evidence', 'testEvidence', 'review-packet', 'reviewPacket', 'claims', 'lockfile-provenance', 'lockfileProvenance'], fileLabel, warn)

  if ('language' in raw) config.language = expectLanguage(raw.language, 'language')
  const checks = pick(raw, 'checks')
  if (checks !== undefined) {
    if (!isRecord(checks)) throw new ActionFailure('misconfigured', 'checks must be a mapping.')
    warnUnknown(checks, ['scope', 'test-evidence', 'testEvidence', 'review-packet', 'reviewPacket', 'claims', 'lockfile-provenance', 'lockfileProvenance'], 'checks', warn)
    if ('scope' in checks) config.checks.scope = expectBoolean(checks.scope, 'checks.scope')
    const testFlag = firstDefined(checks, 'test-evidence', 'testEvidence')
    if (testFlag !== undefined) config.checks.testEvidence = expectBoolean(testFlag, 'checks.test-evidence')
    const packetFlag = firstDefined(checks, 'review-packet', 'reviewPacket')
    if (packetFlag !== undefined) config.checks.reviewPacket = expectBoolean(packetFlag, 'checks.review-packet')
    if ('claims' in checks) config.checks.claims = expectBoolean(checks.claims, 'checks.claims')
    const provenanceFlag = firstDefined(checks, 'lockfile-provenance', 'lockfileProvenance')
    if (provenanceFlag !== undefined) {
      config.checks.lockfileProvenance = expectBoolean(provenanceFlag, 'checks.lockfile-provenance')
    }
  }

  const scope = pick(raw, 'scope')
  if (scope !== undefined) applyScope(config, scope, warn)
  const evidence = firstDefined(raw, 'test-evidence', 'testEvidence')
  if (evidence !== undefined) applyEvidence(config, evidence, warn)
  const packet = firstDefined(raw, 'review-packet', 'reviewPacket')
  if (packet !== undefined) applyPacket(config, packet, warn)
  if ('claims' in raw) applyClaims(config, raw.claims, warn)
  const provenance = firstDefined(raw, 'lockfile-provenance', 'lockfileProvenance')
  if (provenance !== undefined) applyProvenance(config, provenance, warn)

  validatePatterns(config)
  return config
}

export function loadConfigFile(filePath: string, warn?: (message: string) => void): Config {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') return defaultConfig()
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionFailure('misconfigured', `Cannot read config ${filePath}: ${message}`)
  }
  return loadConfig(text, filePath, warn)
}

export function parseFailOn(value: string): FailOn {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'none') return 'none'
  if (normalized === 'warning' || normalized === 'error') return normalized
  throw new ActionFailure(
    'misconfigured',
    `Invalid fail-on value "${value}". Use none, warning, or error.`,
  )
}

export function parseLanguage(value: string): Language | undefined {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'en' || normalized === 'english') return 'en'
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-hans' || normalized === 'chinese') {
    return 'zh'
  }
  throw new ActionFailure('misconfigured', `Invalid comment-language "${value}". Use en or zh.`)
}

export function compilePattern(source: string): RegExp {
  let body = source
  let flags = ''
  if (body.startsWith('(?i)')) {
    flags = 'i'
    body = body.slice(4)
  }
  try {
    return new RegExp(body, flags)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionFailure('misconfigured', `Invalid regex pattern ${JSON.stringify(source)}: ${message}`)
  }
}

export function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(value)
}

function applyScope(config: Config, value: unknown, warn: (message: string) => void): void {
  if (!isRecord(value)) throw new ActionFailure('misconfigured', 'scope must be a mapping.')
  const known = [
    'large-diff-lines',
    'largeDiffLines',
    'large-diff-files',
    'largeDiffFiles',
    'large-file-lines',
    'largeFileLines',
    'outside-scope-error-ratio',
    'outsideScopeErrorRatio',
    'outside-scope-error-min',
    'outsideScopeErrorMin',
    'ignore-paths',
    'ignorePaths',
    'sensitive-paths',
    'sensitivePaths',
    'ignore-sensitive-ids',
    'ignoreSensitiveIds',
    'closing-keywords',
    'closingKeywords',
    'no-linked-issue',
    'noLinkedIssue',
    'skip-labels',
    'skipLabels',
    'docs-paths',
    'docsPaths',
  ]
  warnUnknown(value, known, 'scope', warn)
  const lines = firstDefined(value, 'large-diff-lines', 'largeDiffLines')
  if (lines !== undefined) config.scope.largeDiffLines = expectNonNegative('scope.large-diff-lines', lines)
  const files = firstDefined(value, 'large-diff-files', 'largeDiffFiles')
  if (files !== undefined) config.scope.largeDiffFiles = expectNonNegative('scope.large-diff-files', files)
  const fileLines = firstDefined(value, 'large-file-lines', 'largeFileLines')
  if (fileLines !== undefined) config.scope.largeFileLines = expectNonNegative('scope.large-file-lines', fileLines)
  const ratio = firstDefined(value, 'outside-scope-error-ratio', 'outsideScopeErrorRatio')
  if (ratio !== undefined) {
    const number = expectNumber('scope.outside-scope-error-ratio', ratio)
    if (number < 0 || number > 1) {
      throw new ActionFailure('misconfigured', 'scope.outside-scope-error-ratio must be between 0 and 1.')
    }
    config.scope.outsideScopeErrorRatio = number
  }
  const min = firstDefined(value, 'outside-scope-error-min', 'outsideScopeErrorMin')
  if (min !== undefined) config.scope.outsideScopeErrorMin = expectNonNegative('scope.outside-scope-error-min', min)
  const ignore = firstDefined(value, 'ignore-paths', 'ignorePaths')
  if (ignore !== undefined) config.scope.ignorePaths = expectStringArray('scope.ignore-paths', ignore)
  const sensitive = firstDefined(value, 'sensitive-paths', 'sensitivePaths')
  if (sensitive !== undefined) config.scope.extraSensitivePaths = expectStringArray('scope.sensitive-paths', sensitive)
  const disabled = firstDefined(value, 'ignore-sensitive-ids', 'ignoreSensitiveIds')
  if (disabled !== undefined) config.scope.disabledSensitiveIds = expectStringArray('scope.ignore-sensitive-ids', disabled)
  const keywords = firstDefined(value, 'closing-keywords', 'closingKeywords')
  if (keywords !== undefined) {
    const list = expectStringArray('scope.closing-keywords', keywords).filter((item) => item.trim().length > 0)
    if (list.length === 0) {
      throw new ActionFailure('misconfigured', 'scope.closing-keywords must list at least one keyword.')
    }
    config.scope.closingKeywords = list
  }
  const noLinked = firstDefined(value, 'no-linked-issue', 'noLinkedIssue')
  if (noLinked !== undefined) config.scope.noLinkedIssue = expectNoLinkedIssue(noLinked)
  const skipLabels = firstDefined(value, 'skip-labels', 'skipLabels')
  if (skipLabels !== undefined) config.scope.skipLabels = expectStringArray('scope.skip-labels', skipLabels)
  const docsPaths = firstDefined(value, 'docs-paths', 'docsPaths')
  if (docsPaths !== undefined) config.scope.docsPaths = expectStringArray('scope.docs-paths', docsPaths)
}

function applyEvidence(config: Config, value: unknown, warn: (message: string) => void): void {
  if (!isRecord(value)) throw new ActionFailure('misconfigured', 'test-evidence must be a mapping.')
  const known = [
    'job-name-patterns',
    'jobNamePatterns',
    'exclude-name-patterns',
    'excludeNamePatterns',
    'parse-logs',
    'parseLogs',
    'max-log-bytes',
    'maxLogBytes',
    'max-log-jobs',
    'maxLogJobs',
    'require-passed',
    'requirePassed',
    'no-evidence',
    'noEvidence',
  ]
  warnUnknown(value, known, 'test-evidence', warn)
  const patterns = firstDefined(value, 'job-name-patterns', 'jobNamePatterns')
  if (patterns !== undefined) {
    const list = expectStringArray('test-evidence.job-name-patterns', patterns)
    if (list.length === 0) {
      throw new ActionFailure('misconfigured', 'test-evidence.job-name-patterns must not be empty.')
    }
    config.testEvidence.jobNamePatterns = list
  }
  const exclude = firstDefined(value, 'exclude-name-patterns', 'excludeNamePatterns')
  if (exclude !== undefined) {
    config.testEvidence.excludeNamePatterns = expectStringArray('test-evidence.exclude-name-patterns', exclude)
  }
  const parseLogs = firstDefined(value, 'parse-logs', 'parseLogs')
  if (parseLogs !== undefined) config.testEvidence.parseLogs = expectBoolean(parseLogs, 'test-evidence.parse-logs')
  const maxBytes = firstDefined(value, 'max-log-bytes', 'maxLogBytes')
  if (maxBytes !== undefined) config.testEvidence.maxLogBytes = expectNonNegative('test-evidence.max-log-bytes', maxBytes)
  const maxJobs = firstDefined(value, 'max-log-jobs', 'maxLogJobs')
  if (maxJobs !== undefined) config.testEvidence.maxLogJobs = expectNonNegative('test-evidence.max-log-jobs', maxJobs)
  const requirePassed = firstDefined(value, 'require-passed', 'requirePassed')
  if (requirePassed !== undefined) {
    config.testEvidence.requirePassed = expectBoolean(requirePassed, 'test-evidence.require-passed')
  }
  const noEvidence = firstDefined(value, 'no-evidence', 'noEvidence')
  if (noEvidence !== undefined) config.testEvidence.noEvidence = expectNotice(noEvidence, 'test-evidence.no-evidence')
}

function applyPacket(config: Config, value: unknown, warn: (message: string) => void): void {
  if (!isRecord(value)) throw new ActionFailure('misconfigured', 'review-packet must be a mapping.')
  const known = ['headings', 'min-body-chars', 'minBodyChars', 'incomplete']
  warnUnknown(value, known, 'review-packet', warn)
  const minBody = firstDefined(value, 'min-body-chars', 'minBodyChars')
  if (minBody !== undefined) config.reviewPacket.minBodyChars = expectNonNegative('review-packet.min-body-chars', minBody)
  if ('incomplete' in value) config.reviewPacket.incomplete = expectSeverity(value.incomplete, 'review-packet.incomplete')
  if ('headings' in value) {
    if (!isRecord(value.headings)) throw new ActionFailure('misconfigured', 'review-packet.headings must be a mapping.')
    const headings = value.headings
    warnUnknown(
      headings,
      ['intent', 'risks', 'tests-run', 'testsRun', 'self-verification', 'selfVerification'],
      'review-packet.headings',
      warn,
    )
    if ('intent' in headings) config.reviewPacket.headings.intent = expectHeadingList('intent', headings.intent)
    if ('risks' in headings) config.reviewPacket.headings.risks = expectHeadingList('risks', headings.risks)
    const tests = firstDefined(headings, 'tests-run', 'testsRun')
    if (tests !== undefined) config.reviewPacket.headings.testsRun = expectHeadingList('tests-run', tests)
    const self = firstDefined(headings, 'self-verification', 'selfVerification')
    if (self !== undefined) config.reviewPacket.headings.selfVerification = expectHeadingList('self-verification', self)
  }
}

function applyClaims(config: Config, value: unknown, warn: (message: string) => void): void {
  if (!isRecord(value)) throw new ActionFailure('misconfigured', 'claims must be a mapping.')
  const known = [
    'scan-commits',
    'scanCommits',
    'contradicted',
    'patterns',
    'lint-name-patterns',
    'lintNamePatterns',
    'build-name-patterns',
    'buildNamePatterns',
    'breaking-name-patterns',
    'breakingNamePatterns',
    'test-paths',
    'testPaths',
  ]
  warnUnknown(value, known, 'claims', warn)
  const scan = firstDefined(value, 'scan-commits', 'scanCommits')
  if (scan !== undefined) config.claims.scanCommits = expectBoolean(scan, 'claims.scan-commits')
  if ('contradicted' in value) config.claims.contradicted = expectSeverity(value.contradicted, 'claims.contradicted')
  if ('patterns' in value) config.claims.patterns = expectClaimPatterns(value.patterns)
  const lint = firstDefined(value, 'lint-name-patterns', 'lintNamePatterns')
  if (lint !== undefined) config.claims.lintNamePatterns = expectPatternList('claims.lint-name-patterns', lint)
  const build = firstDefined(value, 'build-name-patterns', 'buildNamePatterns')
  if (build !== undefined) config.claims.buildNamePatterns = expectPatternList('claims.build-name-patterns', build)
  const breaking = firstDefined(value, 'breaking-name-patterns', 'breakingNamePatterns')
  if (breaking !== undefined) config.claims.breakingNamePatterns = expectPatternList('claims.breaking-name-patterns', breaking)
  const paths = firstDefined(value, 'test-paths', 'testPaths')
  if (paths !== undefined) config.claims.testPaths = expectPatternList('claims.test-paths', paths)
}

function applyProvenance(config: Config, value: unknown, warn: (message: string) => void): void {
  if (!isRecord(value)) throw new ActionFailure('misconfigured', 'lockfile-provenance must be a mapping.')
  warnUnknown(value, ['max-lookups', 'maxLookups'], 'lockfile-provenance', warn)
  const maxLookups = firstDefined(value, 'max-lookups', 'maxLookups')
  if (maxLookups !== undefined) {
    config.lockfileProvenance.maxLookups = expectNonNegative('lockfile-provenance.max-lookups', maxLookups)
  }
}

const CLAIM_EVIDENCE: readonly ClaimEvidenceKind[] = ['tests', 'lint', 'build', 'breaking', 'test_files', 'linked_issue']

function expectClaimPatterns(value: unknown): ClaimPatternConfig[] {
  if (!Array.isArray(value)) throw new ActionFailure('misconfigured', 'claims.patterns must be a list.')
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ActionFailure('misconfigured', `claims.patterns[${index}] must be a mapping.`)
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) throw new ActionFailure('misconfigured', `claims.patterns[${index}].id must be a non-empty string.`)
    if (ids.has(id)) throw new ActionFailure('misconfigured', `claims.patterns id "${id}" is duplicated.`)
    ids.add(id)
    const evidence = item.evidence
    if (typeof evidence !== 'string' || !CLAIM_EVIDENCE.includes(evidence as ClaimEvidenceKind)) {
      throw new ActionFailure(
        'misconfigured',
        `claims.patterns[${index}].evidence must be tests, lint, build, breaking, test_files, or linked_issue.`,
      )
    }
    const patterns = expectPatternList(`claims.patterns[${index}].patterns`, item.patterns)
    return { id, evidence: evidence as ClaimEvidenceKind, patterns }
  })
}

function expectPatternList(label: string, value: unknown): string[] {
  const list = expectStringArray(label, value).map((item) => item.trim()).filter((item) => item.length > 0)
  if (list.length === 0) throw new ActionFailure('misconfigured', `${label} must list at least one pattern.`)
  return list
}

function validatePatterns(config: Config): void {
  for (const pattern of [
    ...config.testEvidence.jobNamePatterns,
    ...config.testEvidence.excludeNamePatterns,
    ...config.claims.lintNamePatterns,
    ...config.claims.buildNamePatterns,
    ...config.claims.breakingNamePatterns,
  ]) {
    compilePattern(pattern)
  }
  for (const claim of config.claims.patterns) {
    for (const pattern of claim.patterns) compilePattern(pattern)
  }
}

function expectHeadingList(name: string, value: unknown): string[] {
  const list = expectStringArray(`review-packet.headings.${name}`, value).filter((item) => item.trim().length > 0)
  if (list.length === 0) {
    throw new ActionFailure('misconfigured', `review-packet.headings.${name} must list at least one heading.`)
  }
  return list
}

function expectSeverity(value: unknown, label: string): 'warn' | 'error' {
  if (value === 'warn' || value === 'warning') return 'warn'
  if (value === 'error') return 'error'
  throw new ActionFailure('misconfigured', `${label} must be warn or error.`)
}

function expectNotice(value: unknown, label: string): 'info' | 'warn' | 'error' {
  if (value === 'info') return 'info'
  if (value === 'warn' || value === 'warning') return 'warn'
  if (value === 'error') return 'error'
  throw new ActionFailure('misconfigured', `${label} must be info, warn, or error.`)
}

function expectNoLinkedIssue(value: unknown): 'warn' | 'info' | 'skip' {
  if (value === 'warn' || value === 'warning') return 'warn'
  if (value === 'info') return 'info'
  if (value === 'skip' || value === 'off' || value === 'none') return 'skip'
  throw new ActionFailure('misconfigured', 'scope.no-linked-issue must be warn, info, or skip.')
}

function expectLanguage(value: unknown, label: string): Language {
  if (typeof value !== 'string') throw new ActionFailure('misconfigured', `${label} must be en or zh.`)
  const parsed = parseLanguage(value)
  if (!parsed) throw new ActionFailure('misconfigured', `${label} must be en or zh.`)
  return parsed
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ActionFailure('misconfigured', `${label} must be a boolean.`)
  return value
}

function expectNumber(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ActionFailure('misconfigured', `${label} must be a number.`)
  }
  return value
}

function expectNonNegative(label: string, value: unknown): number {
  const number = expectNumber(label, value)
  if (number < 0) throw new ActionFailure('misconfigured', `${label} must be >= 0.`)
  return number
}

function expectStringArray(label: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ActionFailure('misconfigured', `${label} must be a list of strings.`)
  }
  return value
}

function warnUnknown(
  value: Record<string, unknown>,
  known: string[],
  label: string,
  warn: (message: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) warn(`Unknown config key "${label}.${key}" ignored.`)
  }
}

function pick(value: Record<string, unknown>, key: string): unknown {
  return key in value ? value[key] : undefined
}

function firstDefined(value: Record<string, unknown>, a: string, b: string): unknown {
  if (a in value) return value[a]
  if (b in value) return value[b]
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function sensitiveReasonLabel(reason: SensitiveReason, language: Language): string {
  const en: Record<SensitiveReason, string> = {
    lockfile: 'dependency lockfile',
    github_workflow: 'GitHub Actions workflow',
    github_settings: 'GitHub repository settings',
    env_file: 'environment file',
    credential: 'key or credential material',
    container: 'container build file',
    manifest: 'package manifest (dependencies or scripts)',
    ci_config: 'CI configuration',
    tooling_config: 'build or lint configuration',
    custom: 'maintainer-configured sensitive path',
  }
  const zh: Record<SensitiveReason, string> = {
    lockfile: '依赖锁文件',
    github_workflow: 'GitHub Actions 工作流',
    github_settings: 'GitHub 仓库设置',
    env_file: '环境变量文件',
    credential: '密钥或凭证文件',
    container: '容器构建文件',
    manifest: '包清单（依赖或脚本）',
    ci_config: 'CI 配置',
    tooling_config: '构建或 lint 配置',
    custom: '维护者配置的敏感路径',
  }
  return language === 'zh' ? zh[reason] : en[reason]
}

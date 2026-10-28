export type Language = 'en' | 'zh'
export type FailOn = 'none' | 'warning' | 'error'
export type CheckStatus = 'pass' | 'warn' | 'error' | 'skipped'
export type Severity = 'warn' | 'error'
export type NoticeLevel = 'info' | 'warn' | 'error'
export type NoLinkedIssueMode = 'warn' | 'info' | 'skip'
export type QuietNoIssue = 'bot' | 'docs' | 'ignored' | 'docs_or_ignored' | 'label' | 'config'

export type SensitiveReason =
  | 'lockfile'
  | 'github_workflow'
  | 'github_settings'
  | 'env_file'
  | 'credential'
  | 'container'
  | 'manifest'
  | 'ci_config'
  | 'tooling_config'
  | 'custom'

export interface SensitiveRule {
  id: string
  reason: SensitiveReason
  patterns: string[]
}

export interface ScopeConfig {
  largeDiffLines: number
  largeDiffFiles: number
  largeFileLines: number
  outsideScopeErrorRatio: number
  outsideScopeErrorMin: number
  ignorePaths: string[]
  extraSensitivePaths: string[]
  disabledSensitiveIds: string[]
  closingKeywords: string[]
  noLinkedIssue: NoLinkedIssueMode
  skipLabels: string[]
  docsPaths: string[]
}

export interface TestEvidenceConfig {
  jobNamePatterns: string[]
  excludeNamePatterns: string[]
  parseLogs: boolean
  maxLogBytes: number
  maxLogJobs: number
  requirePassed: boolean
  noEvidence: NoticeLevel
}

export interface ReviewPacketConfig {
  headings: {
    intent: string[]
    risks: string[]
    testsRun: string[]
    selfVerification: string[]
  }
  minBodyChars: number
  incomplete: Severity
}

export type ClaimEvidenceKind = 'tests' | 'lint' | 'build' | 'breaking' | 'test_files' | 'linked_issue'

export type ClaimVerdict = 'verified' | 'contradicted' | 'unverified'

export type ClaimSource = 'title' | 'description' | 'commit'

export interface ClaimPatternConfig {
  id: string
  evidence: ClaimEvidenceKind
  patterns: string[]
}

export interface ClaimsConfig {
  scanCommits: boolean
  contradicted: Severity
  patterns: ClaimPatternConfig[]
  lintNamePatterns: string[]
  buildNamePatterns: string[]
  breakingNamePatterns: string[]
  testPaths: string[]
}

export interface LockfileProvenanceConfig {
  /** Public-registry lookups for newly added packages. Further packages stay unknown. */
  maxLookups: number
}

export interface Config {
  language: Language
  checks: {
    scope: boolean
    testEvidence: boolean
    reviewPacket: boolean
    claims: boolean
    lockfileProvenance: boolean
  }
  scope: ScopeConfig
  testEvidence: TestEvidenceConfig
  reviewPacket: ReviewPacketConfig
  claims: ClaimsConfig
  lockfileProvenance: LockfileProvenanceConfig
}

export interface ChangedFile {
  filename: string
  previousFilename?: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export interface LinkedIssue {
  repo: string
  number: number
  title: string
  body: string
  url: string
  source: 'api' | 'closing_keyword' | 'both'
  unreadable?: string
}

export interface KeywordRef {
  repo: string
  number: number
  raw: string
}

export type FileVerdict = 'in_scope' | 'outside_scope' | 'not_compared' | 'ignored'

export interface SensitiveHit {
  ruleId: string
  reason: SensitiveReason
  pattern: string
  mentioned: boolean
  mention?: string
}

export type FileExplanation =
  | {
      code: 'scope.in_scope.path_mention'
      issueNumber: number
      repo: string
      quoted: string
      viaPrevious?: string
    }
  | {
      code: 'scope.in_scope.path_tokens'
      issueNumber: number
      repo: string
      tokens: string[]
      snippet: string
      viaPrevious?: string
    }
  | {
      code: 'scope.in_scope.diff_keywords'
      issueNumber: number
      repo: string
      tokens: string[]
    }
  | {
      code: 'scope.outside'
      issueRefs: string[]
      fileTokens: string[]
      issueKeywords: string[]
    }
  | { code: 'scope.no_linked_issue' }
  | { code: 'scope.ignored'; pattern: string }
  | {
      code: 'scope.sensitive'
      reason: SensitiveReason
      pattern: string
      ruleId: string
      mentioned: boolean
      mention?: string
    }
  | { code: 'scope.renamed_from'; previous: string }

export interface ScopeFileReport {
  filename: string
  previousFilename?: string
  changeStatus: string
  additions: number
  deletions: number
  verdict: FileVerdict
  sensitive: SensitiveHit[]
  explanations: FileExplanation[]
}

export type ScopeSignal =
  | { id: 'scope.no_files'; level: 'info' }
  | {
      id: 'scope.no_linked_issue'
      level: 'info' | 'warn'
      quiet?: QuietNoIssue
      quietDetail?: string
    }
  | { id: 'scope.issue_unreadable'; level: 'warn'; issues: string[] }
  | {
      id: 'scope.large_diff'
      level: 'warn'
      additions: number
      deletions: number
      files: number
      lineThreshold: number
      fileThreshold: number
      overLines: boolean
      overFiles: boolean
    }
  | {
      id: 'scope.large_unrelated_file'
      level: 'warn'
      filename: string
      lines: number
      threshold: number
    }
  | {
      id: 'scope.outside_cluster'
      level: 'warn'
      directory: string
      files: string[]
      issueKeywords: string[]
      issueRefs: string[]
    }
  | {
      id: 'scope.outside_ratio'
      level: 'error'
      outside: number
      judged: number
      ratio: number
      minFiles: number
      threshold: number
    }
  | {
      id: 'scope.sensitive'
      level: 'warn'
      files: { filename: string; reason: SensitiveReason; pattern: string }[]
    }
  | { id: 'scope.api_error'; level: 'warn'; message: string }
  | { id: 'scope.sha_note'; level: 'info'; message: string }

export interface ScopeReport {
  enabled: boolean
  status: CheckStatus
  issues: LinkedIssue[]
  files: ScopeFileReport[]
  signals: ScopeSignal[]
  additions: number
  deletions: number
  fileCount: number
}

export interface WorkflowJobInfo {
  id: number
  name: string
  workflowName: string
  status: string
  conclusion: string | null
  htmlUrl?: string
  runId: number
  /** Workflow run event, such as `push` or `pull_request`. */
  event?: string
  /** Job completion time. Used to pick one run when events repeat. */
  completedAt?: string
}

export interface CheckRunInfo {
  name: string
  status: string
  conclusion: string | null
  htmlUrl?: string
  summary?: string
}

export interface ParsedCounts {
  framework: 'jest' | 'vitest' | 'pytest' | 'go' | 'cargo' | 'junit'
  passed: number
  failed: number
  skipped: number
  total: number
  detail: string
}

export type EvidenceNote =
  | 'in_progress'
  | 'logs_unreadable'
  | 'no_summary'
  | 'zero_tests'
  | 'not_downloaded'

export interface EvidenceItem {
  source: 'workflow_job' | 'check_run'
  name: string
  workflowName?: string
  status: string
  conclusion: string | null
  url?: string
  text: string | null
  logError?: string
  event?: string
  completedAt?: string
  runId?: number
}

export interface EvidenceJobReport {
  source: 'workflow_job' | 'check_run'
  name: string
  workflowName?: string
  status: string
  conclusion: string | null
  url?: string
  counts: ParsedCounts | null
  note?: EvidenceNote
  logError?: string
  event?: string
  completedAt?: string
  runId?: number
}

export type EvidenceSignal =
  | { id: 'test_evidence.none'; level: NoticeLevel }
  | { id: 'test_evidence.in_progress'; level: 'warn'; count: number }
  | { id: 'test_evidence.failed'; level: Severity; jobs: string[] }
  | { id: 'test_evidence.skipped_only'; level: 'warn' }
  | { id: 'test_evidence.passed'; level: 'info'; jobs: number }
  | { id: 'test_evidence.logs_unreadable'; level: 'info'; jobs: string[] }
  | { id: 'test_evidence.no_summary'; level: 'info'; jobs: string[] }
  | { id: 'test_evidence.zero_tests'; level: 'warn'; jobs: string[] }
  | { id: 'test_evidence.api_error'; level: 'warn'; message: string }
  | { id: 'test_evidence.sha_mismatch'; level: 'warn'; eventSha: string; apiSha: string }
  | { id: 'test_evidence.not_rerun'; level: 'info' }

export interface EvidenceReport {
  enabled: boolean
  status: CheckStatus
  sha: string
  jobs: EvidenceJobReport[]
  signals: EvidenceSignal[]
  consideredJobs: number
  consideredChecks: number
}

export type PacketSectionId = 'intent' | 'risks' | 'testsRun' | 'selfVerification'

export interface PacketSection {
  id: PacketSectionId
  status: 'present' | 'missing' | 'empty' | 'placeholder'
  heading?: string
  chars: number
}

export interface PacketReport {
  enabled: boolean
  status: CheckStatus
  sections: PacketSection[]
}

export type CheckClaimKind = 'lint' | 'build' | 'breaking'

export type ClaimReason =
  | { code: 'tests.verified'; jobs: string[]; passed: number | null; failed: number | null; skipped: number | null }
  | { code: 'tests.contradicted'; jobs: string[]; passed: number | null; failed: number | null }
  | { code: 'tests.unverified_none' }
  | { code: 'tests.unverified_running'; jobs: string[] }
  | { code: 'tests.unverified_skipped' }
  | { code: 'tests.unverified_zero'; jobs: string[] }
  | { code: 'tests.unverified_api' }
  | { code: 'check.verified'; kind: CheckClaimKind; jobs: string[] }
  | { code: 'check.contradicted'; kind: CheckClaimKind; jobs: string[] }
  | { code: 'check.unverified_none'; kind: CheckClaimKind }
  | { code: 'check.unverified_running'; kind: CheckClaimKind; jobs: string[] }
  | { code: 'check.unverified_api'; kind: CheckClaimKind }
  | { code: 'files.verified'; files: string[] }
  | { code: 'files.contradicted'; changed: number }
  | { code: 'files.unverified' }
  | { code: 'issue.verified'; number: number; title: string; linked: boolean }
  | { code: 'issue.verified_any'; numbers: number[] }
  | { code: 'issue.contradicted_missing'; number: number }
  | { code: 'issue.unverified_none' }
  | { code: 'issue.unverified_unreadable'; number?: number }

export interface ClaimResult {
  id: string
  evidence: ClaimEvidenceKind
  text: string
  source: ClaimSource
  commitSha?: string
  issueNumber?: number
  verdict: ClaimVerdict
  reason: ClaimReason
}

export interface ClaimReport {
  enabled: boolean
  status: CheckStatus
  scannedCommits: boolean
  results: ClaimResult[]
  omitted: number
}

export type Ecosystem = 'npm' | 'pypi' | 'crates' | 'go'

export type ProvenanceDetail =
  | { code: 'npm_provenance' }
  | { code: 'npm_attestation' }
  | { code: 'pypi_provenance' }
  | { code: 'crates_trustpub'; repository: string }
  | { code: 'go_origin'; url: string }
  | { code: 'no_attestation' }
  | { code: 'not_found' }
  | { code: 'lookup_failed' }
  | { code: 'not_queried' }
  | { code: 'not_registry' }

export interface ProvenancePackageReport {
  lockfile: string
  ecosystem: Ecosystem
  name: string
  version: string
  state: 'present' | 'unknown'
  detail: ProvenanceDetail
}

export interface ProvenanceLockfile {
  path: string
  added: number
  error?: string
}

export type ProvenanceSignal =
  | { id: 'lockfile_provenance.none' }
  | { id: 'lockfile_provenance.no_additions'; lockfiles: string[] }
  | { id: 'lockfile_provenance.unreadable'; lockfile: string; message: string }
  | { id: 'lockfile_provenance.lookup_failed'; count: number }
  | { id: 'lockfile_provenance.capped'; cap: number }
  | { id: 'lockfile_provenance.files_unreadable'; message: string }

export interface ProvenanceReport {
  enabled: boolean
  /** pass when the check ran. skipped when disabled. Never warn or error: fail-on does not read it. */
  status: CheckStatus
  packages: ProvenancePackageReport[]
  lockfiles: ProvenanceLockfile[]
  omitted: number
  signals: ProvenanceSignal[]
}

export interface Report {
  language: Language
  failOn: FailOn
  headSha: string
  generatedAt: string
  scope: ScopeReport
  evidence: EvidenceReport
  packet: PacketReport
  claims: ClaimReport
  provenance: ProvenanceReport
}

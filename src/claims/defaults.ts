import type { ClaimPatternConfig } from '../types'

export const DEFAULT_CLAIM_PATTERNS: readonly ClaimPatternConfig[] = [
  {
    id: 'tests_pass',
    evidence: 'tests',
    patterns: [
      '(?i)(?<![A-Za-z])all tests pass(?![A-Za-z])',
      '(?i)(?<![A-Za-z])tests passing(?![A-Za-z])',
      '(?i)(?<![A-Za-z])tests pass(?![A-Za-z])',
      '测试全部通过',
    ],
  },
  {
    id: 'lint_clean',
    evidence: 'lint',
    patterns: [
      '(?i)(?<![A-Za-z])lint clean(?![A-Za-z])',
      '(?i)已通过\\s*lint',
    ],
  },
  {
    id: 'build_succeeds',
    evidence: 'build',
    patterns: [
      '(?i)(?<![A-Za-z])build succeeds(?![A-Za-z])',
    ],
  },
  {
    id: 'no_breaking_changes',
    evidence: 'breaking',
    patterns: [
      '(?i)(?<![A-Za-z])no breaking changes(?![A-Za-z])',
      '(?i)(?<![A-Za-z])no breaking change(?![A-Za-z])',
      '无破坏性变更',
      '没有破坏性变更',
    ],
  },
  {
    id: 'added_tests',
    evidence: 'test_files',
    patterns: [
      '(?i)(?<![A-Za-z])added tests(?![A-Za-z])',
      '新增了测试',
      '添加了测试',
      '新增测试',
    ],
  },
  {
    id: 'fixed_issue',
    evidence: 'linked_issue',
    patterns: [
      '(?i)(?<![A-Za-z])fix(?:ed|es)?\\s+#(\\d+)',
      '已修复\\s*#(\\d+)',
      '已修复(?!\\s*#\\d)',
    ],
  },
]

export const DEFAULT_LINT_PATTERNS = [
  '(?i)\\blint\\b',
  '(?i)\\beslint\\b',
  '(?i)\\bprettier\\b',
  '(?i)\\bformat\\b',
  '(?i)\\bruff\\b',
  '(?i)\\bclippy\\b',
]

export const DEFAULT_BUILD_PATTERNS = [
  '(?i)\\bbuild\\b',
  '(?i)\\bcompile\\b',
  '(?i)\\bpackage\\b',
]

export const DEFAULT_BREAKING_PATTERNS = [
  '(?i)breaking',
  '(?i)api-compat',
  '(?i)\\bsemver\\b',
]

export const DEFAULT_TEST_PATHS = [
  '**/*.{test,spec}.{js,cjs,mjs,ts,tsx,jsx}',
  '**/__tests__/**',
  '**/tests/**',
  '**/*_test.go',
  '**/test_*.py',
  '**/*_test.py',
]

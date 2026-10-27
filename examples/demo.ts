import { defaultConfig } from '../src/config'
import { buildEvidence } from '../src/evidence/select'
import { analyzePacket } from '../src/packet/analyze'
import { renderComment } from '../src/render'
import { analyzeScope } from '../src/scope/analyze'
import type { Report } from '../src/types'

const config = defaultConfig()
const prRepo = 'acme/app'

const scope = analyzeScope({
  prRepo,
  config: config.scope,
  issues: [{
    repo: prRepo,
    number: 12,
    title: 'Session timeout on login',
    body: 'The session token expires during login. The file to change is `src/auth/login.ts`.',
    url: 'https://github.com/acme/app/issues/12',
    source: 'both',
  }],
  files: [
    { filename: 'src/auth/login.ts', status: 'modified', additions: 40, deletions: 2 },
    { filename: 'src/billing/invoice.ts', status: 'modified', additions: 220, deletions: 80 },
    { filename: 'src/billing/tax.ts', status: 'added', additions: 30, deletions: 0 },
    { filename: 'src/billing/refund.ts', status: 'added', additions: 24, deletions: 0 },
    { filename: '.github/workflows/ci.yml', status: 'modified', additions: 12, deletions: 0 },
    {
      filename: 'package-lock.json',
      status: 'modified',
      additions: 800,
      deletions: 10,
      patch: '+\n+"sessionTimeout": "1"\n',
    },
  ],
})

const evidence = buildEvidence({
  sha: 'abc1234abc1234abc1234abc1234abc1234abc12',
  config: config.testEvidence,
  consideredJobs: 3,
  consideredChecks: 1,
  items: [{
    source: 'workflow_job',
    name: 'unit',
    workflowName: 'CI',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/acme/app/actions/runs/1',
    text: 'Tests:       42 passed, 42 total',
  }],
})

const packet = analyzePacket(
  [
    '## Intent',
    'Refresh the session token before login gives up.',
    '## Risks',
    'TODO',
    '## 已运行测试',
    '',
  ].join('\n'),
  config.reviewPacket,
)

const report: Report = {
  language: 'en',
  failOn: 'none',
  headSha: 'abc1234abc1234abc1234abc1234abc1234abc12',
  generatedAt: '2026-10-27T00:00:00.000Z',
  scope,
  evidence,
  packet,
}

process.stdout.write(`${renderComment(report, prRepo)}\n`)

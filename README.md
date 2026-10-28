# pr-evidence-check

A free GitHub Action for maintainers reviewing pull requests, including ones an agent wrote. It posts **one comment** and updates that same comment in place.

It does five deterministic checks. No LLM. No model API. GitHub API calls read the pull request, the linked issues, and CI that already ran. When a lockfile changed, provenance lookups send only the package name and version to a public registry. Claim verification and lockfile provenance are not in the `v1` or `v1.0.0` tags.

**Zero config.** You do not need `.github/pr-evidence.yml`. Built-in defaults are on until you override them.

The job stays green unless you opt in with `fail-on`, or the action itself is misconfigured (bad YAML, empty token, unsupported event). It never merges, never dismisses reviews, and never creates a separate required check beyond the workflow job you already added.

![Sticky comment on an out-of-scope pull request](docs/scope-comment.png)

The comment above is the sticky comment on [pull request #9](https://github.com/tupils1/pr-evidence-check/pull/9#issuecomment-6445101391). Scope is an error. Test evidence and the review packet passed. Later runs update that same comment. That screenshot is from the tagged v1 comment, before claim verification.

## Unreleased / v1.1

Claim verification and lockfile provenance are on this branch and are **not** in the `v1` or `v1.0.0` tags. Those tags still run scope, test evidence, and the review packet. This repository has no v1.1 release.

The action reads the pull request title and description. If `claims.scan-commits` is true, it also reads commit messages. For each configured phrase it uses data this action already collects for the head SHA: test jobs and parsed counts, other check runs and jobs, the diff, and linked issues. Each claim is **verified**, **contradicted**, or **unverified**, in a new section of the same sticky comment. Matching is deterministic. No LLM.

| Phrase | Evidence | Verified | Contradicted | Unverified |
| --- | --- | --- | --- | --- |
| `all tests pass`, `tests passing`, `tests pass`, `测试全部通过` | test-like jobs and parsed counts | a matched job succeeded, and any parsed failure count is zero | a matched job failed, timed out, or was cancelled, or parsed failures are greater than zero | no completed test job, a job is still running, or the parsed total is zero |
| `lint clean`, `已通过 lint` | jobs or checks whose names match the lint patterns | a lint check succeeded | a lint check failed | no successful lint check |
| `build succeeds` | build name patterns | a build check succeeded | a build check failed | no successful build check |
| `no breaking changes`, `no breaking change`, `无破坏性变更`, `没有破坏性变更` | breaking-change name patterns | such a check succeeded | such a check failed | no such check ran |
| `added tests`, `新增了测试`, `添加了测试`, `新增测试` | diff paths | a test file was added or gained lines | the diff is readable and no test file was added or expanded | the diff could not be read |
| `fixed #12`, `fixes #12`, `fix #12`, `已修复 #12` | linked issues | that issue exists and this pull request references it | that issue number does not exist | the issue could not be read |
| `已修复` | linked issues | at least one linked issue was readable | — | no readable linked issue |

`claims.contradicted` defaults to `warn`. The job stays green unless `fail-on` is `warning` or `error`. `claims.scan-commits` defaults to false. A negated phrase (`not all tests pass`, `没有测试全部通过`) is ignored. Fenced code blocks and HTML comments are ignored. A `patterns` list in `.github/pr-evidence.yml` replaces the built-in phrases. Patterns are JavaScript regular expressions; a leading `(?i)` is case-insensitive. A `linked_issue` pattern may capture the issue number in the first group.

This does not prove the diff is correct. `fixed #12` means the issue exists and is referenced, not that the change solves it. `no breaking changes` stays unverified unless a check with a breaking-change name ran. `all tests pass` trusts the existing CI conclusion and parsed counts. It does not re-run tests. When the same workflow and job name ran for this head SHA on both `push` and `pull_request`, the parsed counts use one run: the latest completed run, or the `pull_request` run when the completion times tie. A failure in either run still contradicts the claim. Other jobs are still added together.

[AgentClaimGuard](https://github.com/konoeph/AgentClaimGuard) is a Python policy gate for structured claims and caller-supplied evidence. [agent-receipts](https://github.com/inchwormz/agent-receipts) is a local hash-chained runtime that promotes a claim only when repo checks bind to exact bytes. [obsigna](https://github.com/agent-receipts/obsigna) verifies signed receipt chains. This action does not sign anything and does not ask the agent to cooperate. It compares phrases already written on the pull request with CI, the diff, and linked issues, and it warns instead of blocking.

### 中文

声明核验和锁文件来源证明在这个分支上，**不在** `v1` 和 `v1.0.0` 标签里。这两个标签仍只跑范围、测试证据和审查材料包。仓库没有 v1.1 发行版。

action 读取 PR 标题和描述。`claims.scan-commits` 为 true 时也读提交说明。每条配置好的短语，都只用这个 head SHA 上 action 已经收集的数据：像测试的 job 和解析出的数量、其他 check run 和 job、diff、关联 issue。每条声明标成 **已证实**、**相矛盾** 或 **未证实**，写进同一条粘性评论的新小节。规则是确定的，不调用 LLM。

| 短语 | 证据 | 已证实 | 相矛盾 | 未证实 |
| --- | --- | --- | --- | --- |
| `all tests pass`、`tests passing`、`tests pass`、`测试全部通过` | 像测试的 job 和解析数量 | 命中的 job 成功，且解析出的失败数为 0 | job 失败、超时或取消，或解析出的失败数大于 0 | 没有已结束的测试 job、job 还在跑，或解析总数为 0 |
| `lint clean`、`已通过 lint` | 名称命中 lint 模式的 job 或 check | lint 检查成功 | lint 检查失败 | 没有成功的 lint 检查 |
| `build succeeds` | 构建名称模式 | 构建检查成功 | 构建检查失败 | 没有成功的构建检查 |
| `no breaking changes`、`no breaking change`、`无破坏性变更`、`没有破坏性变更` | 破坏性变更名称模式 | 这类检查成功 | 这类检查失败 | 没有这类检查 |
| `added tests`、`新增了测试`、`添加了测试`、`新增测试` | diff 路径 | 有测试文件被新增或增加了行 | diff 能读到，但没有新增或增加行数的测试文件 | diff 读不到 |
| `fixed #12`、`fixes #12`、`fix #12`、`已修复 #12` | 关联 issue | 该 issue 存在，且这个 PR 提到了它 | 该编号不存在 | issue 读不到 |
| `已修复` | 关联 issue | 至少有一个关联 issue 能读到 | — | 没有能读到的关联 issue |

`claims.contradicted` 默认是 `warn`。除非 `fail-on` 是 `warning` 或 `error`，job 仍然成功。`claims.scan-commits` 默认 false。被否定的短语（`not all tests pass`、`没有测试全部通过`）会忽略。围栏代码块和 HTML 注释会忽略。`.github/pr-evidence.yml` 里的 `patterns` 列表会替换内置短语。模式是 JavaScript 正则，开头的 `(?i)` 表示不区分大小写。`linked_issue` 的模式可以用第一个捕获组取出 issue 编号。

这不证明 diff 是对的。`fixed #12` 只说明 issue 存在并且被引用，不说明改动修好了它。没有名称像破坏性变更的检查时，`no breaking changes` 保持未证实。`all tests pass` 信任已有 CI 结论和解析数量，不会重新跑测试。同一个 workflow、同一个 job 名在这个 head SHA 上既有 `push` 又有 `pull_request` 时，解析数量只计一次：用最晚结束的那次；结束时间相同则用 `pull_request`。其中任何一次失败，声明仍然相矛盾。其他 job 的数量仍会相加。

[AgentClaimGuard](https://github.com/konoeph/AgentClaimGuard) 是 Python 策略门，核对结构化声明和调用方提供的证据。[agent-receipts](https://github.com/inchwormz/agent-receipts) 是本地哈希链运行时，只有仓库检查绑定到精确字节时才提升声明。[obsigna](https://github.com/agent-receipts/obsigna) 验证已签名的收据链。这个 action 不签名，也不要求代理配合。它只把 PR 上已经写下的短语和 CI、diff、关联 issue 对照，默认警告，不阻断。

## What it checks

### 1. Scope vs linked issue

This is the check to read first. Other review actions compare a diff to a policy file, or they re-run tests. This one asks whether the files in the diff look like the linked issue.

It finds linked issues from closing keywords (`Fixes #123`, including cross-repo refs and GitHub issue URLs) and from GitHub's linked-issues API. For every changed file it writes a reason:

- the issue text names the path, a parent directory, or the filename
- a path token such as `session` appears in the issue, with a short quote
- only identifiers in the diff overlap the issue (called out as a weaker signal)
- no shared keyword, listing the file's tokens and the issue's keywords
- the path is sensitive (lockfile, workflow, env file, key, manifest, CI, build config) and whether the issue mentioned it

It also calls out a large diff, a large file that does not match the issue, and a directory where several files are all outside the issue. Keyword overlap is not understanding. The comment shows the rule id and the words it used so you can disagree with it.

Without a linked issue, files are marked **not compared**. Sensitive paths and a large diff are still reported. That missing-issue signal is a warning, and it is recorded as info instead for bot authors (`dependabot`, `renovate`, and any login ending in `[bot]`), docs-only diffs, diffs that only match `ignore-paths`, and pull requests that carry a configured skip label.

### 2. Test evidence from CI that already ran

The action does **not** run tests. It reads check runs and Actions jobs for this pull request's head SHA and reports which test-like jobs ran, their pass/fail conclusion, and counts parsed from the log when the summary is one of:

jest, vitest, pytest, go test, cargo test, junit XML, or a Surefire `Tests run:` line.

If nothing test-like finished, the comment says **no test evidence** at info severity by default. Set `test-evidence.no-evidence` to `warn` or `error` to raise it. Logs that cannot be read still show the job conclusion. Raw logs are not pasted into the comment.

Name patterns are configurable. Defaults match names such as `test`, `unit`, `e2e`, `jest`, `vitest`, `pytest`, `go test`, and `cargo test`. A job named only `lint` or `test-coverage` is not treated as test evidence. `jest coverage` is.

### 3. Review packet

The pull request body should contain four sections: **Intent**, **Risks**, **Tests run**, and **Self-verification**. English and Chinese headings both count (`意图`, `风险`, `已运行测试`, `本人验证`, and the other aliases in the default config). HTML comments and placeholders such as `TODO` / `待补充` do not count as content.

[`.github/pull_request_template.md`](.github/pull_request_template.md) is the template, in English and Chinese.

### 4. Claim verification

See [Unreleased / v1.1](#unreleased--v11). Phrases in the title, description, and optional commit messages are marked verified, contradicted, or unverified in the same sticky comment. Contradicted claims warn. They do not fail the job unless `fail-on` is set.

### 5. Lockfile provenance

Report only. When the pull request changes `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `Cargo.lock`, or `go.sum`, the comment lists package versions that were not in the base file. An added lockfile lists every package in it. A renamed lockfile is compared with the file at the old path. Removed lockfiles are ignored. A version that was already present is not listed again.

`present` means a public registry API returned provenance or a sigstore attestation for that name and version:

| Ecosystem | What `present` means |
| --- | --- |
| npm | The version document on `registry.npmjs.org` has `dist.attestations.provenance`, or an attestation URL |
| PyPI | The integrity API returns an attestation bundle for a file named in the lockfile, or for the sdist (otherwise a wheel) from the JSON API |
| crates.io | The version's trusted-publishing record has a commit SHA and a repository |
| Go | The module proxy `.info` document has an origin URL and hash |

Anything else stays `unknown`: no attestation, the version was not found, the lookup failed or timed out, the lookup cap was reached, or the package came from git, a file, a link, or a private registry. `unknown` is not a failure. This check's status is `pass` when it runs and `skipped` when `checks.lockfile-provenance` is false. `fail-on` does not read it, so it does not fail the job and does not block a merge.

The default asks at most 30 public registries. `lockfile-provenance.max-lookups` changes that cap. Packages past the cap are `unknown` and are not requested. The comment shows 40 rows. Only the package name and version are sent, plus a PyPI filename when the lockfile already lists one. Lockfile text, the diff, and the pull request body are not sent.

## Add it

```yaml
name: PR evidence

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]

permissions:
  contents: read
  pull-requests: write
  issues: read
  checks: read
  actions: read

jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: tupils1/pr-evidence-check@v1
```

Examples use `tupils1/pr-evidence-check@v1`. The `v1` tag tracks the latest v1 release. No config file. No checkout. Scope and the review packet are ready immediately. Test evidence is whatever CI has already finished for the head SHA. If tests are still running, the comment says that.

To read logs from tests in the **same** workflow, run this after them and keep the comment even when tests fail. The test job only needs `contents: read`. A job-level `permissions` key replaces the workflow permissions, so the evidence job repeats the full block:

```yaml
permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test

  evidence:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: read
      checks: read
      actions: read
    steps:
      - uses: tupils1/pr-evidence-check@v1
```

More copies live in [`examples/`](examples/).

### Fork pull requests

A `pull_request` workflow from a fork cannot write comments. [`examples/workflow-fork-prs.yml`](examples/workflow-fork-prs.yml) uses `pull_request_target` and does **not** check out the pull request. This action only calls the GitHub API. Do not checkout the head SHA, and do not install or build the pull request, in that job.

Config is read from the **base** SHA via the API. A pull request cannot delete `.github/pr-evidence.yml` on the base branch to disable its own checks. A missing file means the defaults.

### Permissions

| Permission | Why |
| --- | --- |
| `contents: read` | Read `.github/pr-evidence.yml` at the base SHA, and read changed lockfiles at the base and head SHAs. |
| `pull-requests: write` | Read the pull request and its files, and create or update the one comment. |
| `issues: read` | Read the title and body of each linked issue. |
| `checks: read` | List check runs for the head SHA. |
| `actions: read` | List Actions runs and jobs, and download job logs. |

`issues: write` is not granted. The comment is on the pull request, and `pull-requests: write` covers that.

If a token cannot read logs, the comment still lists the job conclusion and says the log was not readable.

## Try it locally

```bash
npm ci
npm test
npm run demo
```

`npm run demo` prints a sample comment for a pull request that fixes a session timeout and also edits billing code, a workflow, and a lockfile. No token and no network.

## `fail-on`

| Value | When the job fails |
| --- | --- |
| `none` (default) | Never, unless the action is misconfigured |
| `warning` | An enabled check is `warn` or `error` |
| `error` | An enabled check is `error` |

Default severities:

| Situation | Severity |
| --- | --- |
| No linked issue | warn |
| No linked issue, and the author is a bot, the diff is docs-only or only matches `ignore-paths`, or the pull request has a skip label | info |
| Any file outside the issue | warn |
| At least 3 judged files, not counting unmentioned sensitive paths, and at least half of those files outside the issue | error |
| Sensitive path the issue does not mention | warn. These paths are not counted in the outside-scope error ratio |
| Diff reaches 400 lines or 20 files | warn |
| No test-like job or check on the SHA | info |
| A matched test job failed, timed out, or was cancelled | warn |
| Review packet section missing, empty, or a placeholder | warn |
| A claim is contradicted | warn. `claims.contradicted: error` raises that check to error. Unverified claims stay inside a passing check |
| Lockfile provenance is missing, unknown, or a registry lookup failed | pass. This check only reports. `fail-on` does not read it |

`test-evidence.require-passed: true` raises a failed test job to error. `test-evidence.no-evidence: warn` or `error` raises the default info for a missing test job. `review-packet.incomplete: error` raises an incomplete packet to an error. If you set `fail-on` and also mark this job required in branch protection, GitHub will block the merge. That is opt-in. The default does not.

## Optional config

`.github/pr-evidence.yml` on the base branch. Every key is optional. A commented copy is [`examples/pr-evidence.yml`](examples/pr-evidence.yml).

```yaml
language: en # comment language. en or zh. Heading match is always bilingual.

checks:
  scope: true
  test-evidence: true
  review-packet: true
  claims: true
  lockfile-provenance: true

scope:
  large-diff-lines: 400
  large-diff-files: 20
  large-file-lines: 300
  outside-scope-error-min: 3
  outside-scope-error-ratio: 0.5
  ignore-paths: []
  sensitive-paths: []
  ignore-sensitive-ids: []
  no-linked-issue: warn # warn, info, or skip
  skip-labels: []
  docs-paths: []

test-evidence:
  parse-logs: true
  no-evidence: info
  require-passed: false

review-packet:
  min-body-chars: 8
  incomplete: warn

claims:
  scan-commits: false # also read commit messages
  contradicted: warn # warn or error. Does not fail the job unless fail-on is set.
  # patterns: # a list here replaces the built-in phrases
  #   - id: tests_pass
  #     evidence: tests # tests, lint, build, breaking, test_files, or linked_issue
  #     patterns:
  #       - "(?i)(?<![A-Za-z])all tests pass(?![A-Za-z])"

lockfile-provenance:
  max-lookups: 30 # public registry lookups for newly added packages. Further packages stay unknown.
```

`comment-language` on the action overrides `language`. `fail-on` is an action input, not a config key, because failing the job is a workflow choice.

Sensitive-path ids you can turn off: `lockfiles`, `github-workflows`, `github-settings`, `env-files`, `credentials`, `docker`, `package-manifest`, `ci-other`, `tooling-config`.

Job-name patterns are JavaScript regular expressions. A leading `(?i)` makes one pattern case-insensitive.

## Inputs and outputs

| Input | Default | Purpose |
| --- | --- | --- |
| `token` | `github.token` | Reads the pull request, issues, checks, and logs. Writes the comment. |
| `config-path` | `.github/pr-evidence.yml` | Path inside the repo at the base SHA. |
| `fail-on` | `none` | `none`, `warning`, or `error`. |
| `comment-language` | empty | `en` or `zh`. Empty uses the config file, which defaults to `en`. |

Outputs: `scope-status`, `test-evidence-status`, `review-packet-status`, `claims-status` (`pass`, `warn`, `error`, or `skipped`), `lockfile-provenance-status` (`pass` or `skipped`), `comment-url`, `head-sha`.

The workflow also gets a job summary with the same body as the comment.

## Limits

- Scope is path and keyword overlap. It will not notice that a function in an unrelated file implements the issue, unless the diff identifiers overlap. A Chinese issue matches best when it names the path or the English identifier.
- Lockfiles, env files, and key files are not marked in scope just because their diff happens to contain a word from the issue.
- Test counts are the last summary in the job log. A runner this action does not know still counts as evidence that a test job ran, without counts.
- The comment is a snapshot. It does not wait for other workflows. Run it after tests, or let a later `workflow_run` update the same comment.
- The action does not decide whether the change is correct.
- Claim phrases are literal patterns. A sentence that does not match a pattern is not a claim. A verified `fixed #12` only means that issue exists and is referenced.
- Lockfile provenance is the public registry's answer for that name and version. `present` is not a review of the package. `unknown` is not a failed check. Git, file, and private sources are not queried.

## Development

Node 20 or newer locally. The action runtime in `action.yml` is `node24`.

```bash
npm ci
npm test
npm run typecheck
npm run build   # writes dist/. CI fails if dist/ is stale.
```

CI runs the tests and a second job that rebuilds `dist/` and fails if it does not match the commit. The bundle is produced with `@vercel/ncc`.

## License

[MIT](LICENSE)

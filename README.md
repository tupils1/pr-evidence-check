# pr-evidence-check

A free GitHub Action for maintainers reviewing pull requests, including ones an agent wrote. It posts **one comment** and updates that same comment in place.

It does three deterministic checks. No LLM. No model API. Nothing from the pull request is sent off the runner except the normal GitHub API calls that read the pull request, the linked issues, and CI that already ran.

**Zero config.** You do not need `.github/pr-evidence.yml`. Built-in defaults are on until you override them.

The job stays green unless you opt in with `fail-on`, or the action itself is misconfigured (bad YAML, empty token, unsupported event). It never merges, never dismisses reviews, and never creates a separate required check beyond the workflow job you already added.

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
      - uses: tupils1/pr-evidence-check@main
```

Examples use `tupils1/pr-evidence-check@main`. This repository does not publish release tags. No config file. No checkout. Scope and the review packet are ready immediately. Test evidence is whatever CI has already finished for the head SHA. If tests are still running, the comment says that.

To read logs from tests in the **same** workflow, run this after them and keep the comment even when tests fail:

```yaml
  evidence:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: tupils1/pr-evidence-check@main
```

More copies live in [`examples/`](examples/).

### Fork pull requests

A `pull_request` workflow from a fork cannot write comments. [`examples/workflow-fork-prs.yml`](examples/workflow-fork-prs.yml) uses `pull_request_target` and does **not** check out the pull request. This action only calls the GitHub API. Do not checkout the head SHA, and do not install or build the pull request, in that job.

Config is read from the **base** SHA via the API. A pull request cannot delete `.github/pr-evidence.yml` on the base branch to disable its own checks. A missing file means the defaults.

### Permissions

| Permission | Why |
| --- | --- |
| `contents: read` | Read the optional config file at the base SHA |
| `pull-requests: write` | Create or update the one comment |
| `issues: read` | Read linked issues on private repositories |
| `checks: read` | Read check runs for the head SHA |
| `actions: read` | Download Actions job logs |

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

`test-evidence.require-passed: true` raises a failed test job to error. `test-evidence.no-evidence: warn` or `error` raises the default info for a missing test job. `review-packet.incomplete: error` raises an incomplete packet to an error. If you set `fail-on` and also mark this job required in branch protection, GitHub will block the merge. That is opt-in. The default does not.

## Optional config

`.github/pr-evidence.yml` on the base branch. Every key is optional. A commented copy is [`examples/pr-evidence.yml`](examples/pr-evidence.yml).

```yaml
language: en # comment language. en or zh. Heading match is always bilingual.

checks:
  scope: true
  test-evidence: true
  review-packet: true

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

Outputs: `scope-status`, `test-evidence-status`, `review-packet-status` (`pass`, `warn`, `error`, or `skipped`), `comment-url`, `head-sha`.

The workflow also gets a job summary with the same body as the comment.

## Limits

- Scope is path and keyword overlap. It will not notice that a function in an unrelated file implements the issue, unless the diff identifiers overlap. A Chinese issue matches best when it names the path or the English identifier.
- Lockfiles, env files, and key files are not marked in scope just because their diff happens to contain a word from the issue.
- Test counts are the last summary in the job log. A runner this action does not know still counts as evidence that a test job ran, without counts.
- The comment is a snapshot. It does not wait for other workflows. Run it after tests, or let a later `workflow_run` update the same comment.
- The action does not decide whether the change is correct.

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

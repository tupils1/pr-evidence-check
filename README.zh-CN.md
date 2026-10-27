# pr-evidence-check

给维护者用的免费 GitHub Action，用来看 pull request，包括代理生成的 pull request。它只发 **一条评论**，之后每次都在原地更新这一条。

三项检查都是确定规则。不调用 LLM，也不把代码送到模型 API。除了读取 pull request、关联 issue 和已经跑完的 CI，runner 不向外发送仓库内容。

**零配置。** 不需要 `.github/pr-evidence.yml`。没有这个文件就用内置默认值。

除非你把 `fail-on` 设成 `warning` 或 `error`，或者 action 本身配置错了（YAML 不合法、token 为空、事件类型不对），job 都会成功。它不会合并，不会驳回 review，也不会另外造一个检查项。

## 检查什么

### 1. 范围与关联 issue

先看这项。别的 action 拿 diff 去对一份策略文件，或者重新跑测试。这项问的是：改动的文件像不像关联 issue 里的任务。

关联 issue 来自两处：closing keyword（`Fixes #123`，也认跨仓库引用和 GitHub issue URL），以及 GitHub 的 linked issues API。每个改动文件都会写明原因：

- issue 文本里出现了路径、父目录或文件名
- 路径里的词（例如 `session`）出现在 issue 里，并附上一小段引用
- 只有 diff 里的标识符和 issue 重合（会标明这是较弱的信号）
- 没有共同关键词，并列出文件词和 issue 关键词
- 路径是敏感路径（锁文件、workflow、环境变量、密钥、包清单、CI、构建配置），以及 issue 有没有提到它

diff 达到行数或文件数阈值、单个对不上的大文件、同一个目录下多份都对不上的文件，也会单独写出来。这不是语义理解。评论里有规则 id 和用到的词，你可以不同意。

没有关联 issue 时，文件标成 **未对照**。敏感路径和大 diff 仍然会报。这条「没有关联 issue」默认是警告；作者是机器人（`dependabot`、`renovate`，或以 `[bot]` 结尾的登录名）、改动只有文档、改动只命中 `ignore-paths`，或 PR 带有配置的 skip label 时，降为 info。

### 2. 已有 CI 的测试证据

这个 action **不会**跑测试。它读取这个 head SHA 上已有的 check run 和 Actions job，列出像测试的 job、成功或失败，并在日志里能认出汇总时解析数量。支持：

jest、vitest、pytest、go test、cargo test、junit XML，以及 Surefire 的 `Tests run:` 行。

这个 SHA 上没有像测试的 job 时，评论会写 **没有测试证据**，默认是 info。要用 `test-evidence.no-evidence` 设成 `warn` 或 `error` 才会升高。日志读不到时，仍然保留 job 结论。原始日志不会贴进评论。

job 名称模式可以改。默认能认出 `test`、`unit`、`e2e`、`jest`、`vitest`、`pytest`、`go test`、`cargo test` 这类名字。只叫 `lint` 或 `test-coverage` 的 job 不算测试证据。`jest coverage` 算。

### 3. 审查材料包

PR 描述里应有四节：**Intent**、**Risks**、**Tests run**、**Self-verification**。中英文标题都算（`意图`、`风险`、`已运行测试`、`本人验证`，以及默认配置里的其他别名）。HTML 注释和 `TODO`、`待补充` 这类占位不算正文。

[`.github/pull_request_template.md`](.github/pull_request_template.md) 是中英双语模板。

## 接上

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

示例使用 `tupils1/pr-evidence-check@main`。这个仓库不发布 release tag。不需要配置文件，也不需要 checkout。范围和审查材料包马上就有。测试证据是这个 head SHA 上已经结束的 CI。测试还在跑，评论会写明。

测试和这个 action 在同一个 workflow 里时，放在测试后面，测试失败也要评论：

```yaml
  evidence:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: tupils1/pr-evidence-check@main
```

更多例子在 [`examples/`](examples/)。

### 来自 fork 的 pull request

fork 触发的 `pull_request` 不能写评论。[`examples/workflow-fork-prs.yml`](examples/workflow-fork-prs.yml) 使用 `pull_request_target`，并且 **不** checkout 该 pull request。这个 action 只调用 GitHub API。不要在那个 job 里 checkout head SHA，也不要安装或构建 PR 里的代码。

配置从 **base** SHA 用 API 读取。PR 不能靠改自己的 `.github/pr-evidence.yml` 关掉检查。base 上没有这个文件，就用默认值。

### 权限

| 权限 | 原因 |
| --- | --- |
| `contents: read` | 读取 base SHA 上的可选配置 |
| `pull-requests: write` | 创建或更新那一条评论 |
| `issues: read` | 私有仓库读取关联 issue |
| `checks: read` | 读取 head SHA 的 check run |
| `actions: read` | 下载 Actions job 日志 |

token 读不了日志时，评论仍列出 job 结论，并说明日志不可读。

## 本地试

```bash
npm ci
npm test
npm run demo
```

`npm run demo` 会打印一条样例评论：issue 是登录会话超时，diff 里还有账单代码、workflow 和锁文件。不需要 token，也不访问网络。

## `fail-on`

| 值 | job 何时失败 |
| --- | --- |
| `none`（默认） | 不会失败，除非 action 本身配置错误 |
| `warning` | 有启用的检查是 `warn` 或 `error` |
| `error` | 有启用的检查是 `error` |

默认严重级别：

| 情况 | 级别 |
| --- | --- |
| 没有关联 issue | warn |
| 没有关联 issue，且作者是机器人、改动只有文档或只命中 `ignore-paths`、或 PR 带有 skip label | info |
| 有文件超出 issue | warn |
| 至少 3 个被判断的文件（不计入 issue 没提到的敏感路径），且其中至少一半超出 issue | error |
| issue 没提到的敏感路径 | warn。这些路径不计入超出范围的 error 比例 |
| diff 达到 400 行或 20 个文件 | warn |
| 这个 SHA 上没有像测试的 job 或 check | info |
| 命中的测试 job 失败、超时或取消 | warn |
| 审查材料包缺节、过短或只有占位 | warn |

`test-evidence.require-passed: true` 会把失败的测试 job 升为 error。`test-evidence.no-evidence: warn` 或 `error` 会把默认的 info（没有测试 job）升高。`review-packet.incomplete: error` 会把不完整的审查材料包升为 error。如果你设置了 `fail-on`，又在分支保护里把这个 job 标成必需，GitHub 会挡住合并。这是可选的。默认不会挡。

## 可选配置

写在 base 分支的 `.github/pr-evidence.yml`。每一项都可选。带注释的副本是 [`examples/pr-evidence.yml`](examples/pr-evidence.yml)。

```yaml
language: en # 评论语言。en 或 zh。标题匹配始终中英都认。

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
  no-linked-issue: warn # warn、info 或 skip
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

action 的 `comment-language` 覆盖 `language`。`fail-on` 是 action 输入，不是配置项，因为让 job 失败是 workflow 的决定。

可以关掉的敏感路径 id：`lockfiles`、`github-workflows`、`github-settings`、`env-files`、`credentials`、`docker`、`package-manifest`、`ci-other`、`tooling-config`。

job 名称模式是 JavaScript 正则。开头的 `(?i)` 表示这条模式不区分大小写。

## 输入和输出

| 输入 | 默认 | 作用 |
| --- | --- | --- |
| `token` | `github.token` | 读取 PR、issue、check 和日志，并写评论。 |
| `config-path` | `.github/pr-evidence.yml` | 仓库里、base SHA 上的路径。 |
| `fail-on` | `none` | `none`、`warning` 或 `error`。 |
| `comment-language` | 空 | `en` 或 `zh`。空则用配置文件，配置默认 `en`。 |

输出：`scope-status`、`test-evidence-status`、`review-packet-status`（`pass`、`warn`、`error` 或 `skipped`）、`comment-url`、`head-sha`。

workflow 的 job summary 与评论正文相同。

## 边界

- 范围靠路径和关键词重合，不是理解需求。无关文件里的函数即使实现了 issue，只要 diff 标识符对不上，就不会算在范围内。中文 issue 写上路径或英文标识符时最好用。
- 锁文件、环境变量文件和密钥文件不会因为 diff 里碰巧有 issue 中的词就算在范围内。
- 测试数量取 job 日志里最后一条汇总。不认识的 runner 仍然说明有一个测试 job 跑过，只是没有数量。
- 评论是当时的快照，不会干等别的 workflow。放在测试后面跑，或用之后的 `workflow_run` 更新同一条评论。
- 它不判断改动对不对。

## 开发

本地 Node 20 或更新。`action.yml` 里的运行时是 `node24`。

```bash
npm ci
npm test
npm run typecheck
npm run build   # 写出 dist/。dist/ 过期时 CI 会失败。
```

CI 会跑测试，并用另一个 job 重新构建 `dist/`，和提交不一致就失败。打包用 `@vercel/ncc`。

## 许可证

[MIT](LICENSE)

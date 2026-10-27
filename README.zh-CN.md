# pr-evidence-check

给维护者用的免费 GitHub Action，用来看 pull request，包括代理生成的 pull request。它只发 **一条评论**，之后每次都在原地更新这一条。

四项检查都是确定规则。不调用 LLM，也不把代码送到模型 API。除了读取 pull request、关联 issue 和已经跑完的 CI，runner 不向外发送仓库内容。声明核验是尚未发布的 v1.1 检查。`v1` 和 `v1.0.0` 标签里没有它。

**零配置。** 不需要 `.github/pr-evidence.yml`。没有这个文件就用内置默认值。

除非你把 `fail-on` 设成 `warning` 或 `error`，或者 action 本身配置错了（YAML 不合法、token 为空、事件类型不对），job 都会成功。它不会合并，不会驳回 review，也不会另外造一个检查项。

![超出范围的 pull request 上的粘性评论](docs/scope-comment.png)

上图是 [pull request #9](https://github.com/tupils1/pr-evidence-check/pull/9#issuecomment-6445101391) 的粘性评论。范围是 error，测试证据和审查材料包通过。之后的运行仍更新这一条。截图来自带标签的 v1 评论，当时还没有声明核验。

## Unreleased / v1.1

声明核验在这个分支上，**不在** `v1` 和 `v1.0.0` 标签里。这两个标签仍只跑下面三项检查。仓库没有 v1.1 发行版。

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

这不证明 diff 是对的。`fixed #12` 只说明 issue 存在并且被引用，不说明改动修好了它。没有名称像破坏性变更的检查时，`no breaking changes` 保持未证实。`all tests pass` 信任已有 CI 结论和解析数量，不会重新跑测试。

[AgentClaimGuard](https://github.com/konoeph/AgentClaimGuard) 是 Python 策略门，核对结构化声明和调用方提供的证据。[agent-receipts](https://github.com/inchwormz/agent-receipts) 是本地哈希链运行时，只有仓库检查绑定到精确字节时才提升声明。[obsigna](https://github.com/agent-receipts/obsigna) 验证已签名的收据链。这个 action 不签名，也不要求代理配合。它只把 PR 上已经写下的短语和 CI、diff、关联 issue 对照，默认警告，不阻断。

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

### 4. 声明核验

见 [Unreleased / v1.1](#unreleased--v11)。标题、描述和可选的提交说明里的短语，会在同一条粘性评论里标成已证实、相矛盾或未证实。相矛盾的声明是警告。除非设置了 `fail-on`，不会因此让 job 失败。

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
      - uses: tupils1/pr-evidence-check@v1
```

示例使用 `tupils1/pr-evidence-check@v1`。`v1` 标签指向最新的 v1 版本。不需要配置文件，也不需要 checkout。范围和审查材料包马上就有。测试证据是这个 head SHA 上已经结束的 CI。测试还在跑，评论会写明。

测试和这个 action 在同一个 workflow 里时，放在测试后面，测试失败也要评论。测试 job 只需要 `contents: read`。job 上的 `permissions` 会替换 workflow 级权限，所以 evidence job 要重复整段：

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

更多例子在 [`examples/`](examples/)。

### 来自 fork 的 pull request

fork 触发的 `pull_request` 不能写评论。[`examples/workflow-fork-prs.yml`](examples/workflow-fork-prs.yml) 使用 `pull_request_target`，并且 **不** checkout 该 pull request。这个 action 只调用 GitHub API。不要在那个 job 里 checkout head SHA，也不要安装或构建 PR 里的代码。

配置从 **base** SHA 用 API 读取。PR 不能靠改自己的 `.github/pr-evidence.yml` 关掉检查。base 上没有这个文件，就用默认值。

### 权限

| 权限 | 原因 |
| --- | --- |
| `contents: read` | 读取 base SHA 上的 `.github/pr-evidence.yml`。 |
| `pull-requests: write` | 读取 pull request 和改动文件，并创建或更新那一条评论。 |
| `issues: read` | 读取每个关联 issue 的标题和正文。 |
| `checks: read` | 列出 head SHA 上的 check run。 |
| `actions: read` | 列出 Actions run 和 job，并下载 job 日志。 |

不授予 `issues: write`。评论写在 pull request 上，`pull-requests: write` 已经覆盖。

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
| 有声明与证据相矛盾 | warn。`claims.contradicted: error` 会把这项升为 error。未证实的声明仍算在通过的检查里 |

`test-evidence.require-passed: true` 会把失败的测试 job 升为 error。`test-evidence.no-evidence: warn` 或 `error` 会把默认的 info（没有测试 job）升高。`review-packet.incomplete: error` 会把不完整的审查材料包升为 error。如果你设置了 `fail-on`，又在分支保护里把这个 job 标成必需，GitHub 会挡住合并。这是可选的。默认不会挡。

## 可选配置

写在 base 分支的 `.github/pr-evidence.yml`。每一项都可选。带注释的副本是 [`examples/pr-evidence.yml`](examples/pr-evidence.yml)。

```yaml
language: en # 评论语言。en 或 zh。标题匹配始终中英都认。

checks:
  scope: true
  test-evidence: true
  review-packet: true
  claims: true

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

claims:
  scan-commits: false # 同时读取提交说明
  contradicted: warn # warn 或 error。除非设置了 fail-on，不会让 job 失败。
  # patterns: # 写了列表就会替换内置短语
  #   - id: tests_pass
  #     evidence: tests # tests、lint、build、breaking、test_files 或 linked_issue
  #     patterns:
  #       - "(?i)(?<![A-Za-z])all tests pass(?![A-Za-z])"
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

输出：`scope-status`、`test-evidence-status`、`review-packet-status`、`claims-status`（`pass`、`warn`、`error` 或 `skipped`）、`comment-url`、`head-sha`。

workflow 的 job summary 与评论正文相同。

## 边界

- 范围靠路径和关键词重合，不是理解需求。无关文件里的函数即使实现了 issue，只要 diff 标识符对不上，就不会算在范围内。中文 issue 写上路径或英文标识符时最好用。
- 锁文件、环境变量文件和密钥文件不会因为 diff 里碰巧有 issue 中的词就算在范围内。
- 测试数量取 job 日志里最后一条汇总。不认识的 runner 仍然说明有一个测试 job 跑过，只是没有数量。
- 评论是当时的快照，不会干等别的 workflow。放在测试后面跑，或用之后的 `workflow_run` 更新同一条评论。
- 它不判断改动对不对。
- 声明短语是字面模式。对不上模式的句子不是声明。已证实的 `fixed #12` 只说明该 issue 存在并且被引用。

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

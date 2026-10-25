# feishu-ci-failure-action

当指定的 CI 检查步骤失败时，向飞书群发送通知，包含检查日志末尾和 GitHub Actions 运行链接。

只关注一个检查步骤，默认 ID 为 `check`。安装依赖、配置环境等其他阶段失败时不会通知；检查步骤成功、取消或被跳过时也不会通知。

## 快速接入

1. 在飞书群添加自定义机器人，将 webhook 保存为调用仓库的 Actions Secret：`FEISHU_CI_FAILURE_WEBHOOK`。
2. 为检查步骤设置 `id: check`，用 `tee` 保存日志。
3. 在同一个 Job 的末尾添加通知步骤。

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '24'
      - run: npm ci
      - id: check
        shell: bash
        run: npm run check 2>&1 | tee "$RUNNER_TEMP/ci-check.log"
      - name: 通知飞书 CI 失败
        if: ${{ failure() && steps.check.outcome == 'failure' }}
        uses: secretmomo/feishu-ci-failure-action@v1
        with:
          webhook: ${{ secrets.FEISHU_CI_FAILURE_WEBHOOK }}
          outcome: ${{ steps.check.outcome }}
          check-step: check
          log-file: ${{ runner.temp }}/ci-check.log
```

发布命令同时维护具体版本标签（例如 `v1.0.1`）和主版本浮动标签（例如 `v1`）。使用 `@v1` 会跟随之后发布的 1.x 版本；使用 `@v1.0.1` 固定该版本。首次发布前也可使用已提交代码的完整 commit SHA 验证。

明确设置 `shell: bash` 会启用 GitHub Actions 的 `pipefail`，确保检查命令的失败不会被 `tee` 的成功退出码覆盖。使用其他执行方式时，也需要保留原始命令的退出码。

Action 使用 GitHub 提供的 Node.js 24 运行时，不需要调用方为它安装依赖、构建或配置 Node.js；示例中的 setup-node 是业务检查所需。通知自身不依赖调用项目的 checkout，也不调用 GitHub API。

## 输入

| 输入 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `webhook` | 否 | 空 | 飞书自定义机器人 webhook；为空时跳过 |
| `outcome` | 否 | 空 | 推荐传入 `${{ steps.check.outcome }}`；非空时优先于 `steps` |
| `steps` | 否 | 空 | 兼容旧调用的 `${{ toJSON(steps) }}`；未提供 `outcome` 时读取目标步骤状态 |
| `check-step` | 否 | `check` | 步骤 ID，空白值回落为 `check`；使用 `steps` 时选择目标步骤，使用 `outcome` 时只影响卡片展示，换用其他步骤 ID 时必须同步设置 |
| `log-file` | 否 | 空 | 一个 UTF-8 日志文件；支持绝对路径或相对于 `GITHUB_WORKSPACE` 的路径 |
| `redact-values` | 否 | 空 | 需要隐藏的值，每行一个；忽略空白行，保留有效值的首尾空格，按原文匹配 |

没有日志、文件不存在、无法读取或内容为空时，仍发送失败步骤和运行链接。步骤 ID 不存在、输入 JSON 无效、webhook 无效或发送失败时输出 warning，通知步骤保持成功。请求超时为 10 秒，不自动重试，避免重复通知。

`outcome` 与 `steps` 至少提供一个。有效状态为 `success`、`failure`、`cancelled`、`skipped`；缺少或无效时告警并跳过。优先使用 `outcome`，避免其他步骤的大体量 outputs 经 `toJSON(steps)` 进入环境变量，超出系统的进程启动限制。使用 `outcome` 后不要再传入完整 `steps`，否则仍会占用环境变量空间。

输出 `status` 为 `sent`、`skipped` 或 `warning`，可通过 `${{ steps.<通知步骤ID>.outputs.status }}` 读取。未预期的内部异常也保持 warning，并在步骤调试日志中记录固定的异常类型，不输出异常原文或请求载荷。

### 自定义检查步骤和日志脱敏

```yaml
- id: test
  shell: bash
  run: npm test 2>&1 | tee "$RUNNER_TEMP/test.log"

- name: 通知飞书测试失败
  if: ${{ failure() && steps.test.outcome == 'failure' }}
  uses: secretmomo/feishu-ci-failure-action@v1
  with:
    webhook: ${{ secrets.FEISHU_CI_FAILURE_WEBHOOK }}
    outcome: ${{ steps.test.outcome }}
    check-step: test
    log-file: ${{ runner.temp }}/test.log
    redact-values: |
      ${{ secrets.API_TOKEN }}
      ${{ secrets.DATABASE_PASSWORD }}
```

webhook 和 `redact-values` 会从通知内容中移除。为避免全局日志不可读，去除首尾空白后少于 4 个字符的值只在通知内容中脱敏，不登记为全局日志掩码，仅在目标步骤失败且配置了 webhook 时输出一条不含原值的提醒。纯空白行直接跳过。

初始读取普通日志文件末尾至多 64 KiB，并读取前一个字节判断是否恰好从完整行首开始，识别 LF、CR 和 CRLF 换行；若没有可安全展示的完整非空行，则向前扩大窗口，直到找到完整行、覆盖整个文件或达到 1 MiB 上限。扩大时只读取新增部分，包含边界上下文字节的累计读取不超过 1 MiB。预算内只有空白时明确提示停止回溯，不继续搜索预算外更早的错误；真正的超长单行则提示安全省略。FIFO 等非普通文件会快速跳过读取。

大文件的首个不完整边界行会丢弃，防止敏感值或 UTF-8 字符的残段进入通知。如果配置的脱敏值本身包含字面 CR，则读取时仅以 LF 为安全边界，必要时扩窗或省略，避免切开该敏感值。脱敏先于展示截断，并清除终端控制序列、将 CRLF / CR 换行统一为 LF；最多展示末尾 25 行、2800 个 UTF-16 代码单元，避免截断代理对；有完整后续行时丢弃首个不完整行。日志里的反引号会使用更长的代码围栏包裹。

原始日志文件不自动继承 GitHub 控制台的 Secret 遮盖。Action 不读取 `.env`，也无法自动知道所有业务凭据；请将可能出现在日志中的敏感值显式传入 `redact-values`。每行是一个完整待隐藏值，不是变量名或正则表达式，不支持以多行形式传入单个值。

脱敏也会匹配被 NUL、CR、换行、制表符等 C0/C1 控制字符分隔的敏感值，替换完整匹配范围，保留范围外的正常换行。对字面 CR 敏感值先按原文匹配，再清理控制字符和规范化换行，并做最终脱敏。最终卡片的标题、固定文案、回退原因、诊断及按钮文字也使用同一规则；卡片协议字段（如 `schema`、`tag`）保持有效。

## 通知行为

- 每次调用至多发送一条消息，多个 Job / Matrix 分项分别通知。
- 卡片包含仓库、工作流、Job ID、Runner 操作系统 / 架构、失败步骤 ID、分支 / 引用、提交、触发者、运行次数，以及查看运行的按钮。同一 OS / 架构下不同 Matrix 维度仍需进入运行详情查看。
- 使用步骤的 `outcome` 判断是否失败。对于 `continue-on-error: true` 的检查，`failure()` 可能为 false；若也需要通知，可使用 `if: ${{ !cancelled() && steps.check.outcome == 'failure' }}`。
- Fork PR 无法取得 Secret 时自动跳过，不需要提高工作流权限。
- 支持飞书 `/open-apis/bot/v2/hook/` 自定义机器人，以数字型 `code: 0` 判定成功；不承诺兼容旧版响应或代理改写的响应格式。机器人需要使用 HTTPS webhook；不支持签名校验。关键词或 IP 白名单设置仍需与实际发送内容及 Runner 网络匹配。为避免外发内容被转交到其他地址，不跟随 webhook 重定向。
- `log-file` 可以读取指定的绝对路径及符号链接目标，`webhook` 决定发送目的地。二者必须来自维护者控制的可信配置，不要直接透传不可信的 `inputs.*`、`github.event.*` 等值；此 Action 不提供文件系统隔离。
- 支持 GitHub 托管的 Linux、Windows、macOS Runner，Windows 示例也需显式使用 Bash。自托管 Runner 需支持 Node.js 24 Action。
- 仓库访问权限由 GitHub 决定，调用方需要有权引用此 Action；配置 Secret 并不会授予 Action 仓库的访问权限。

## 发布

先确认检查通过，并将要发布的代码（包括 `package.json` 的版本修改）提交，然后执行：

```sh
pnpm release
```

发布逻辑由带注释的 Node.js 脚本 `scripts/release.mjs` 实现。从 `package.json.version` 读取版本，例如 `1.0.1` 创建附注标签 `v1.0.1` 并更新浮动标签 `v1`；`2.3.0` 则创建 `v2.3.0` 并更新 `v2`，不影响 `v1`。浮动标签指向本次发布的提交；预发布版本也遵循同一 major 规则。

浮动标签不保证版本单调递增或兼容性：发布较旧版本或维护分支也会将对应 major 移到本次提交；`0.x` 共用 `v0`，跨 minor 可能包含破坏性变化。其他克隆同步已移动的标签时，需要显式更新该标签，例如 `git fetch origin +refs/tags/v1:refs/tags/v1`，无需强制覆盖所有本地标签。

当前分支、具体版本标签和浮动标签一次原子推送至 `origin`。本地或远端已存在同名具体版本标签时立即报错；远端查询失败也会停止。浮动标签使用限定到该引用、带预期对象 ID 的 `--force-with-lease` 更新，远端被其他发布修改时拒绝覆盖；分支和具体版本不强制推送。

工作区必须干净，包括未跟踪文件；本地工具记录等不需要提交的内容应自行加入 `.gitignore`。脚本不会自动提交代码、递增版本或创建 GitHub Release。后续发布先手动修改 `package.json.version`，提交后再次执行同一命令，无需另外输入标签更新命令。

推送失败时，本地具体版本新标签会保留，本地浮动标签不提前移动。脚本会区分并发/分支冲突、服务端不支持原子推送及连接异常；仅对明确的连接异常提供带原 lease 的条件式重试命令。冲突应先 fetch 并核对分支、版本，服务端不支持原子推送时不会自动降级。再次直接执行 `pnpm release` 会因本地具体版本标签已存在而报错。解决原因后，如需重发同一版本，先确认远端未发布该版本，再用 `git tag -d vX.Y.Z` 删除对应的本地标签；远端已发布时应提升 `package.json.version`。

本地 Git 命令超时为 30 秒，远端查询和推送为 5 分钟。推送超时意味着远端状态未知，服务端可能已完成发布；务必先按提示核对远端引用，不要直接重试或删除标签。错误提示中的核对、重试和恢复命令采用 POSIX shell（如 sh、bash、zsh）的引号语法；在 PowerShell/cmd 中需按对应语法调整。脚本不自动重试推送，也不交互式询问 HTTP 凭据；默认 SSH 使用 BatchMode，尊重显式设置的 SSH 客户端。发布前请配置好凭据助手或 SSH，避免在 remote URL 中内嵌用户名/token；脚本会遮盖错误诊断中的 URL 用户信息。

## 开发与验证

使用 Node.js 24 或更高版本：

```sh
npm run check
```

无第三方依赖、无构建步骤，`action.yml` 直接执行仓库中的 `src/index.mjs`。提交源码即可分发，无需发布 npm 包或提交打包产物。

测试与被测试文件放在同一目录：`src/index.mjs` 对应 `src/index.test.mjs`。

测试通过模拟 HTTP 请求验证卡片、步骤过滤、脱敏、日志降级及发送失败行为，不会向真实飞书群发消息。仓库 CI 在 Linux、Windows、macOS 上使用 Node.js 24 执行检查，Job 超时为 10 分钟。接线测试使用仅用于 CI 的 fetch 模拟器验证真实 Action 入口、输入和输出，并明确断言发送状态，不访问网络。

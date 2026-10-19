# dsh-popo-watcher

[English](README.md) | 简体中文

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 POPO 群聊插件：监控一个已配置的群，判断是否适合接话，调用宿主模型生成简短回复，再通过官方 POPO CLI 发送。设置页提供监控控制、参数配置、手动发言和活动记录。

插件面向 **DSH 0.2.x**，当前设置界面为中文。

## 插件作用

- 在 **设置 → POPO自动水群** 中开始或停止监控窗口。新安装不会自动启动，需要先配置目标群。
- 生效的生成提供方为 CodeMaker 时，开始监控和自动恢复会先按宿主当前地址及凭证请求模型列表。检查失败或超过 5 秒则保持停止并显示原因，修复后需重新开始；此检查不生成文本，仅确认接口可访问。
- 可使用 TypeSafe 判读会话与草稿，也可关闭 TypeSafe，由 DSH 语言模型在一次调用中决定是否回复并生成内容。TypeSafe 判读不确定时也交给语言模型复核，明确拒绝仍然有效。两类模型可独立选择，生成模型也可跟随宿主默认设置。
- 语言模型优先自然回应针对当前账号的提问、接话和玩笑。提示中会标明当前账号，并将自己的消息标记为 `[自己]`；回复不必提供新的技术信息，话题结束时仍可返回 `SKIP`。
- 生成使用宿主模型上限，插件不设置 token 预算或推理总时限；连接及断流故障由宿主处理。停止监控会取消生成并释放队列。
- 忙碌或冷却期间的新消息会合并为有界的待判批次。冷却结束后的下一次成功采集会根据最新上下文重新判断，即使没有新消息也能补判。
- 配置提示词、开场白、监控时长、轮询间隔、回复长度、安静时段、每小时上限和自动发送演练。
- 概览页的“只回复 @ 我的消息”默认关闭，点击即保存；开启后，只有本轮确认直接 @ 当前账号的消息进入自动回复流程，开场白和手动发送照旧。
- 查看最近群消息，以及本地发送、判读和轮次记录。
- 向已保存的目标群手动发送原文，监控停止时也可使用。
- 模型临时失败后依次等待 20、40、60 秒，此后持续按 60 秒退避；宿主要求更长等待时遵从宿主。到期后的下一次成功采集会按最新上下文补判，没有新消息也会重试。采集故障持续指数退避，上限 300 秒，不再限制失败次数；恢复后计数清零。
- 认证失败、模型配置错误、额度耗尽、CLI 缺失、无效采集响应和持久化错误会停止监控。未知模型错误、`SKIP`、拒绝或截断草稿不循环重试。进入发送调用后，该批消息绝不自动重放，包括回执不明或记账失败的情况。
- 从明确指定的目录导入旧版 watcher 历史数据，导入不会开启监控。

```text
新消息／待判消息 → 时间与内容检查 → 可选的 TypeSafe 判读
               → 宿主模型判断并生成草稿 → 最终检查 → POPO 发送 → 本地记账
```

已启用的 TypeSafe 判读不可用时，默认保持安静。关闭 TypeSafe 后无需其凭证，由语言模型返回回复或 `SKIP`。**手动发言始终真实发送**，即使自动发送开启演练也一样。手动发言不受自动间隔和判读限制，但要求有效的已保存群号、非空正文，并防止同一次请求重复提交。POPO 发送统一携带 `source=AGENT`。

@ 识别组合使用官方 `atMembers` 搜索和正文中的“@当前姓名或昵称”。单独 @所有人不触发，同时直接 @ 我则允许进入判读；身份缺失、账号不一致或查询失败时保持安静。当前接口不返回原始 @ 成员清单，因此手打同名 @、引用内容仍可能误判。

## 项目依赖

| 依赖 | 用途 |
| --- | --- |
| DSH **0.2.x** | 提供运行时、模型服务、RPC 和界面。兼容基准为 Desktop **0.2.1-rc.2**；`@deepseek-ai/dsh-tools` 的 peer 范围为 `^0.2.1-rc.2`，不包含更早版本及 0.3。 |
| `@deepseek-ai/cordis` **^4.0.2** | 由 DSH 提供的插件框架。 |
| 官方 POPO CLI（`@popo/cli`） | 完成认证、群消息搜索与发送。按所在组织提供的 CLI 安装方式获取，并使用能访问目标群的账号登录。 |
| [TypeSafe](https://typesafe.ai/) API key | 可选的会话和草稿判读，仅启用 TypeSafe 时需要；默认模型为 `jev-latest`。 |
| 已配置的 DSH 语言模型 | 生成自动回复，模型提供方凭证由宿主管理。 |
| Git | 克隆仓库并安装本地插件。 |
| Node.js **24+**、npm、esbuild **0.28.2** | 用于开发、重建客户端与测试；esbuild 仅为开发依赖。 |

插件本身没有第三方运行时依赖：宿主代码使用 Node.js 内置模块，客户端复用 DSH 提供的 React。仓库已包含生成的 `lib/client.js`，安装未经修改的源码副本不需要构建客户端。不要为了满足可选 peer 声明，在插件目录中另装一套宿主包。

Windows Desktop 是运行时回归目标。Linux 使用 DSH web profile，并显式设置 POPO CLI 入口；Desktop 测试入口未验证 Linux 宿主。

## 安装方法

先安装兼容的 DSH 宿主与官方 POPO CLI，再在终端完成认证：

```sh
popo-cli auth login
popo-cli auth status
```

### Windows：DSH Desktop

在 PowerShell 中执行，将 Desktop 路径替换为实际安装目录：

```powershell
git clone https://github.com/TzeHimSung/dsh-popo-watcher.git
cd dsh-popo-watcher

$dshCli = 'C:\path\to\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dshCli --version
$package = (npm pack --json --ignore-scripts | ConvertFrom-Json)[0].filename
& $dshCli plugin --profile desktop add (Join-Path (Get-Location).Path $package)
```

重新启动 DSH Desktop，进入 **设置 → POPO自动水群**。使用 Desktop 自带的 CLI，使安装目标与其 `desktop` profile 和运行时一致。安装打包文件，使源码目录与 Desktop 的安装及清理路径分开；打包文件包含已提交的客户端产物，修改客户端源码后应先重新构建。

### Linux：DSH web profile

已安装兼容的 `dsh` 命令后执行：

```sh
git clone https://github.com/TzeHimSung/dsh-popo-watcher.git
cd dsh-popo-watcher
dsh --version
dsh plugin --profile web add "$PWD"
dsh web
```

若 web 宿主已经运行，安装后重新启动。本地安装会将源码目录链接到目标 profile，因此需要保留该目录。命令遵循 DSH 官方的[插件安装流程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 首次配置

1. 打开插件的 **设置** 页签，填写目标 POPO 群 ID 并保存。默认配置不内置真实群号。
2. 在 DSH 中配置生成模型；插件可选择指定模型，也可保持 **跟随宿主默认**。
3. 使用 TypeSafe 判读时，在 **判读凭证** 中填写 key，或为宿主进程设置 `TYPESAFE_API_KEY`。Windows 下也支持用户环境变量；界面保存的本地 key 优先。仅使用语言模型时，关闭 **使用 TypeSafe 判读** 即可。
4. 使用 **检查 POPO CLI** 验证 CLI 与登录状态。这项检查不会启动监控或发送消息。
5. 检查开场白和自动发送参数，选择监控时长，再打开监控。自动发送演练默认 **关闭**，开场白默认启用。

Linux 或自定义 CLI 安装路径需要在插件 `config.json` 中，将 `popoCliJs` 设为 `@popo/cli/bin/popo.js` 的绝对路径，保留其他字段，然后重新读取配置或重启宿主。`npm root -g` 可查看全局模块目录。目前自动发现只检查 Windows npm 安装布局。

## 数据与凭证

运行数据保存在仓库外的 `<用户主目录>/.dsh/popo-watcher/`：

```text
config.json                  # 已保存配置
secret.json                  # 仅在界面保存 key 时生成
<群 ID>/
  state.json / poller.json    # 窗口、发送记账与采集状态
  messages.jsonl             # 采集消息
  sends.jsonl / judge.jsonl / round.jsonl / poll.log
```

本地 key 以 JSON 值保存，没有加密；界面只显示来源，不回显内容。清除本地 key 不会删除环境变量。运行对应功能时，会话上下文和草稿会发送给 TypeSafe 与已配置的模型。日志同时限制条目数和字节数。

仓库使用虚构测试身份和合成样本；凭据、运行数据、原始截图、本机验收日志及临时探针已排除在 Git 提交范围之外。已停止窗口不会自行恢复；启用 `autoResume` 时，尚未过期的活动窗口可以在宿主重启后恢复。

## 更新与卸载

Desktop 使用打包文件安装时，执行 `git pull --ff-only` 后重复上面的打包和安装命令，再重新启动 DSH。链接安装的 web 源码副本更新后重启即可。修改客户端源码后，需要先重新构建。0.1.4 将过时的 Connection 依赖 `webRuntime` 改为 `webStartup`，要求使用 0.2 系列中的 DSH 0.2.1-rc.2 或更新版本。

```powershell
# Windows Desktop，使用前文定义的 $dshCli
& $dshCli plugin --profile desktop remove dsh-popo-watcher
```

```sh
# DSH web profile
dsh plugin --profile web remove dsh-popo-watcher
```

卸载插件包不会删除单独保存的配置和历史数据。

## 开发与验证

```sh
npm ci
npm run build:client       # src/client/index.js → lib/client.js
npm run check:client       # 校验已提交的产物与源码一致
npm run dev:client         # 监听源码并重新构建
npm test                  # 离线测试；跳过仅能在宿主运行的用例
```

在已安装 DSH Desktop 的 Windows 上：

```powershell
npm run test:desktop -- 'C:\path\to\DeepSeek Harness'
node tools/preview-ui.mjs 'C:\path\to\DeepSeek Harness'
```

Desktop 测试使用内置 Node 和真实宿主库运行完整用例，数据放在临时目录，外部服务使用桩。预览加载实际客户端和宿主主题，RPC 全部模拟。两者都不需要读取真实 POPO 消息或调用模型。`npm pack` 会在打包前重新构建客户端。

| 目录 | 内容 |
| --- | --- |
| `lib/` | 宿主模块及生成的客户端文件 |
| `src/client/` | 客户端源码和样式 |
| `test/` | 离线测试及合成样本 |
| `tools/` | 构建、测试、预览及可选的真实环境诊断 |
| [`docs/interfaces.md`](docs/interfaces.md) | 详细行为与接口契约 |

真实环境诊断必须显式传入 `--group`，回放还需 `--legacy`。这些工具可能读取真实 POPO 消息或调用 TypeSafe，与离线测试入口分开。

## 许可证

[GNU GPL 第 3 版](LICENSE)（`GPL-3.0-only`）。

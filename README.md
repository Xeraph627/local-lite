# local-lite · 本地简化

> 一个为**上下文窗口很小的本地模型**准备的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent 预设。
> 每次请求的固定开销约 **2,004 token**（系统提示词 + 工具 schema），工具面收拢为
> 文件读写、检索与终端命令七件。
>
> A minimum-prompt DSH agent preset for short-context local models: a standing
> per-request cost of about 2,004 tokens (system prompt plus tool schemas), with
> the tool surface narrowed to seven file, search, web and shell tools.

装好之后，新建会话的预设选择器里会多出一项 **本地简化**。

---

## 为什么需要它

每次请求在模型真正开口之前，都要先付一笔固定开销：

| 组成 | 说明 |
|---|---|
| 系统提示词 | 每次请求完整重发 |
| 工具 schema JSON | **同样每次请求完整重发**，工具面越大越贵 |

标准预设在 `deepseek-account / deepseek-flash`（100 万窗口）上的实测：

```
系统提示词      5,953 字符   ≈  1,490 token
工具 schema   31,191 字节    ≈  7,798 token   （36 个工具）
--------------------------------------------
固定开销                     ≈  9,288 token
```

单个体积最大的工具：`pwsh` 860 token、`workflow` 847、`plugin_manager` 612、
`ask_user_question` 312。关键结论是：**裁工具比裁提示词有效得多**——提示词全砍也才省 1.5k。

### 同一台机器、同一个模型上的对照

下面三行都是本机 `lm-studio / qwen/qwen3.5-9b`、32k 窗口的会话日志实测。
**只有前两行可以相减**，它们用的是同一套宿主工具面和同一个 persona：

| 会话 | 系统提示词 | 工具 schema | 固定开销 |
|---|---|---|---|
| 本地简化，`tool-surface` 生效 | 186 token | 1,818 token（13 个工具） | **2,004 token** |
| 本地简化，`tool-surface` **未**生效 | 186 token | 2,969 token（19 个工具） | 3,155 token |
| 标准预设（`deepseek-flash`，另一条路由，作参照） | 1,490 token | 7,798 token（36 个工具） | 9,288 token |

前两行的 persona 逐字节相同（已比对哈希），宿主工具面相同，**唯一差别是
`tool-surface` 有没有把继承来的全局工具摘掉**：那 6 个 `ssh_*` 与
`load_workspace_dependencies` 合计约 1,151 token。所以这张表量的是这个插件本身的收益，
不是跨 profile 的对比。

> 第三行只作为量级参照，**不要与前两行相减**：它跑在另一条路由、另一个窗口大小上。
>
> **这个收益的大小取决于机器上装了多少宿主插件**：摘掉的都是宿主层挂载的工具，干净
> harness 上只有 `load_workspace_dependencies` 一个，那时省下的就少得多。本预设的**固定
> 成本**是 2,004 token；`tool-surface` 是随 profile 变化的**额外**收益。
>
> 一个容易误判的地方：会话记录头部的 `agentPreset` 字段是在**建会话时**写入的，
> 早于预设绑定，所以跑本地简化的会话里那个字段仍写着 `standard`。判断依据应该是模型
> 真正收到的东西——`tools/verify-claims.mjs` 现在就是这么做的：wire 上还留着继承来的
> 全局工具，就说明 `tool-surface` 没生效。

---

## 它做了什么

### 1. 系统提示词只剩一段 persona

`@deepseek-ai/dsh-persona` 的 `complete: true` 让那段 prefix 成为**整个**系统提示词：
harness 身份、web-surface、工具指南、文件引用、结构化输出等段落一律不再注入。
配合 `includeRuntimeContext: false`，sandbox / approval 那几条 user-role 运行时快照也一并关闭。

提示词本身 247 字符（组装时再追加一行工作目录，合计 270 字符），写成中文，因为本地小模型通常在中文上表现最好：

```
你是本地精简模式的编码助手，工作目录 <cwd>。

规则：
- 先读再改。修改文件前先读取它；不确定就先查，不要猜。
- 用工具动手，不要空谈。需要事实就 read/grep/glob/web_search；需要执行就用 shell 工具。
- 保持简短。一次解决一件事，回答用要点，不要复述已知内容。
- 改了代码要验证；有失败就修到通过，或者如实说明卡在哪里。
- 不要输出大段日志：在命令里自己过滤，只取需要的范围。
- 项目里有 AGENTS.md 或 README 时，先读它。
```

提示词里**不出现具体可执行文件名**（不写 `pwsh`、不写 PowerShell 的参数名）：`pwsh` 行在非 Windows 上是 `disabled` 的，写死工具名会让 macOS / Linux 用户看到一个不存在的工具。平台相关的指引只放在各自已被 `process.platform` 门控的 shell 行里。

### 2. 工具面收拢到这几件

本预设自己声明 7 个：

| 工具 | 能力 | 来源 |
|---|---|---|
| `read` / `write` / `edit` | 读写文件 | `@deepseek-ai/dsh-tool-fs` |
| `glob` / `grep` | 按路径 / 内容检索 | `@deepseek-ai/dsh-tool-fs-search` |
| `web_search` / `web_fetch` | 联网检索资料 | `@deepseek-ai/dsh-tool-web` |
| `pwsh`（Windows）/ `bash`（POSIX） | 执行终端命令 | `@deepseek-ai/dsh-tool-pwsh-persistent` |
| `job_output` / `job_list` / `job_kill` | 后台任务控制 | `@deepseek-ai/dsh-tool-jobs` |

**干净 harness 上的基线是 11 个工具**（社区评审在分支上实测）：上面这 7 个加上无法由预设声明的 4 个——

- `read_image`：宿主 `attachments` 挂载时自动注册，读图片用。
- `job_output` / `job_list` / `job_kill`：随 `tool-jobs` 行注册。
- `load_workspace_dependencies`：宿主层工具。

装了额外宿主插件就会更多，那时 `tool-surface` 才开始削掉它们：作者这台机器装了 SSH 插件，
多出 6 个 `ssh_*`，与前两行表中的 13 个工具对应。**工具数取决于 profile，不是这个预设的
固定属性**——所以基线写 11 个，13 个是「作者 profile」的实测值。

三个取舍：

- **用持久 shell，不用每次新进程的 shell。** 持久行可以覆写 `description`（自带默认值很长），
  schema 也只有一个 `command` 参数、没有 sandbox 升级字段（省 671 token）。`cd`、变量、函数
  跨调用保持，对小模型尤其重要——它省掉了「把命令拼成一条复合命令」这一步推理。
  `maxOutputChars: 12000` 保证原始日志挤不掉提示词。
- **输出上限在工具层收窄。** `readLimit: 1200`、`searchMaxResults: 5`、
  `fetchMaxOutputChars: 24000`（出厂默认 200,000 字符，比本地模型整个窗口还大）。
- **保留 `compaction-basic`。** 短上下文正是要设计的失效场景，自动压缩必须能工作。

### 3. 遮蔽继承来的全局工具

这一条是本预设唯一的自研插件 `tool-surface`，也是收益最大的一块。

DSH 把 **host 层挂载的工具对每个 agent 都可见**，与预设无关。所以即使预设只声明 7 个工具，
实测仍有 19 个——多出来的是一个 SSH 插件（6 个 `ssh_*`，≈1,090 token）和
`load_workspace_dependencies`（158 token），跟这个预设毫无关系。

`tool-surface` 用 `ctx.tools.restrict({ deny })` 把它们从这个预设的 scope 上摘掉。注意
**名单是算出来的，不是写死的**：

```
deny = { 实时全局视图里的名字 } - { 本预设自己注册的 } - { 保留的传输名 } - { keep } + { alsoDeny }
```

`restrict()` 遇到未知工具名会**直接抛错**，所以写死的名单一旦 profile 变化（比如你启用了
SSH 插件）就会反过来让预设挂不上。算出来的名单不会过期。

**保留的传输名必须排掉**：`tools` 行处于 `ptc` 或 `both` 模式时，全局视图里会出现
保留名 `run_code`，而 `restrict()` 拒绝它。这一条不是装饰——`tools/mutation-check.mjs`
把过滤拆掉后实测：`accepted=0, warnings=2`，**整套遮蔽全丢**，重试也救不回来（重试只丢
调用方显式写的 `alsoDeny`，算出来的 `run_code` 会跟着进重试）。

其余失败路径都只记日志、不抛错：削不掉只是多花 token，不该让预设组不起来。`keep` 是
保留某个继承工具的逃生口，例如 `keep: [ask_user_question]`。

### 故意不放的东西

- **plan 模式**：`plan:policy` 段落约 1,000 token 常驻系统提示词且无法缩短。另外
  `complete: true` 的 persona 与它会构成两个 complete 段，assembly 会直接失败——两者互斥。
- **subagent / workflow / ralph / goal / skill / todo / ask_user_question / present**。
- **`str_replace_editor`**：与 read/write/edit 功能重复。
- **`tool-result-pruner`**：shell 和 read 已在工具层设了上限，而在这个上下文规模上，
  悄悄裁掉小模型刚主动要来的结果，比它省下的空间更糟。

---

## 安装

需要 DeepSeek Harness（Desktop 或 CLI）以及它自带的 `plugin_manager` 工具。

```
plugin_manager { action: "install_bundle", target: "<本仓库的 git 地址或 npm 包名>" }
```

本地开发时直接指向目录：

```
plugin_manager { action: "install_bundle", target: "D:\\path\\to\\local-lite" }
```

装完后**重启 DSH**（预设定义在启动时按 patch 解析），新建会话时在预设选择器里选 **本地简化**。

### 卸载

```
plugin_manager { action: "remove_bundle", target: "@Xeraph627/dsh-local-lite-preset" }
```

### 本机开发时注意

- 若 profile 里记录的是 `link:` 指向你的工作目录，**不要删除或移动该目录**，否则预设失效。
- 改完 `cordis.patch.yml` 或 `lib/index.js` 后要让 Loader 重读。**改行插件名必须重启**；
  只改插件代码体时，关掉再打开预设行通常就够：

  ```
  plugin_manager { action: "set_plugin", target: "include:preset-local-lite", enabled: false }
  plugin_manager { action: "set_plugin", target: "include:preset-local-lite", enabled: true }
  ```

- 用 `install_bundle` 重装时 target 要用**解析后的包名**而不是路径，否则报
  `ambiguous-install`（它按「依赖有没有变化」判断装了什么，路径匹配不上任何依赖键）。

---

## 技术栈

| 层 | 用了什么 |
|---|---|
| 运行载体 | Node.js ESM（`"type": "module"`） |
| 插件框架 | [Cordis](https://github.com/deepseek-ai/deepseek-harness) —— 插件是 `export const name / inject / apply(ctx, config)` |
| 配置方言 | Cordis loader patch YAML（`insert` 列表、`!!js` 表达式、`cordis:group`、`isolate` realm） |
| 扩展点 | DSH `ctx.tools` 注册表（`schemas()` 读全局视图、`restrict()` 按 scope 遮蔽全局工具） |
| 预设声明 | `@deepseek-ai/dsh-agent-preset`（`dsh.bundle.patch` 指向的 patch 里 insert 一行） |
| 提示词 | `@deepseek-ai/dsh-persona`（`complete: true` + `includeRuntimeContext: false`） |
| 开发工具 | 纯 Node 内置模块，零开发依赖：`node:zlib`（zstd）、`node:module`、`js-yaml`（借自 profile） |

> 为什么没有构建步骤：插件只有 `lib/index.js` 一个文件、零 runtime 依赖，不需要打包器。
> 包体就是源码，`pnpm pack` 的产物正好是运行所需的 4 个文件。

### 项目结构

```
local-lite/
├─ package.json          # 既是 bundle 清单，也是插件入口（exports）
├─ cordis.patch.yml      # 预设声明本体
├─ lib/index.js          # tool-surface 插件：按实时全局视图遮蔽继承来的工具
├─ README.md
└─ tools/                # 开发期工具，不参与运行（在 files 白名单之外）
   ├─ validate-patch.mjs     # 装之前校验：声明形状 / 禁止路径行 / 行名真能解析 / isolate 完整
   ├─ patch-anchoring.mjs    # 复刻 Host 的行名锚定规则，供校验器使用
   ├─ test-tool-surface.mjs  # 六种情形的回归测试：假注册表复刻 restrict() 的三类拒绝
   ├─ mutation-check.mjs     # 变异校验：证明 run_code 过滤是必需而非装饰
   ├─ install-to-library.mjs # 按市场发布的三件套装进 $DSH_HOME/agent-presets/
   ├─ measure-session.mjs    # 实测某个会话的固定开销（提示词 + 工具 schema）
   ├─ verify-claims.mjs      # 用字节校验文档里的数字：persona 字符数 + 平台专用词 + 工具清单
   ├─ session-log.mjs        # 解码会话日志（zstd 分帧 JSONL）
   ├─ pr-status.mjs          # 查 / 改提交 PR：check-runs、workflow runs、描述
   └─ asar.mjs               # 只读 app.asar（Desktop 里无法用 shell 打开）
```

---

## 开发

零依赖，直接跑：

```powershell
# 1. 声明校验：形状 / 禁止路径行 / 行名解析 / isolate 完整性 —— 必须全绿才能装
node tools/validate-patch.mjs cordis.patch.yml

# 2. 插件回归测试：六种情形，假注册表复刻 restrict() 的三类拒绝
node tools/test-tool-surface.mjs

# 3. 变异校验：把 run_code 过滤拆掉，证明整套遮蔽真的会失效
node tools/mutation-check.mjs

# 4. 实测某个会话的固定开销
node tools/measure-session.mjs <session.v4.jsonl.zstd>

# 5. 校验文档数字（persona 必须不含平台专用工具名）
node tools/verify-claims.mjs cordis.patch.yml <session.v4.jsonl.zstd>

# 6. 会话日志概览（事件类型统计 / 读某类事件）
node tools/session-log.mjs <session.v4.jsonl.zstd> [eventType]

# 7. 按市场发布的三件套装进预设库（验证 preset center 的安装/声明路径）
node tools/install-to-library.mjs            # --remove 卸载；--from <目录> 指定来源
```

会话日志位置：`$DSH_HOME/sessions/<转义后的工作区目录>/<session-id>/session.v4.jsonl.zstd`

### 三个踩过的坑（都已在工具里固化成检查）

**1. 预设声明里的行名绝不能是路径。** 失败的不是那一行，而是**整个预设**——UI 上整张卡片
显示「加载失败」加一句 `tool-surface (...): never started`。原因在 Host 的
`anchorInsertedPluginNames` 只锚定 `insert` 行和 `group: true` 行的子行；预设声明的
`config.plugins` 不是 `config`，解析器不会下钻，于是相对路径原样传下去、绝对路径以裸文件
系统路径（而非 `file://` URL）传下去，两种都解析不到。**必须用裸包名 specifier。**
`validate-patch.mjs` 现在把路径行当硬错误拒绝（三种形式都有回归覆盖）。

**2. 插件不能是 bundle 的子依赖。** 曾经把插件放成同仓库子包、用 `link:./tool-surface` 引用——
**这在别的机器上必然坏**：bundle 的依赖不会被传递安装，profile 只是把 bundle 目录符号链接
进来，不会装它自己的依赖。所以插件改成放在包内、由 `exports` 暴露，patch 里直接用包名本身。
**一个包，一个 specifier，零依赖。**

**3. `install_bundle` 会跑 pnpm，pnpm 会去问 registry。** 网络不通时实测挂了近 4 小时才被
终止，失败时会回滚 profile 的 `package.json`。网络不可用时改用 `set_plugin` 关掉再打开预设行。

---

## 兼容性

- 在 **DeepSeek Harness 0.2.0-rc.2**（Windows / Electron Desktop，`lm-studio / qwen3.5-9b`）
  上开发并实测通过：系统提示词 270 字符（persona 247 字符 + 一行工作目录）。
- shell 行按平台二选一（`!!js process.platform` 门控）：Windows 用 `pwsh`，POSIX 用 `bash`。
  两个套餐的 `description` 都覆写成中文。**POSIX 分支尚未在真机验证过**——但 persona 里
  不出现具体工具名，所以非 Windows 用户不会拿到一个不存在的工具。
- 预设 id 是 `local-lite`，roster order 5，选择器显示名 **本地简化**。
- `tool-surface` 依赖 `ctx.tools.schemas()` / `ctx.tools.restrict()` 这两个 API；
  上游若改名，它会**只记日志、不抛错**（预设照常挂载，只是少省 1.2k token），
  所以升级 DSH 后建议用 `tools/verify-claims.mjs` 复查一次工具数量。
- 干净 harness 上 wire 是 11 个工具；装了额外宿主插件会更多，那时 `tool-surface` 才会
  开始削掉它们。工具数取决于 profile，不是这个预设的固定属性。

## 许可

MIT。声明部分改编自 DeepSeek Harness 内置的 `minimal` 与 `standard` 预设（MIT）；
`lib/index.js`、`tools/*` 为本项目自有实现。

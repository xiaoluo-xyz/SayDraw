# 说画 SayDraw × Cherry Studio：对比、差距与改进方案

> **基线**：说画 SayDraw v0.6.0（10 次提交、全部发生在 2026-10-10，`src` 约 7,450 行 TS/TSX，单窗口 Electron 44 应用）
> Cherry Studio v2.1.7（2026-10-19 发布；52,771 star / 5,100 fork / 411 贡献者 / 1,219 open issues，AGPL-3.0 + 商业授权）
> **性质**：只读分析。本文未修改任何源码、未改动任何配置。
> 调研口径：说画一侧逐文件通读源码（证据均给 `文件:行号`）；Cherry 一侧读 v2.1.7 公开发布物与源码树（证据给链接），文档与源码冲突处按源码判断并标注。

---

## 决策基线（2026-10-21 已拍板）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 产品定位 | **垂直图像工作室**——不追「全能 AI 工作台」 |
| D2 | 开源与商业化 | **保持原样**：MIT 纯开源，不做付费层、不做私有网关 |
| D3 | 平台 | **保持原样**：Windows 深耕，不排跨平台 |

下文所有方案已按这三条收敛；与决策冲突的条目已删除或降级。

---

## 0. 三句话结论

1. **不在同一层，不要比功能条数。** Cherry 已经从「聊天套壳」重写成「全能 AI 工作站 + Agent 运行时」（九个启动台入口、66 家服务商、知识库、MCP 市场、定时任务、自动更新、14 种语言）；说画是「图像创作工作流」。功能清单我们必输，而且短期内补不回来。
2. **真正要比的是「从一句话到可交付成品的确定性」。** 说画的三道确认门、需求规格、双蒙版编号、版本链 `parentId`、工作目录四件套、请求体积预算，都是「过程可控」的硬资产；Cherry 的绘画页恰恰没有这些（其 `painting` 表在源码里被注释为 *frozen receipt*，无 parent/lineage，草稿只活在渲染进程内存里）。
3. **但差距在收窄，且方向对我们不利。** Cherry V2 的 Agent 工作区已经具备「工作目录 + 文件/命令工具 + 内置 `generate_image` + 权限模式 + ComfyUI 当模型」，能拼出我们 60% 的主干；它缺的是「创作纪律」，我们缺的是「桌面客户端基本功」。所以**先补信任底座，再押创作纵深**，翻译/笔记/小程序/频道这类不要碰。

---

## 1. 事实基线

| 维度 | 说画 SayDraw v0.6.0 | Cherry Studio v2.1.7 |
|---|---|---|
| 定位 | 垂直：对话式图像创作 Agent（Windows 桌面端） | 平台：全能 AI 工作站（对话/工作 Agent/知识库/绘画/翻译/笔记/小程序/文件/编码搭档） |
| 项目体量 | 10 commits、单日成型、~7.5k 行、1 个包 | 411 贡献者、~5 天/版、10 个 workspace 包、52.7k star |
| License | **MIT** | **AGPL-3.0** + 商业授权 |
| 技术栈 | Electron 44 · React 19 · TS 5.9 · Zustand · Tailwind 4 · Konva；主进程 = Agent 编排 | Electron 44.4.4 · React 19.2 · TS 5.9 · TanStack Router · Vercel AI SDK 6 · Radix |
| 本地存储 | `%APPDATA%\SayDraw\app-data.json` 全量 JSON（tmp+rename 原子写）；Key 走 `safeStorage` | v2 改为 **better-sqlite3 + Drizzle + sqlite-vec**（Dexie 仅用于 v1→v2 迁移） |
| 模型接入 | 3 种请求规范（OpenAI / Anthropic / Responses），连接分组 + 模型两级；图片端点独立 | **66 家**内置服务商（含 ollama/lmstudio/ovms/comfyui/claude-code/codex），数据驱动 registry |
| Agent | 自研循环：无迭代上限、模型自判、自评回传、三道硬门、12 个工具 | Agent 运行时：workspace/fork/subagent/jobs、权限模式、内置工具 + MCP + Skills |
| 图像 | 文生图/图生图/蒙版（overlay 编号 + binary 接口双图）/多参考 16 张/版本链/工作目录产物 | 独立绘画页（27 模板 + Artboard + 历史 Strip）+ 对话内 `generate_image`；参考图；**蒙版仅有文档宣称，源码未见 inpaint/mask** |
| 数据安全 | 无备份/无导出/无云同步 | WebDAV / S3 / 本地 / 自动备份 + v1→v2 迁移工具 |
| 分发 | 仅 Windows，NSIS + portable，**无自动更新、无签名** | Win/mac/Linux 双架构、自动更新（含模型目录热更新）、296 MB 安装包 |
| 工程 | 无 CI、无测试框架（仅有 `scripts/verify-fix.cjs` 手动脚本）、无 i18n、无遥测 | vitest 多 project + Playwright e2e + 20 个 GitHub Actions、14 语言 |

> 量级差三个数量级：这不是「我们功能少」，而是「我们在 1 天里做了别人 2 年工程的骨架」。

---

## 2. 逐维度对比

### 2.1 信任与运维（桌面客户端的及格线）

| 能力 | 说画 | Cherry | 判读 |
|---|---|---|---|
| 自动更新 | 无（`electron-builder.yml` 无 `publish`） | 有，含回滚与模型目录热更新 | **落后，必修**。用户重装一次就可能流失 |
| 备份/迁移 | 无导出；JSON 损坏会静默空库 | WebDAV/S3/本地/自动 + 迁移向导 | **落后，必修**。「怕丢」是知识工作者的第一顾虑 |
| 崩溃与诊断 | 无崩溃捕获、无日志包；失败原因仅写进消息 | 开发者模式 + 调用链 | 落后，低成本可补 |
| 安装体验 | 未签名（SmartScreen 拦）、无单实例锁 | 签名安装包、增量更新 | 落后 |
| 多语言 | 仅简体中文 | 14 种 | 落后（开源传播的硬门槛） |
| 全局搜索/快捷键 | 无搜索；仅 Enter/Esc/Ctrl+Z/`[` `]` | 全局搜索、多窗口、快捷键体系 | 落后 |
| 会话管理 | 列表只有标题，无置顶/分组/重命名/归档；封面字段 `coverAssetId` 未用 | 助手 + 话题 + 分组 + 标签 + 置顶 + 消息分支 | 落后 |
| 数据规模 | 每次变更全量重写 JSON；长会话/多资产会变慢 | SQLite 索引 | 落后（当前量级可忍，半年后会痛） |

### 2.2 创作纵深（我们的战场）

| 能力 | 说画 | Cherry | 判读 |
|---|---|---|---|
| 需求收集 | 9 槽位 `ImageBrief` + 硬确认门（`loop.ts:262-285`），未确认/无分辨率直接拦截 | 无此概念，绘画页直接填 prompt | **我们领先**，且是唯一「质量前置」设计 |
| 迭代节奏 | 用户消息 = 首图授权，之后自判微调必须 `ask_user` 确认（`loop.ts:506-510`） | 无强制确认，重生成即新纪录 | **我们领先**，要把它做成可感知的卖点 |
| 自评回传 | 生成图自动回传模型自评（≥3MB 独立额度，`loop.ts:528`） | Agent 能看图，但无「看完必须确认再改」的协议 | 我们领先 |
| 版本链 | `parentId` 单亲链 + 来源标注 + 版本条 | 绘画历史 Strip 只是缩略图列表，**无 lineage**（`painting.ts` 注释 frozen receipt） | **我们领先**，但要升级成「树」 |
| 局部重绘 | Konva 蒙版，一处编号对应一条 instruction，双蒙版策略（overlay 给人看、binary 给接口） | 文档称支持，源码未见实现 | 我们领先（待实测对方） |
| 多参考融合 | 最多 16 张、单张 25MB、提示词 32k 字符 | 参考图上限依模型 | 领先，但 UI 上「能传 16 张」完全不可见 |
| 候选对比 | 无：`maxN` 常为 1，串行试错 | 批次生成（同模型多张）+ 多模型横向并行 | **落后**，专业用户刚需 |
| 参数复现 | 资产只存 prompt，无完整参数快照 | 绘画页保留参数表单 | 落后 |
| 交付 | 复制/另存为（`ipc.ts:133`） | 文件托管 + 导出多端 | 落后：无多比例导出、无命名规则、无水印、无清单 |
| 成本可见 | 无 token/张数/费用视图 | 用量记录 | 落后（专业创作者会算账） |
| 上下文工程 | 1280 长边内联、单图 ≤1.5MB、8MB 总预算、空闲 120s + 15min 硬顶、生图 600s | 未公开同等机制 | **我们领先**（隐性硬核，值得写进 README） |

### 2.3 平台生态（补不上，也不该全补）

| 能力 | 说画 | Cherry | 判读 |
|---|---|---|---|
| 知识库/RAG | 无（素材靠 `list_directory`） | 每库独立 sqlite-vec 索引 + 向量/BM25 混合 RRF + rerank | 落后；建议做「素材检索」轻量版，而非通用 RAG |
| MCP/技能 | 无 | MCP 客户端 + 9 个市场源 + Skills | 落后；只接 3 个高价值服务 |
| 联网检索 | 无 | 关键词搜索 + 网址读取（含免费 DuckDuckGo 源） | 落后；接「风格/素材参考」一个场景即可 |
| 自动化 | 无 | 频道、定时任务、心跳、子智能体、工作流 | 差距大，优先级最低 |
| 外部 API | 无 | 本机 OpenAI 兼容 API 网关 | 落后（B 端才有价值） |
| 本地模型 | 部分（任意兼容 `baseUrl` 可配，含本地） | Ollama/LM Studio/OVMS + 本地 embedding/TTS/ASR | 落后（ComfyUI 优先级更高） |
| 跨平台 | Windows only | Win/mac/Linux | 落后 |

---

## 3. 我们的护城河（都能在代码里指出来）

1. **过程契约**：三道门（未确认禁生图 / 无分辨率禁生图 / 本轮已出图，再改需 `ask_user`）——这是把「质量」前置成协议，不靠模型自觉（`loop.ts:262-285`、`systemPrompt.ts:44-46`）。
2. **提示词手艺**：骨架式画面描述（主体→环境→风格→光影→构图）、禁空泛质量词、分辨率走参数不进 prompt、静态 system + 动态状态块压尾以保前缀缓存（`systemPrompt.ts:1,32`）。
3. **双蒙版策略**：一处彩色编号给人/给模型看，一张二值蒙版给接口（`systemPrompt.ts:55-58`）——这比「涂一笔就重绘」精细一个量级。
4. **产物落地**：工作目录四件套（生成图片/素材/要求.md/需求规格.md），会话 = 项目文件夹（`projects.ts:64`）。Cherry 的 Agent 工作区只服务通用任务，绘画不落工作目录。
5. **上下文预算工程**：内联压缩 + 8MB 预算 + 空闲超时 + 失败原因落盘。
6. **低认知负担**：一屏三栏、单流程。Cherry 的九个入口对新用户是成本，对我们是机会。

---

## 4. 正在被侵蚀的地方

- **「能生图」不再是差异**：Cherry 对话里就能 `generate_image`，也能把 ComfyUI 工作流当模型用，还有 27 个绘画模板。用户感知上，「一句话出图」我们并不独特。
- **「能力强」正在被对方用工程量碾过**：对方有 66 家 provider 的**数据驱动注册表**（加模型零改 UI）、模型目录热更新（不发版就能上新模型）、MCP 市场、知识库、备份、自动更新、14 语言。
- **对方最弱的地方恰好是我们的强项**：无需求门、无版本链、图资产与会话弱绑定、草稿不落盘。这四点决定了「出片质量的可控性」，也就决定了我们的生存空间——但必须做得**显性**，否则用户感知不到。
- **反面教材**：Cherry V2 从 Redux+Dexie 大重写为 SQLite，代价是话题折叠回归、迁移恐慌、更新源事故（[#20014](https://github.com/CherryHQ/cherry-studio/issues/20014)、[#20808](https://github.com/CherryHQ/cherry-studio/issues/20808)、[#20028](https://github.com/CherryHQ/cherry-studio/issues/20028)）。**结论：我们不重写，只做渐进式数据层演进。**

---

## 5. 直接可抄的低成本高杠杆（设计思路，不是代码）

| 抄什么 | 对方怎么做的 | 我们怎么落 |
|---|---|---|
| 服务商注册表 JSON 化 | `providers.json` 描述 66 家、模型能力、图像参数表单，前端渲染 | 把 `types.ts` 里的硬编码抽成 `providers.json`：baseUrl 模板、默认端点、参数表单 schema（ratio/size/quality/n 上限）→ 加新模型零改 UI |
| 模型目录热更新 | 目录独立更新，不必发版 | 启动时拉一份远程 `models.json`（可离线兜底），新模型/新参数当天可用 |
| 绘画 Artboard + 模板库 | 27 个模板 + 画板 + 历史 Strip | 需求规格模板库（头像/海报/电商主图/壁纸/社交配图）+ 画板并排看多版本 |
| 排队追问 | 运行中可排队输入，跑完自动发 | 会话内消息队列（当前只能等本轮结束） |
| 文件引用计数清理 | 托管文件按引用管理，最后一个引用删除后延迟清理 | 资产引用计数 + 容量提示 + 可配置保留策略（当前资产只增不减） |
| 调用链诊断 | 开发者模式看请求/响应 | 「诊断包」：脱敏配置 + 最近日志 + 最近一次失败请求摘要 |

> ⚠️ **License 边界**：Cherry 是 AGPL-3.0，**不能复制其代码**进我们的 MIT 项目；只借鉴设计。反过来，MIT 对 B 端集成是优势，值得写进官网。

---

## 6. 不抄清单（守住定位）

翻译/划词、笔记、小程序、频道、Code CLI、通用知识库、定时任务（除「批量出图」）、多窗口分屏、自定义 CSS、通用 Agent 网关。

理由：这些每一项都是线性增长的维护成本，且都不服务于「出一张更好的图」。Cherry 做九入口是因为它有 411 个贡献者，我们只有一个人加一个模型。

**本轮也不做**（按已定决策）：跨平台打包、付费墙 / 订阅、MCP 市场、本机 API 网关、多语种框架。

---

## 7. 改进方案（四批，按性价比排序）

### P0 · 止血（1–2 天）

| # | 做什么 | 为什么 | 怎么落 | 验收 |
|---|---|---|---|---|
| 1 | 读损坏回退 `.bak` | 现在 JSON 坏了会静默空库 | 每次原子写保留 N 份轮转备份，加载失败自动回退并提示 | 手工损坏文件后仍能恢复会话 |
| 2 | 崩溃捕获 + 中断恢复 | run 状态只在内存，崩溃后对话卡在「运行中」 | `uncaughtException`/`unhandledRejection` 落 `crash.log`；启动时把未完成运行标为「已中断·可继续」 | 强杀进程后重启，界面可继续对话 |
| 3 | `ask_user` 超时 | 无超时（`askUser.ts`），不答则本轮永久挂起 | 默认 10 分钟无回答 → 自动选推荐项或结束本轮并说明 | 挂起 10 分钟后能继续 |
| 4 | 删会话取消运行 | `ipc.ts:62` 删会话不取消 run，后续消息成孤儿 | 删除时 abort 该会话 run 并清理 | 删运行中的会话不产生孤儿消息 |
| 5 | Key 失效提示 | 401/403 现在只报错 | 明确提示「Key 失效 → 去设置」并深链 | 错 Key 30 秒内可定位 |
| 6 | 单实例锁 + 深链接 | 双开会互相覆盖 JSON | `requestSingleInstanceLock` + `saydraw://session/:id` | 双击图标不产生第二实例 |

### P1 · 信任底座（2 周，v0.6.1）

1. **自动更新**：`electron-builder` 加 `publish`（GitHub Releases）→ `electron-updater`；首版只做「检查更新 + 下载 + 提示重启」，保留上一版可回滚。需签名（否则 SmartScreen 拦）。
2. **备份/迁移**：`.saydraw-backup.zip`（`app-data.json` + `settings.json`（Key 可选脱敏）+ 资产清单）；导入支持「合并 / 覆盖」；导出前自动快照。
3. **诊断包**：版本、系统、最近 200 条日志、脱敏配置、最近失败请求摘要（不含 Key 与图片）。
4. **命令面板 Ctrl+K**：新会话 / 切模型 / 打开工作目录 / 导入图片 / 导出当前 / 跳设置项。配套快捷键表。
5. **搜索**：跨会话消息全文 + 资产文件名 + 会话标题；资产面板加筛选。
6. **会话管理**：重命名/置顶/分组/归档/批量删除；用上已有的 `coverAssetId` 做封面。
7. **开源门面**：英文 README + 安装/设置页英文要点；**暂不做 i18n 框架**（垂直中文市场优先，等真有海外用户再抽文案）。
8. **首启引导**：填 Key → 选工作目录 → 说出需求，三步内出首图。

**验收**：新机器 5 分钟内出首图；备份能在另一台机器恢复并继续对话；断网启动不崩。

### P2 · 创作纵深（3–4 周，v0.7——这是真正的差异化）

| # | 做什么 | 关键设计 |
|---|---|---|
| 1 | **候选对比模式** | 一次 2–4 张（同模型多 seed 或多模型并行）→ 网格挑选 → 选中才入版本链，未选进「草稿」；`ImageAsset` 增 `batchId`/`draft` |
| 2 | **参数快照与复现** | `asset.meta = {model, provider, size, ratio, quality, format, seed?, referenceIds, prompt}`；右键「同参再生成 / 改一个参数 / 导出 .recipe.json / 复制提示词」 |
| 3 | **版本树 + A/B** | `parentId` 从单亲扩成「同父多子」分支；树视图 + 并排对比 + 批注（"这张偏暗"）→ 批注沉淀为负面样例注入下一轮（项目级 `preferences.json`） |
| 4 | **蒙版增强** | 区域列表（每个编号独立 instruction）、羽化/硬度、笔刷预设、扩图 outpaint、擦除、缩放平移 |
| 5 | **需求规格升级** | 槽位可直接编辑；模板库；`brief → prompt` 编译预览（用户可见可改）；槽位变更自动作废确认（代码已有 `confirmedAt` 清理） |
| 6 | **确认策略分级** | 把硬门变成用户可见的「创作策略：严格/标准/自由」，严格 = 现行为；每次门拦截写审计事件（新增 `gate-event`），既不烦人也不丢安全 |
| 7 | **交付族** | 同一图按 1:1 / 4:3 / 16:9 / 9:16 批量导出、尺寸预设、PNG/JPEG/WebP + 质量、水印/署名、导出清单 md（提示词+参数+版本路径）、命名规则 |
| 8 | **成本可见** | 模型单价（可配）× 张数/token 估算；会话累计 + 每轮摘要 |
| 9 | **风格配方（自 P3 提前）** | `StyleRecipe` = 提示词 + 参数 + 参考图集，可保存/导入/导出；品牌包（色板/logo/字体/禁用元素）；配方列表进右侧面板，一键套用 |

**验收**：同一需求从确认到定稿的中位轮次 ↓30%；同参复现成功率 100%；三种比例导出 ≤2 次点击；任一资产能回答「它用什么参数生成的」。

### P3 · 资产与专业工作流（1 个季度，v0.8）

- **素材库索引**：文件名/尺寸/标签/图像描述，给 Agent 一个 `search_assets` 工具；**不做通用 RAG**。
- **资产治理**：引用计数 + 保留策略 + 容量提示（借 Cherry 的 file-ref 思路）。
- **项目交付包**：工作目录 → zip + 清单 + 需求规格.md。
- **本地服务**：ComfyUI 作为一个生图 provider（复用现有 image connection 抽象）——垂直定位下的高价值钩子。
- **工程卫生**：平台相关继续收敛在 `main`（不打包跨平台，只保持架构不耦合）。

### P4 · 可选扩展（不排期，攒够信号再做）

- **联网检索**：只做「找风格 / 找素材参考」，必须带来源；不做通用搜索。
- **图像类 MCP 客户端**：只接图像工具一类（如本地图像处理服务），不做市场；等真实用户提需求。
- **不做**：私有网关、付费墙、团队订阅（按 D2 保持纯 MIT 开源）。
- **不做**：跨平台打包（按 D3 保持 Windows 深耕）。

---

## 8. 决策落定与影响

| # | 决策 | 结论 |
|---|---|---|
| D1 | 产品定位 | **垂直图像工作室**——用「确定性」换「功能数量」 |
| D2 | 开源与商业化 | **保持原样**：MIT 纯开源，不设付费层 |
| D3 | 平台 | **保持原样**：Windows 深耕 |

**由此产生的收敛：**

1. **P2（创作纵深）升为主线。** P1 只保留「让用户敢用」的项：自动更新、备份、诊断、Ctrl+K、会话管理、首启引导；i18n 框架、多窗口等降出本轮。
2. **模板库 / 风格配方 / 品牌一致性从 P3 提前到 P2。** 垂直工作室的护城河是「可复用的创作方法」，不是「接了多少家模型」。
3. **P4 只剩 2 个可选扩展**（联网找参考、图像类 MCP），删除私有网关、付费墙、团队订阅、跨平台、遥测上报。
4. **对外叙事统一成「图像创作工作室」**：README 首屏讲过程契约与产物目录，不讲模型数量。
5. **维护成本模型**：单人 + 模型 ⇒ 每加一个通用能力，就少一份打磨出图质量的时间；这条建议写进 CONTRIBUTING。


---

## 9. 度量（改完之后怎么判断有用）

首图确认轮次（目标 ≤2）· 生成→定稿中位耗时 · 废片率（未入链生成 / 总生成）· 候选选中率（入链 / 生成）· 同参复现成功率 · 模板使用率 · 配方复用率 · 导出转化率（出图→导出）· 7 日留存 · 更新到达率 · 崩溃率与恢复成功率。

---

## 10. 证据

**说画（源码）**

- 三道门：`src/main/agent/loop.ts:262-285`、`systemPrompt.ts:44-46`；迭代授权与消费 `loop.ts:346,506-510`
- 提示词手艺与双蒙版：`src/main/agent/systemPrompt.ts:1,32,55-58`
- 无迭代上限：`loop.ts:399`；并行工具白名单 `loop.ts:243`
- 数据层：`src/main/store/db.ts:35`（tmp+rename 全量写）、`settings.ts:20`（safeStorage）、`assets.ts:15`（parentId）、`projects.ts:64`（工作目录四件套）
- 上下文预算与超时：`src/main/store/inlineImage.ts`、`src/main/providers/http.ts:77`、`images.ts:56`
- 交付现状：`src/main/ipc.ts:133`（复制/另存为）
- 打包：`electron-builder.yml`（无 `publish`，仅 Windows NSIS + portable）

**Cherry Studio（公开资料）**

- 版本与发行：[v2.1.7](https://github.com/CherryHQ/cherry-studio/releases/tag/v2.1.7)（2026-10-19，296.4 MB setup）
- 服务商注册表：[providers.json](https://github.com/CherryHQ/cherry-studio/blob/main/packages/provider-registry/data/providers.json)
- 绘画页：[PaintingPage.tsx](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/pages/paintings/PaintingPage.tsx)；数据模型：[painting.ts](https://github.com/CherryHQ/cherry-studio/blob/main/src/main/data/db/schemas/painting.ts)（注释 frozen receipt，无 lineage）
- 知识库：[knowledge/README.md](https://github.com/CherryHQ/cherry-studio/blob/main/src/main/features/knowledge/README.md)
- 功能差异与迁移：[V1/V2 功能差异](https://docs.cherryai.com.cn/cherry-studio/installation/v1-v2-feature-differences.md)
- 能力地图（九入口）：[进阶能力地图](https://docs.cherryai.com.cn/advanced-basic/capability-map.md)
- Agent 工具与工作区：[内置工具、知识库、技能与 MCP](https://docs.cherryai.com.cn/advanced-basic/agent-workspace/tools-knowledge-skills-mcp.md)
- 社区反馈：[#20014](https://github.com/CherryHQ/cherry-studio/issues/20014)、[#20808](https://github.com/CherryHQ/cherry-studio/issues/20808)、[#20028](https://github.com/CherryHQ/cherry-studio/issues/20028)、[#20282](https://github.com/CherryHQ/cherry-studio/issues/20282)

> 待实测项：Cherry 绘画是否真支持蒙版局部重绘（文档称支持、v2.1.7 源码未见 inpaint/mask）；v2 是否已解决卡顿/内存问题；Midjourney 面板在 v2 的去留。

---

## 11. 实施进度（2026-10-21）

**已完成 · 生图能力（P2 的前两项，优先于一切）**

- 参数逐级降级：端点拒绝某个可选参数时只丢被拒的那个（`input_fidelity → output_format → quality → size`），并在结果里回报「请求 vs 实际」尺寸；修复「要 4K/16:9 却被静默降成 1024 方图」。实现：`src/main/providers/imageMeta.ts` + `images.ts`。
- 候选生成：`generate_image` 支持 `variants`（2–4），候选标 `draft`/`batchId`，画布「✓ 选用这张」转正；`variants` 为 1 时行为不变。
- 画质档位：`generate_image` / `edit_image` 支持 `quality` 覆盖（auto/low/medium/high）。
- 提示词层：新增「出图质量自检」五条（主体/尺寸/构图/易崩细节/避免元素）与候选挑选流程；要求如实汇报降级，不合格不许硬夸。
- 回归护栏：`npm run verify:image`（10 项）+ 集成测试（真起 mock 服务，验证「只拒 quality 时仍带 size」）。

**已完成 · P0 止血**

- 数据：`app-data.json` 落盘改为「先转 `.bak` 再写主文件」，启动时主文件解析失败自动回退 `.bak`，并把损坏/恢复/备份失败写进 `userData/logs/app.log`。
- `ask_user` 增加 10 分钟超时（超时按「用户未回答」收尾），不再永久挂起。
- 删除会话时先中止该会话运行中的 Agent，避免孤儿消息回写。
- 单实例锁：第二个实例 0.3 秒内退出并聚焦已有窗口，杜绝两个进程同时写同一份数据。
- 崩溃兜底：`uncaughtException` / `unhandledRejection` 落日志并在可用时弹窗告知日志位置，不再静默死掉。
- 鉴权失败归因：401/403 的错误信息直接给出「API Key 可能已失效/额度不足 → 去设置检查」。

**未做（按决策保留）**：i18n 框架、跨平台打包、付费层、MCP 市场、API 网关、遥测；「中断后恢复上次会话」的用户可见提示需要 UI 设计，暂缓。

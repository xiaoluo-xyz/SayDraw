# 说画 SayDraw — 对话式图片创作 Agent(Windows 桌面端 · 开源)

以工程文件夹为中心的桌面图像创作 Agent:多模态大模型理解需求与图像,多轮沟通收集需求、确认后调用生图模型创作;支持连续修图、蒙版局部重绘、多参考图融合与本地图片处理。任何 OpenAI / Anthropic 兼容模型服务均可接入。

![License](https://img.shields.io/badge/license-MIT-green) ![Platform](https://img.shields.io/badge/platform-Windows-blue) ![Version](https://img.shields.io/badge/version-0.5.1-violet)

## 功能

**Agent 能力**
- **需求收集与硬确认门**:对话补齐需求槽位(主体/风格/构图/色调/比例/用途),右侧面板实时展示;需求未经确认,编排层直接拦截生成请求——不依赖模型自觉
- **ask_user 问答面板**:决策类提问以选择题呈现(UI 面板作答,必带 ⭐ 推荐答案),自由输入兜底
- **迭代确认**:Agent 自判微调也必须先经用户确认才允许再次生成(编排层强制);用户指令的直接执行不重复确认
- **无限迭代**:工具调用次数不设上限,模型自判进度;每次生成/编辑的图片自动回传给模型自评
- **文件系统工具**:浏览目录 / 读写编辑文件 / 移动复制 / 导入本机图片;write_file、edit_file、process_image(本地格式转换/压缩/缩放,零额度消耗)
- **本地合成(¥0,像素级)**:`composite_image` 在应用内做**抠图去背景**、贴图、局部/整图换色与明暗、裁剪、圆角描边、多图拼接——不调用生图模型、不消耗额度、可重复。凡是"必须保持原件像素、不能重新画"的活(把主体从背景里抠出来、把自己的 logo/键帽/包装贴回生成图、只把某块区域改色)都走它;`inspect_grid` 提供 10×10 坐标网格参考图,让模型量准位置。产物在版本树里标「本地合成 · ¥0」,不显示模型名,也不提供「同参再生成」
- **抠图是"算"出来的,不是"画"出来的**:`cutout` 用「梯度墙 + 区域生长」把主体从背景里切下来(纯色/影棚底/真实照片带投影都能用,3072×4096 约 1.4 秒),支持透明底 PNG、指定底色、自动裁紧、边缘羽化;抠不干净时再用第二种方式——让生图模型只输出**黑白剪影蒙版**,本地按蒙版切**原图**像素。两条路都不重绘主体,键帽/铭牌/文字不会被模型改掉。只为看清细节而裁剪的分析图传 `inspect:true`,不进版本树
- **保真改图(只改该改的)**:换色分两条路——只挪色相/明度走 `composite_image.paint`(逐像素改写、保留原明暗,几何形状不可能变,可只选某种颜色、限定区域、排除徽标);白色件→黑色、亮面→哑光这类"材质本身变了"走 `edit_image` + `protect`,让模型按新材质重画,护栏只把模型结果当"区域内的补丁"贴回**用户最初上传的原图**(版本链根),区域外逐像素等于原图。`protect` 有三种圈法:`region`、`maskAssetId`,或 `auto:true`(不给选区也能护——把模型改动按连通块切开,留下成片改动,把桌面纹理这类零散噪点还原成原图,并回报"切成几块/留了几块/还原多少")。交付前用 `compare_image` 逐像素比对 + 差异热图(红=该改的,黄=不该动的),并回报「区域外改动 / 边界锚定率」
- **工作区(工作目录)**:可选、不强制——不选目录也能直接开画;选了之后左侧列表把该目录作为「总文件夹」归拢会话,目录右侧「＋」直接在其中新建会话,可折叠、可把会话移出工作区(只解关联,不删文件)。目录内容不预扫描、不导入:需要哪个文件就按路径本地读哪个
- **强制工作目录**(工程文件夹):自动创建 `生成图片/`(全部产出)、`素材/`(参考资产,Agent 可浏览识别并给创作建议)、`要求.md`、`需求规格.md`(随对话自动同步)
- **生图**:文生图、图生图编辑、蒙版局部重绘、**多参考图融合**(最多 16 张、单张 25MB、提示词 32000 字符,可在设置调整)
- **候选挑选**:首图/大改可一次出 2-4 张候选(`variants`),标「待选」不占版本链,用户在画布点「选用这张」才转正;候选比反复重抽更省时
- **画质档位**:每次生成可指定 `quality`(auto/low/medium/high),细节要求高时用 high,不必改全局设置
- **参数降级不连坐**:端点拒绝某个可选参数时只丢被拒的那一个(如只不支持 quality,分辨率与格式照旧保留),并在结果里如实回报「请求 vs 实际」尺寸,避免 4K/16:9 被静默降成 1024 方图
- **版本链**:每张编辑图记录来源,可回溯任意版本继续修改;双击图片打开可缩放查看器;右键复制/另存为
- **多会话并发**:会话间推理互不干扰,切走不中断,侧栏转圈标识运行中会话
- **块式对话 UI**:思考过程(生成中展开/结束自动折叠)、工具调用卡片(默认折叠,展开看参数与结果)、轮次计时与结束摘要

**模型接入(通用)**
- **连接分组 + 模型列表**的设置模型:一个分组 = 一个服务连接(地址 + Key 共享),下挂多个模型;左右布局管理,支持从 `/models` 拉取列表一键添加(自动带出上下文/输出/模态/推理档位参数)
- 语言模型:OpenAI 兼容 / Anthropic / OpenAI Responses 三规范(分组默认 + 模型级覆盖,中转站一个 Key 挂多规范模型)、上下文窗口(自动裁剪历史)、最大输出、多模态开关、思考模式与**推理强度档位(可增删的自定义列表)**
- 生图模型:端点路径、张数/参考图/单图/提示词上限、quality、输出格式、input_fidelity;可选参数被端点拒绝时自动降级重试
- **默认预置 DeepSeek 官方(deepseek-flash,只填 Key)+ GPT-Image-2(cf.api.fan)+ 智谱 CogView-4**;新建分组时可选模板一键填入官方配置(DeepSeek / OpenCode Go / 智谱 / 自定义)
- **OpenCode Go 网关兼容**:自动为 opencode.ai 请求附加稳定的 `x-opencode-session` 会话头与客户端标识(网关要求,缺失会被拒);三规范均可接入(gpt/grok 走 Responses)
- **请求地址智能拼接**:分组地址是基础地址,按模型规范自动拼端点(已含 /v1 等版本段直拼,否则补 /v1);模型配置可覆盖规范与实际请求路径,设置页实时预览最终 URL
- **上游故障自愈**:网关返回 5xx/限流/断连时,先在同一个模型上退避重试(0.6s、1.6s),仍不行就当轮临时改用后备模型继续(默认自动挑一个**其它连接**的模型,绝不改动你的「当前使用」),并在对话里写明「谁挂了、谁代跑」;配置/Key/协议类错误不浪费重试,直接指出该去设置哪里改。步骤全在对话里可见,失败时给的是「上游端点不可用(HTTP 503)· 建议… · 请求号…」而不是一句英文报错
- API Key 系统安全存储加密,保存在本机;流式输出(SSE)、思考流(reasoning_content / thinking_delta)解析

## 安装

| 方式 | 说明 |
|---|---|
| **直接双击** | [Releases](../../releases) 下载 `AIImage-x.x.x-portable.exe` 单文件绿色版 |
| 安装版 | `AIImage-x.x.x-setup.exe` NSIS 安装包 |
| 源码运行 | `npm install && npm run dev` |

> 首次使用:创建会话(工作目录可选:不选也能直接开画,选了就按目录归拢成工作区)→ 设置中填入 API Key(语言模型 DeepSeek 预置只需一个 Key)→ 对话描述需求 → 确认生成 → 继续对话修图 / 涂抹蒙版局部重绘。

## 技术栈

Electron 44(主进程 = Agent 编排)· React 19 + TypeScript + Zustand + Tailwind CSS 4 · Konva(蒙版笔刷)· electron-vite + Vite 7 · 零原生依赖(JSON 持久化)

## 架构

```
渲染进程(React)                        主进程(Agent 编排)
┌──────────────────────┐    IPC     ┌───────────────────────────────────┐
│ ChatPanel 块式对话     │ ◄────────► │ AgentLoop(无限迭代·模型自判)        │
│ QuestionPanel 问答面板 │  事件推送   │  ├ 硬确认门(需求未确认拦截)          │
│ Composer 简约输入栏    │            │  ├ 迭代确认门(微调需 ask_user 同意)  │
│ BriefPanel 需求槽位    │            │  └ ask_user 挂起问答               │
│ ImageCanvas 蒙版笔刷   │            ├ 工具×12:generate/edit_image        │
│ ImageViewer 缩放查看器 │            │  │  process_image·move/copy_file   │
│ VersionStrip 版本链    │            │  │  read/write/edit_file·ask_user… │
│ Settings 分组式模型管理 │            ├ Providers(OpenAI/Anthropic 双规范) │
└──────────────────────┘            │  ├ /models 元数据拉取·自动填参        │
                                    │  └ 可选参数被拒自动降级               │
                                    ├ 工作目录(生成图片/素材/要求/需求规格)  │
                                    └ Store(JSON+safeStorage+版本链)      │
```

## 开发

```bash
npm install        # Electron 二进制走 .npmrc 中的 npmmirror 镜像
npm run dev        # 开发模式(热更新;主进程改动需手动重启)
npm run typecheck  # 类型检查
npm run verify:image       # 生图参数降级逻辑自检(纯 node,不耗额度)
npm run verify:composite   # 本地合成内核单测(贴图/调色/圆角/拼接,纯 node)
npm run verify:fidelity    # 保真改图内核单测(换色/护栏/比对/热图,纯 node)
npm run verify:workspaces  # 工作区分组逻辑单测(纯 node)
npm run verify:recovery    # 上游故障归类 + 重试/后备模型编排单测(纯 node)
npm run verify:composite:live  # 本地合成端到端(真图 + 真工具,在 Electron 里跑,产出写 _shots/)
npm run verify:fidelity:live   # 保真改图工具层(paint/compare/protect 校验,不联网)
npm run verify:recovery:live   # 上游 503 自动重试/换模型端到端(本地 mock,不碰真服务,产出写 _shots/)
npm run verify:hardcases       # 困难图真实模型实测(会花钱:每个场景约 ¥0.35)
npm run dist       # 打包 portable + NSIS 安装包(dist-release/)
```

生图参数降级(`size` / `quality` / `output_format` 被端点单独拒绝时只丢那一个):`npm run verify:image` 校验"只拒 quality 时不连坐 size"这条核心行为。

测试:`scripts/mock-server.mjs` 提供本地 mock 模型服务(OpenAI/Anthropic/Responses 三规范,带 `/__stats` 观测与 `/__mode` 故障注入),`scripts/verify-fix.cjs` 在 Electron 里直接跑真实主进程代码,校验图片内联压缩、请求体预算与失败留痕(**全程只用系统临时目录,不读写用户数据**):

```bash
node scripts/mock-server.mjs                 # 终端 A
node_modules\.bin\electron scripts\verify-fix.cjs   # 终端 B
```

`scripts/e2e-driver.mjs` 是 v3 设置结构之前的旧脚本(仍是扁平 profile 写法),尚未同步,别直接在正在使用的实例上跑。

## 上下文与请求体积

送模型的图片一律不用原图:主进程先把图缩到长边 ≤1280(蒙版/透明图放宽到 ≤4096,且平色透明图优先原样直传)、单张 base64 后 ≤1.5MB,再内联进对话请求;一次请求的内联图片总量另有 8MB 预算,超出的旧图不进请求、只在文本标注里留痕。磁盘上的原图始终不动,生图/编辑/蒙版用的都是原图。

对话请求用**空闲超时**(设置里的「对话空闲超时」,默认 120s:连续这么久没有数据返回才中断)而不是整请求硬 deadline —— 长回答/长思考不再被误判成超时;另有 15 分钟总上限兜底。失败时会把归类后的诊断写进消息:标题(如「上游端点不可用 · HTTP 503 · OpenCode Go/deepseek-v4.1-flash」)、该去做什么、网关请求号、可展开的原始报错,并带一键「重试」;抖动类失败在落这条消息之前就已经自动重试/换过模型了。

## 目录结构

```
src/
├── shared/          # 跨层类型契约(连接分组/模型/会话/消息/资产/Brief/事件)
├── main/            # 主进程:agent(循环/提示词/工具/确认门/ask_user)、providers、store、ipc
├── preload/         # contextBridge 类型化 API
└── renderer/src/    # React:components、stores(zustand)、lib
```

## 设计笔记

踩过的坑与取舍都留了记录,改动前建议先看一眼:

- [抠图方案:为什么不能靠重绘](docs/抠图方案-为什么不能靠重绘.md) —— 三种自动抠图算法的实测对比、蒙版方案、以及"失败重试不该消耗授权"等复盘
- [保真改图:困难图清单与护栏方案](docs/保真改图-困难图与护栏方案.md) —— 哪些图 AI 一定改坏、为什么"事后比对"不够、paint/protect(含 auto 自动护栏)/compare 三层方案,以及"白键帽换黑:涂色 vs 换材质"的真实模型实测
- [对话上游故障:分析与修复](docs/对话上游故障-分析与修复.md) —— HTTP 503 到底是哪一层的问题、重试/后备模型策略
- [本地合成可行性](docs/本地合成-可行性.md) —— 为什么用自研像素内核而不是 sharp,以及 P0 实施记录

## License

[MIT](./LICENSE)

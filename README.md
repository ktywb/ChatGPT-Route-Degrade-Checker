# ChatGPT Route & Degrade Checker (v7.2)

> A lightweight, zero-dependency UserScript for ChatGPT Web (`chatgpt.com` / `chat.openai.com`) to detect **Harmony vs. Codex/cca runtime routing**, **hard model downgrades**, **DIL/GenUI component payloads**, **thinking-budget anomalies**, **Regenerate pipeline switches**, and **Sentinel / exit-IP risk signals** in real time.

一款用于 **ChatGPT Web 端** 的轻量级油猴检测脚本（`@grant none`、零外部依赖），在页面内实时监测每一次对话请求的真实后端路由与运行时状态，帮助你区分 **硬降级、软降级、运行时分流（Harmony vs. Codex/cca）** 与 **风控/出口环境风险**。

---

## 核心功能

### 1. 运行时管线识别（Harmony vs. Codex/cca）
* 实时捕获 SSE 流与元数据中的 `server_ste_metadata`、`turn_analytics` 及助手消息 `metadata`。
* 自动识别当前轮次命中的运行时指纹：
  * `harness`（如 `Harmony` 主线管线 vs. `Codex` 精简 Agent 管线）
  * `runtime_source`（如 `cca`）
  * `chime_version`（如 `v1` vs. `v3`）
  * `cluster_region`、`warmup_state`、`conduit_prewarmed`、`tool_name`（如 `SonicBrowserTool`）
* 面板顶部以独立横幅高亮展示当前运行时状态，避免将 `Codex/cca` 默认不下发 `resolved_model_slug` / `model_dil_v2` 误判为归因链损坏。

### 2. 模型硬降级与归因链核验
* 对比请求侧（`model`、`thinking_effort` / `reasoning_effort`）与响应侧（`resolved_model_slug`、`server_ste_metadata.model_slug`、`assistant.metadata.model_slug`、`default_model_slug` 及 DOM `data-message-model-slug`）。
* 支持按模型家族与档位（区分标准版与 `mini` / `nano` / `lite` / `micro` / `small`）校验是否发生**路由硬降级**，并对 `auto-thinking` 自动推理路由做豁免处理。

### 3. DIL (`model_dil_v2`) 与 GenUI (`genui_components`) 载荷解析
* 兼容直接字段与 `delta_encoding` v1 增量 JSON-Patch 流（自动隔离 batch patch 包装层，避免补丁数组污染载荷统计）。
* 自动从 `model_dil_v2.code` 中正则提取实际渲染的 `__dil.jsx(...)` 组件标签与更新次数，并统计 `genui_components` 的结构类型与元素数量。

### 4. 思考预算与输出指纹监测
* 统计并展示**思考时长**（优先采用服务端 `finished_duration_sec`，否则回退到推理流起止时间戳）、思考字数、首包延迟（TTFT）、总耗时、输出字数、段落数、生成速率（字/s）、`finish_details`、工具调用列表及富元素（表格、代码块、引用、GenUI）。
* 自动识别常见**软降级旁证**：
  * 请求了思考模式但未观测到思考链；
  * 思考极短（`< 2.0s`）且正文偏短（`< 350` 字）；
  * 非 `stop` 异常结束；
  * 非 `Codex/cca` 管线下依然缺失 `model_dil_v2` 与 `genui_components`。

### 5. 轮次对比与 Regenerate 管线切换检测
* 在内存中保留最近 10 轮快照，自动计算本轮与上一轮的字数差、思考时长差、新增工具及运行时切换（例如 `Codex/cca → Harmony`）。
* 当点击 **Regenerate**（`action: "variant"`）后出现运行时切换、归因链恢复、字数或思考时长大幅跃升时，主动标出变化详情。

### 6. Sentinel 风控与同源出口检测
* 被动监听 `sentinel/chat-requirements` 响应，解析：
  * **PoW 难度**：统计最近 12 次有效十六进制位数的中位数（`≥ 5` 位正常、`4` 位中风险、`≤ 3` 位高风险）；
  * **`persona`**（识别 `free` / `noauth` / `anon` / `degrad` 等异常降级画像）；
  * **`Turnstile` / `Arkose` / `ForceLogin`** 校验标记。
* 主动请求同源 `/cdn-cgi/trace` 获取真实出口 IP、国家/地区（`loc`）、Cloudflare 节点（`colo`）及 WARP 状态，并提供一键跳转 `bgp.he.net` 核验 ASN；同时尝试通过公开 IP 接口识别住宅 ISP 与数据中心/云厂商/VPN 出口。

### 7. 内置 4 维度探针 & 一键导出诊断 JSON
* **复制诊断 JSON**：一键复制当前轮次的完整诊断报告（包含 `routeStatus`、`softSignals`、`currentTurn`、原始 `rawServerSteMetadata` / `rawTurnAnalytics` / `rawAssistantMeta`、`prevTurnDiff`、`sentinel`、`env`、`account` 及最近 5 轮精简历史），便于对照账号或提交工单分析。
* **复制新版探针（4 维度）**：内置 4 条标准测试提示词，一键复制到剪贴板：
  1. **工具链与富媒体能力**：以表格列出当前可用工具，对比账号工具差异；
  2. **多约束深度推理**：球类最坏情况构造证明题（防题库背诵，检验真实推理深度）；
  3. **抗模板化长输出**：MESI 与目录协议多维剖析（含表格 + ASCII 状态图，检验是否被锁精简模板）；
  4. **双 Bug 隐蔽代码审查**：Python 限流器代码审查（检验是否能同时发现原地 `remove` 跳元素与边界/竞态问题）。

### 8. 悬浮面板交互
* 支持鼠标/触控拖拽，支持收起为贴边竖条标签（带实时状态色点），位置与折叠状态持久化保存在 `localStorage`（`crc-v7-ui`）。
* 支持**自动收起**开关（点击面板外部或展开后 `1–600` 秒自动收起，默认 `15` 秒）。

---

## 状态色点说明

| 状态 | 含义 |
| --- | --- |
| 🟢 绿色 | Harmony 主线、思考链与环境均正常 |
| 🟣 紫色 | `Codex/cca` 运行时分流（模型一致，但该管线默认无 DIL / Intelligent UI） |
| 🔵 蓝色 | 本轮正在生成中，等待流结束统计 |
| 🟡 黄色 | 归因链不完整、路由字段全缺、存在一般软降级旁证或出口/风控风险高 |
| 🟠 橙色 | 触发强软降级或高危风控信号（如思考链缺失、异常 Persona、Arkose/ForceLogin、Regenerate 显著跳变） |
| 🔴 红色 | 路由硬降级（请求模型与实际执行模型家族或档位不符） |
| ⚫️ 灰色 | 等待发送一条新消息 |

---

## 安装方法

1. 安装浏览器脚本管理器（推荐 **Tampermonkey** 或 **Violentmonkey**）。
2. 新建用户脚本，将仓库中的 `.user.js` 源码完整粘贴并保存（或直接点击 GitHub Raw 链接安装）。
3. 打开或刷新 [`https://chatgpt.com/`](https://chatgpt.com/)，右下角将出现悬浮监测面板（或贴边收起标签）。

> **兼容性说明**：脚本使用 `@run-at document-start`、`@sandbox raw` 与 `@grant none`，以便在页面初始化前挂载 `fetch` / `WebSocket` / `sendBeacon` 监听。请确保脚本管理器允许在 `chatgpt.com` 上尽早注入。

---

## 工作原理与隐私说明

* **纯本地被动观测**：脚本通过包装页面内的 `window.fetch`、`window.WebSocket`、`navigator.sendBeacon` 以及 `MutationObserver` 读取对话接口响应与 DOM 属性，**不修改请求参数，不向任何第三方服务器回传对话内容、Cookie 或 Token**。
* **仅有的额外网络请求**（均用于“3. Sentinel 风控与同源出口”模块，可在面板手动点击“刷新”重新查询）：
  * 同源 `GET /cdn-cgi/trace`（`credentials: "omit"`，不携带登录态 Cookie）；
  * 依次尝试公开 ASN 查询接口（`ipwho.is` / `ipapi.co` / `ipinfo.io`），用于判断出口是否为数据中心/云/VPN。若被浏览器隐私策略或页面 CSP 拦截，会安全降级为“待人工核验”，不影响其他功能，可直接点击旁边的 `查ASN` 链接手动查看。
* **公开分享前请注意脱敏**：点击“复制诊断 JSON”导出的内容中，可能包含你的出口 IP（`env.traceIp`）、`request_id`、`turn_trace_id` 及原始 `server_ste_metadata`。在发往公开社区或 GitHub Issue 前，建议先检查并按需抹除出口 IP 等个人信息。

---

## 常见问题

**Q：为什么 `ASN 归属` 显示“被页面 CSP 或网络拦截”？**
部分浏览器或 ChatGPT 页面的内容安全策略（CSP）会拦截向第三方 IP 查询域名发起的 `fetch` 请求。这是正常保护机制，不影响同源 `/cdn-cgi/trace` 出口 IP 获取，点击 IP 右侧的 `查ASN` 链接即可在 `bgp.he.net` 手动核验。

**Q：为什么 `Codex/cca` 模式下 `resolved_model_slug` 和 `model_dil_v2` 显示未返回？**
在观测中，`harness: "Codex"` / `runtime_source: "cca"` 管线默认不会像 `Harmony` 主线那样下发 `resolved_model_slug` 或 `model_dil_v2` 组件。因此 v7.2 将其单独识别为紫色状态，避免与真正的模型硬降级混淆。

**Q：为什么 `Turnstile` 显示为“常态”而不是告警？**
ChatGPT Web 端当前对绝大多数正常会话都会启用 Cloudflare Turnstile，因此脚本将其视为常规项展示，仅对 `Arkose`、`ForceLogin`、低位 PoW 难度及异常 `persona` 触发高风险提示。

---

## 免责声明与许可

* 本脚本仅用于个人排查 ChatGPT Web 端路由、渲染组件与网络环境问题，与 OpenAI 无任何关联。
* 若 ChatGPT 前端协议、SSE 字段名或元数据格式更新，部分字段捕获可能需要同步维护。
* License: **MIT**

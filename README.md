# dsh-zhipu-provider

DSH（DeepSeek Harness）插件（双半面 bundle），一个包交付两件事：

1. **provider 播种**：启动时把本插件的 provider 路由 **`zhipu-coding-plan`**（智谱 Coding Plan，OpenAI 兼容 coding 端点）**播种（seed）到 `llm-pi-ai` 的用户设置层**——与 Web Models 页「自定义模型 API」卡片完全同一条写入路径（按 provider 键合并，不整段覆盖），因此与其他拥有 `llm-pi-ai` patch 行的插件（如 `dsh-plugin-custom-providers`）**互不覆盖、bundle 层序不再敏感**。路由定义迁自 `dsh-plugin-custom-providers` 的 `zhipu-coding-plan` 段，逐字段一致。
2. **用量展示**：Web GUI 底部状态 pill（`conversation.composer.dock`，与官方「会话统计 / Token 用量」、plan-usage 套餐 pill、raven-usage pill 同一座位链，order 15）——**仅当前会话选用 `zhipu-coding-plan` provider 时显示**；pill 显示配额百分比摘要，点击开面板展示 5 小时窗口 / 每周 / MCP 月度配额明细与重置时间。数据经 host 半面 `/api/zhipu-usage/*` 同源路由取自智谱开放平台。

## 用法

### 安装

```powershell
dsh plugin --profile web add ./dsh-zhipu-provider
```

`dsh plugin` 会把包 link 进 profile 并追加到 `dsh.profile.bundles`。host 半面模块代码变更需重启 `dsh web` 生效（模块 import 发生在启动时）；patch 结构变更走 `patchReload: live` 热重组。可用 `dsh --profile web --dump-config` 检查合成结果。

### 凭证配置

智谱 Console Key 只通过 `apiKeyEnv` 引用的环境变量或 DSH 凭证机制存放，不入库、不写入日志：

- 默认引用名 **`ZHIPU_CODING_PLAN_API_KEY`**（与 `dsh-plugin-custom-providers` 注册的路由同一把钥匙，零新增配置）：在设置页录入，或设置该环境变量；
- 未配置凭证时 pill 显示「未配置」态并给出指引。

### 使用

安装并重启 Web GUI 后：

- 模型选择器中可出现智谱的模型（`glm-5.3` / `glm-5.3-flash`，providers 生效）；
- 会话选用智谱模型时，输入卡片下方出现智谱用量 pill：摘要段显示 5 小时窗口 / 每周配额百分比（达到 90% 阈值标红）；点击弹出面板查看各配额的已用 / 总量 / 剩余、进度条与重置时间，套餐名（`data.level`）显示在面板标题。

### 设置项

行 config（`cordis.patch.yml`）只传 `usage.pollIntervalMs` / `usage.requestTimeoutMs`；schema 默认值：`apiKeyEnv: ZHIPU_CODING_PLAN_API_KEY`、`baseUrl: https://open.bigmodel.cn`（国际站 `https://api.z.ai` 可覆盖 baseUrl）、`pollIntervalMs: 0`（默认关闭自动轮询，手动/面板刷新为主）。

## 工作机制

- **播种**：本插件不拥有 `llm-pi-ai` 的 patch 行（patch 对目标行是整行替换 `config`，多个 bundle 的 providers 字典无法在 patch 层合并）。宿主半面（`src/index.ts`）在 loader settle 后经 settings 服务 `describe()` 读生效配置，`zhipu-coding-plan` 路由不存在时 `settings.update('llm-pi-ai', { providers: { 'zhipu-coding-plan': … } })` 合并进用户层（幂等，二次启动不重写）；路由已存在（无论来自哪个层，含 custom-providers 的 bundle 层注册）即跳过，用户在 Models 页的编辑永不被覆盖。
- **用量数据流**：host 半面经 DSH 凭证机制按 `apiKeyEnv` 现解析智谱 Console Key（每次刷新现读，热轮换友好；未配置 → `unconfigured` 快照），直连 `GET {baseUrl}/api/monitor/usage/quota/limit`（Bearer 优先、401 回退裸 token 重试一次），归一化为统一配额模型缓存在内存；经 `/api/zhipu-usage/*` 路由暴露；client 半面渲染 pill 与弹出面板。接口契约与解析逻辑迁自 `dsh-plugin-custom-providers` 的 `src/providers/zhipu.ts`（含 2026-09-28 线上实测的数量语义与旧协议判别）。
- **pill 显隐**：座位 inject 面绑定会话模型目录（官方 `ui-model-selection`），非智谱会话渲染 `null` 但组件保持挂载、取数保温，切到智谱即刻有数据（机制同 raven-usage / plan-usage）。

### 与 dsh-plugin-custom-providers 的关系

- 同一路由 id（`zhipu-coding-plan`）、同一把凭证、同一套定义：两者可共存，播种对「路由已存在」自动让位；若先装本插件（用户层路由已播种），custom-providers 的 bundle 层注册被用户层遮蔽但语义一致；
- plan-usage（custom-providers 的三家套餐面板）仍可用；本插件的 pill 是智谱单平台的独立实现（同一座位 order 15，排 plan-usage 右侧）。

## 构建与测试

```powershell
pnpm install
pnpm run build    # tsdown → lib/index.js + lib/client.cjs → 包装为 lib/client.js
pnpm test         # node --import tsx test/run-all.ts
```

开发期：`pnpm run dev`（tsdown watch）+ `pnpm run dev:client`（跟随重建包装 client.js）。

## 凭证纪律

智谱 API Key 只存放于 DSH 凭证机制或 `apiKeyEnv` 引用的环境变量，不入库、不写入日志与文档。

# dsh-zhipu-provider

DSH（DeepSeek Harness）插件：为 Web GUI 接入智谱 Coding Plan（智谱 OpenAI 兼容 coding 端点），并附带用量展示。

## 功能

- **provider 播种**：启动时把 `zhipu-coding-plan` 路由写入 `llm-pi-ai` 用户设置层——与 Models 页「自定义模型 API」卡片同一条写入路径，按 provider 键合并，与其他插件互不覆盖；模型选择器随即出现 `glm-5.3` / `glm-5.3-flash`。
- **用量 pill**：会话选用智谱模型时，输入卡片下方显示用量 pill——摘要为 5 小时窗口 / 每周配额百分比（≥90% 标红），点击弹出面板查看各配额已用 / 总量 / 剩余与重置时间，标题带套餐名。数据取自智谱开放平台。

## 用法

```powershell
dsh plugin --profile web add ./dsh-zhipu-provider
```

> link 安装指向的目录内需有 `node_modules`（在该目录执行一次 `pnpm install`），否则启动报 `failed to import`。

1. 配置凭证：在设置页录入智谱 Console Key，或设置环境变量 `ZHIPU_CODING_PLAN_API_KEY`；
2. 重启 `dsh web`，选用智谱模型即见 pill；未配置凭证时 pill 显示「未配置」并给出指引。

可选设置（覆盖 schema 默认值）：`baseUrl`（默认 `https://open.bigmodel.cn`，国际站用 `https://api.z.ai`）、`usage.pollIntervalMs` / `usage.requestTimeoutMs`（默认 0，关闭自动轮询，以手动刷新为主）。

## 开发

```powershell
pnpm install
pnpm run build
pnpm test
```

> API Key 只存放于 DSH 凭证机制或 `apiKeyEnv` 引用的环境变量，不入库、不写入日志与文档。

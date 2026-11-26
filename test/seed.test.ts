// 播种器静态校验：
// 1. 种子 profile 满足 llm-pi-ai 手写路由的硬性要求（api、baseURL、非空
//    models —— 缺失会提交到 Host 才被拒）；
// 2. 迁移基准守卫：关键字段与 dsh-plugin-custom-providers 的
//    zhipu-coding-plan 基准一致（含无 compat 段），新上架模型按智谱官方
//    文档规格跟进；
// 3. patch 不目标 `llm-pi-ai` 行（多 bundle 覆盖问题的回归守卫）；
// 4. shouldSeed 判定：路由缺失或与种子不深度一致（任意层来源）即覆写，
//    深度一致才跳过；
// 5. apply 等 loader settle 后再注册用量路由（挂载顺序回归守卫）；
// 6. seed 对不匹配路由经 settings 服务覆写为种子（apply 级回归守卫）；
// 7. 凭证缺失时 usage 路由返回 unconfigured 快照（不报错）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, ROUTE, seedProfile, shouldSeed } from '../src/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('seed profile satisfies the hand-declared route requirements', () => {
  const profile = seedProfile()
  assert.ok(profile.api.length > 0, 'api 必填')
  assert.ok(/^https?:\/\//.test(profile.baseURL), 'baseURL 必须是 http(s) URL')
  assert.ok(profile.apiKeyEnv.length > 0, 'apiKeyEnv 必填（凭证引用名）')
  assert.ok(profile.models.length > 0, '手写路由至少一个模型，否则 Host 以 resolves no models 拒绝')
  for (const model of profile.models) {
    assert.ok(model.id.length > 0, '模型 id 必填')
    assert.ok(model.contextWindow > 0, '模型 contextWindow 必须为正')
    assert.ok(model.input.length > 0, '模型 input 非空')
    assert.ok(Object.keys(model.reasoningEfforts).length > 0, '模型需声明推理等级映射')
  }
})

test('seed profile matches the zhipu-coding-plan baseline plus GLM-5.4', () => {
  // 迁移基准：repos/dsh-plugin-custom-providers/cordis.patch.yml 的 zhipu-coding-plan 段；
  // 模型断言按 id 分组（不依赖列表顺序，新模型置顶不影响基准）
  const profile = seedProfile()
  assert.equal(profile.displayName, 'Zhipu Coding Plan')
  assert.equal(profile.apiKeyEnv, 'ZHIPU_CODING_PLAN_API_KEY')
  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.baseURL, 'https://open.bigmodel.cn/api/coding/paas/v4')
  assert.equal(profile.reasoning, 'max')
  assert.deepEqual(
    profile.models.map((m) => m.id),
    ['glm-5.4', 'glm-5.3', 'glm-5.3-flash'],
  )
  const byId = new Map(profile.models.map((m) => [m.id, m]))
  // GLM-5.4 规格据智谱官方文档 glm-5.4 页与「如何切换模型」：多模态输入、
  // 思考档位 low/high/max；模型本体 1M 上下文、128K 最大输出
  const glm54 = byId.get('glm-5.4')!
  assert.equal(glm54.name, 'GLM-5.4')
  assert.equal(glm54.contextWindow, 1000000)
  assert.equal(glm54.maxTokens, 128000)
  assert.deepEqual(glm54.input, ['text', 'image'])
  assert.deepEqual(glm54.reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
  // 基准两模型沿用迁移定义
  assert.deepEqual(byId.get('glm-5.3')!.reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(byId.get('glm-5.3')!.input, ['text'])
  assert.deepEqual(byId.get('glm-5.3-flash')!.input, ['text', 'image'])
  // 基准定义无 compat 段（与 kimi/bailian 不同），迁移保持一致
  assert.ok(!('compat' in profile), 'zhipu-coding-plan 基准定义无 compat 段')
})

test('patch inserts own row and never targets the llm-pi-ai row', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('- id: dsh-zhipu-provider'), 'patch 应插入 dsh-zhipu-provider 自身挂载行')
  assert.ok(!/^\s*-\s+id:\s*llm-pi-ai\s*$/m.test(patch),
    'patch 不得目标 llm-pi-ai 行（整行替换会覆盖其他 bundle 的 providers）')
})

test('shouldSeed overwrites when the route is missing or does not match the seed', () => {
  // 缺失 / 其他路由 → 需要播种
  assert.equal(shouldSeed(undefined), true)
  assert.equal(shouldSeed({}), true)
  assert.equal(shouldSeed({ 'kimi-coding-plan': {} }), true)
  // 与种子深度一致（无论来自哪个层）才跳过
  assert.equal(shouldSeed({ 'zhipu-coding-plan': seedProfile() }), false)
  // 存在但不匹配：空对象 / 滞后快照（缺新模型）/ 用户编辑 → 覆写为种子
  assert.equal(shouldSeed({ 'zhipu-coding-plan': {} }), true)
  const stale = seedProfile()
  stale.models = stale.models.slice(1)
  assert.equal(shouldSeed({ 'zhipu-coding-plan': stale }), true)
  const edited = seedProfile()
  edited.displayName = 'My Zhipu'
  assert.equal(shouldSeed({ 'zhipu-coding-plan': edited }), true)
})

test('seed overwrites a mismatched route through the settings service', async () => {
  // apply 级守卫：生效路由与种子不一致（如滞后快照缺新模型）时，
  // 经 settings.update 按 provider 键覆写为种子；一致时不产生写入。
  const updates: Array<[string, unknown]> = []
  const makeSettings = (mismatch: boolean) => ({
    describe: () => [
      { ns: 'llm-pi-ai', value: { providers: { 'zhipu-coding-plan': mismatch ? {} : seedProfile() } } },
    ],
    update: async (ns: string, patch: unknown) => {
      updates.push([ns, patch])
    },
  })
  const makeCtx = (mismatch: boolean) => ({
    logger: { warn: () => {}, info: () => {} },
    loader: { await: async () => {} },
    get: (n: string) => (n === 'settings' ? makeSettings(mismatch) : undefined),
    interval: () => () => {},
    effect: () => {},
  })
  // 不一致 → 恰好写入一次，payload 为种子
  apply(makeCtx(true), resolvedConfig())
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(updates.length, 1, '不匹配时应恰好写入一次')
  const [ns, patch] = updates[0] as [string, { providers: Record<string, unknown> }]
  assert.equal(ns, 'llm-pi-ai')
  assert.deepEqual(patch.providers[ROUTE], seedProfile())
  // 一致 → 不再写入
  apply(makeCtx(false), resolvedConfig())
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(updates.length, 1, '与种子一致时不应写入')
})

test('apply defers usage API setup until loader settles (mount-order fix)', async () => {
  // 回归守卫（dsh-plugin-raven v0.6.0 首版缺陷）：apply 期 ctx.get('connection')
  // （strict）只返回 ACTIVE 实现，而 apply 时 connection 尚未挂载——立即取会
  // 拿到 undefined，路由不注册，pill 取数 404。正确行为：等 loader settle 再取。
  const routes: string[] = []
  let settled = false
  const connection = { fetch: { register: (r: { path: string }) => { routes.push(r.path); return () => {} } } }
  const mockCtx = {
    logger: { warn: () => {}, info: () => {} },
    loader: { await: async () => { settled = true } },
    get(name: string) {
      // 仅在 loader settle 后才提供 connection（模拟挂载顺序）
      return name === 'connection' && settled ? connection : undefined
    },
    interval: () => () => {},
    effect: () => {},
  }
  apply(mockCtx, resolvedConfig())
  assert.equal(settled, true, 'loader.await 已被消费')
  // 等待微任务链（loader.await().then(...)）落定
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(routes.includes('/api/zhipu-usage/usage'), 'settle 后应注册 usage 路由')
  assert.ok(routes.includes('/api/zhipu-usage/refresh'), 'settle 后应注册 refresh 路由')
  assert.equal(name, 'dsh-zhipu-provider')
})

test('usage routes report unconfigured when the credential seam is absent', async () => {
  const handlers = new Map<string, () => Promise<Response>>()
  const connection = {
    fetch: { register: (r: { path: string; fetch: () => Promise<Response> }) => { handlers.set(r.path, r.fetch); return () => {} } },
  }
  let settled = false
  const mockCtx = {
    logger: { warn: () => {}, info: () => {} },
    loader: { await: async () => { settled = true } },
    get(name: string) {
      if (name === 'connection' && settled) return connection
      if (name === 'credentials') return undefined // 凭证服务缺失 → unconfigured
      return undefined
    },
    interval: () => () => {},
    effect: () => {},
  }
  apply(mockCtx, resolvedConfig())
  await new Promise((resolve) => setTimeout(resolve, 0))
  const handler = handlers.get('/api/zhipu-usage/usage')
  assert.ok(handler, 'usage 路由已注册')
  const res = await handler()
  const body = (await res.json()) as { snapshot: { status: string; quotas: unknown[] } }
  assert.equal(body.snapshot.status, 'unconfigured')
  assert.deepEqual(body.snapshot.quotas, [])
})

/** apply 收到的是 schema 解析后的完整 config，测试直接给等价形状 */
function resolvedConfig() {
  return {
    usage: {
      apiKeyEnv: 'ZHIPU_CODING_PLAN_API_KEY',
      baseUrl: 'https://open.bigmodel.cn',
      pollIntervalMs: 0,
      requestTimeoutMs: 1000,
    },
  }
}

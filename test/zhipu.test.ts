// 智谱用量适配器与 store 行为校验：
// 1. parseZhipuQuota：现行/旧协议各形态（fixtures 迁自 dsh-plugin-custom-providers
//    的 zhipu-parse.test.ts，含 2026-09-28 线上快照回归）；
// 2. fetchZhipuUsage：Bearer 优先、401 回退裸 token、限流/超时归类（fetchImpl stub 不触网）；
// 3. UsageStore：成功快照、失败保留 stale、未配置态、ensureFresh 幂等。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AdapterError, AdapterUnconfiguredError } from '../src/model.ts'
import { fetchZhipuUsage, parseZhipuQuota } from '../src/zhipu.ts'
import { UsageStore } from '../src/store.ts'

// 现行 v2 积分制协议（2026-09-28 线上快照）
const OK_CREDIT = {
  success: true,
  code: 0,
  msg: 'ok',
  data: {
    level: 'lite',
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 1999, currentValue: 42, remaining: 1957, percentage: 2, nextResetTime: 1759088797343 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 9999, currentValue: 3596, remaining: 6403, percentage: 35, nextResetTime: 1759204882973 },
    ],
  },
}

// ---------------------------------------------------------------------------
// parseZhipuQuota
// ---------------------------------------------------------------------------

test('parseZhipuQuota maps window-5h / weekly / MCP monthly quotas, level → planName', () => {
  const r = parseZhipuQuota({
    success: true,
    code: 0,
    msg: 'ok',
    data: {
      level: 'pro',
      limits: [
        {
          type: 'TOKENS_LIMIT', unit: 3, number: 5,
          currentValue: 12000, remaining: 9360, percentage: 22,
          nextResetTime: 1715257200000,
        },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, currentValue: 60000, remaining: 60000, percentage: 0 },
        { type: 'TIME_LIMIT', currentValue: 300, remaining: 280, percentage: 6.7 },
      ],
    },
  })
  assert.equal(r.planName, 'pro')
  assert.equal(r.quotas.length, 3)
  const [w5, wk, mcp] = r.quotas
  assert.equal(w5.kind, 'window-5h')
  assert.equal(w5.limit, 12000)
  assert.equal(w5.remaining, 9360)
  assert.equal(w5.percentUsed, 22)
  assert.equal(w5.used, 2640)
  assert.equal(w5.resetAt, new Date(1715257200000).toISOString())
  assert.equal(wk.kind, 'weekly')
  // usage 缺失 + percentage 对上「总量读法」→ 旧协议：currentValue=总量，已用=总量-剩余
  assert.equal(wk.limit, 60000)
  assert.equal(wk.used, 0)
  assert.equal(wk.remaining, 60000)
  assert.equal(mcp.kind, 'monthly')
  assert.equal(mcp.label, 'MCP 工具配额')
})

test('parseZhipuQuota classifies unmatched unit/number as other', () => {
  const r = parseZhipuQuota({
    success: true,
    data: { limits: [{ type: 'TOKENS_LIMIT', unit: 1, number: 1, currentValue: 5 }] },
  })
  assert.equal(r.quotas[0].kind, 'other')
})

test('parseZhipuQuota maps CREDIT_LIMIT protocol (2026-09) to window-5h / weekly', () => {
  const r = parseZhipuQuota({
    success: true,
    code: 0,
    data: {
      level: 'lite',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 440, remaining: 1560, percentage: 22, nextResetTime: 1758735600000 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 9999, currentValue: 3596, remaining: 6403, percentage: 35, nextResetTime: 1758735600000 },
      ],
    },
  })
  assert.equal(r.planName, 'lite')
  assert.equal(r.quotas[0].kind, 'window-5h')
  // 现行协议：usage=总量、currentValue=已用、remaining=剩余
  assert.equal(r.quotas[0].limit, 2000)
  assert.equal(r.quotas[0].used, 440)
  assert.equal(r.quotas[0].remaining, 1560)
  assert.equal(r.quotas[1].kind, 'weekly')
  assert.equal(r.quotas[1].limit, 9999)
  assert.equal(r.quotas[1].used, 3596)
})

test('parseZhipuQuota regression: currentValue=used (2026-09-28 live snapshot)', () => {
  // 修复前该快照解析为 limit=42 / used=-1915 / remaining=1957（字段读反）
  const r = parseZhipuQuota(OK_CREDIT)
  assert.equal(r.planName, 'lite')
  const [w5, wk] = r.quotas
  assert.equal(w5.limit, 1999)
  assert.equal(w5.used, 42)
  assert.equal(w5.remaining, 1957)
  assert.equal(w5.percentUsed, 2)
  assert.equal(wk.limit, 9999)
  assert.equal(wk.used, 3596)
  assert.equal(wk.remaining, 6403)
  assert.equal(wk.percentUsed, 35)
})

test('parseZhipuQuota degraded form: usage missing, percentage matches used-reading', () => {
  const r = parseZhipuQuota({
    success: true,
    data: {
      limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, currentValue: 42, remaining: 1957, percentage: 2 }],
    },
  })
  assert.equal(r.quotas[0].limit, 1999)
  assert.equal(r.quotas[0].used, 42)
  assert.equal(r.quotas[0].remaining, 1957)
})

test('parseZhipuQuota maps MCP_LIMIT to monthly MCP quota', () => {
  const r = parseZhipuQuota({
    success: true,
    data: { limits: [{ type: 'MCP_LIMIT', currentValue: 10, remaining: 9 }] },
  })
  assert.equal(r.quotas[0].label, 'MCP 工具配额')
})

test('parseZhipuQuota maps auth failure success=false code=1001 to auth', () => {
  assert.throws(() => parseZhipuQuota({ success: false, code: 1001, msg: '鉴权失败' }), (e: unknown) => {
    assert.ok(e instanceof AdapterError)
    assert.equal(e.kind, 'auth')
    return true
  })
})

test('parseZhipuQuota rejects missing limits / non-object responses', () => {
  assert.throws(() => parseZhipuQuota({ success: true, data: {} }), AdapterError)
  assert.throws(() => parseZhipuQuota(null), AdapterError)
})

// ---------------------------------------------------------------------------
// fetchZhipuUsage（fetchImpl stub，不触网）
// ---------------------------------------------------------------------------

interface StubCall {
  status: number
  body?: unknown
}

function stubFetch(calls: StubCall[]): { fetchImpl: typeof fetch; authHeaders: Array<string | undefined> } {
  const authHeaders: Array<string | undefined> = []
  let i = 0
  const fetchImpl = (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
    authHeaders.push(init?.headers?.Authorization)
    const call = calls[Math.min(i, calls.length - 1)]
    i += 1
    return new Response(JSON.stringify(call.body ?? {}), {
      status: call.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { fetchImpl, authHeaders }
}

const FETCH_OPTS = { baseUrl: 'https://open.bigmodel.cn', apiKey: 'sk-test-key', timeoutMs: 1000 }

test('fetchZhipuUsage prefers Bearer auth and resolves usage', async () => {
  const { fetchImpl, authHeaders } = stubFetch([{ status: 200, body: OK_CREDIT }])
  const usage = await fetchZhipuUsage({ ...FETCH_OPTS, fetchImpl })
  assert.equal(usage.planName, 'lite')
  assert.equal(usage.quotas.length, 2)
  assert.deepEqual(authHeaders, ['Bearer sk-test-key'])
})

test('fetchZhipuUsage falls back to bare token once on 401', async () => {
  const { fetchImpl, authHeaders } = stubFetch([
    { status: 401, body: { success: false, code: 1001 } },
    { status: 200, body: OK_CREDIT },
  ])
  const usage = await fetchZhipuUsage({ ...FETCH_OPTS, fetchImpl })
  assert.equal(usage.quotas.length, 2)
  assert.deepEqual(authHeaders, ['Bearer sk-test-key', 'sk-test-key'])
})

test('fetchZhipuUsage maps double 401 to auth error', async () => {
  const { fetchImpl } = stubFetch([{ status: 401, body: {} }, { status: 401, body: {} }])
  await assert.rejects(
    () => fetchZhipuUsage({ ...FETCH_OPTS, fetchImpl }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'auth',
  )
})

test('fetchZhipuUsage maps HTTP 429 to rate-limit error', async () => {
  const { fetchImpl } = stubFetch([{ status: 429, body: {} }])
  await assert.rejects(
    () => fetchZhipuUsage({ ...FETCH_OPTS, fetchImpl }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'rate-limit',
  )
})

test('fetchZhipuUsage maps timeout to network error', async () => {
  const fetchImpl = (async () => {
    throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
  }) as typeof fetch
  await assert.rejects(
    () => fetchZhipuUsage({ ...FETCH_OPTS, fetchImpl }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'network',
  )
})

// ---------------------------------------------------------------------------
// UsageStore
// ---------------------------------------------------------------------------

test('UsageStore keeps ok snapshot with planName and quotas', async () => {
  const store = new UsageStore(async () => parseZhipuQuota(OK_CREDIT))
  await store.refresh()
  const snap = store.snapshot()
  assert.equal(snap?.status, 'ok')
  assert.equal(snap?.planName, 'lite')
  assert.equal(snap?.quotas.length, 2)
  assert.ok(snap?.fetchedAt)
})

test('UsageStore preserves last ok data with stale flag on later failure', async () => {
  let fail = false
  const store = new UsageStore(async () => {
    if (fail) throw new AdapterError('network', '智谱请求超时')
    return parseZhipuQuota(OK_CREDIT)
  })
  await store.refresh()
  fail = true
  await store.refresh()
  const snap = store.snapshot()
  assert.equal(snap?.status, 'error')
  assert.equal(snap?.stale, true)
  assert.equal(snap?.quotas.length, 2)
  assert.equal(snap?.error?.kind, 'network')
})

test('UsageStore maps unconfigured error without error field', async () => {
  const store = new UsageStore(async () => {
    throw new AdapterUnconfiguredError('智谱凭证未配置')
  })
  await store.refresh()
  const snap = store.snapshot()
  assert.equal(snap?.status, 'unconfigured')
  assert.equal(snap?.error, undefined)
})

test('UsageStore ensureFresh only refreshes once when a snapshot exists', async () => {
  let calls = 0
  const store = new UsageStore(async () => {
    calls += 1
    return parseZhipuQuota(OK_CREDIT)
  })
  await store.ensureFresh()
  await store.ensureFresh()
  assert.equal(calls, 1)
  assert.equal(store.snapshot()?.status, 'ok')
})

test('UsageStore ensureFresh surfaces error snapshot from a failing adapter', async () => {
  const store = new UsageStore(async () => {
    throw new AdapterError('parse', '智谱响应不是合法 JSON')
  })
  await store.ensureFresh()
  assert.equal(store.snapshot()?.status, 'error')
  assert.equal(store.snapshot()?.error?.kind, 'parse')
})

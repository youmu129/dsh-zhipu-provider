// 智谱 Coding Plan 用量适配器（迁自 dsh-plugin-custom-providers 的
// src/providers/zhipu.ts，接口契约与解析逻辑逐段一致）。
//
// 端点：GET {baseUrl}/api/monitor/usage/quota/limit，baseUrl 默认 https://open.bigmodel.cn
//       （国际站 https://api.z.ai 经 settings 覆盖）
// 认证：Authorization: Bearer <key>；401 时回退为裸 token 重试一次（社区两派均被报告可用，实测后固定）
// 字段映射（data.limits[]）：
//   TOKENS_LIMIT/CREDIT_LIMIT unit=3 number=5 → window-5h；unit=6 number=1 → weekly
//   TIME_LIMIT / MCP_LIMIT      → monthly（label 标注 MCP 工具配额）
//   数量语义（2026-09-28 线上实测纠正，与 glm-quota-line 同口径）：
//   usage=总量、currentValue=已用、remaining=剩余、percentage=已用百分比（floor）
//   实测例：{ usage:1999, currentValue:42, remaining:1957, percentage:2 }；
//   旧协议形态（usage 缺失、currentValue 记总量）用 percentage 判别，见 parseAmounts
//   nextResetTime（epoch 毫秒）→ resetAt；data.level → planName
// 鉴权失败：success=false 且 code=1001/401 → auth；HTTP 429 或 msg 含限流 → rate-limit

import {
  AdapterError,
  type QuotaEntry,
  isRecord,
  redact,
  toIsoTime,
  toNumber,
} from './model.ts'

export const ZHIPU_DEFAULT_BASE_URL = 'https://open.bigmodel.cn'

const CREDENTIAL_HOSTS = new Set(['open.bigmodel.cn', 'bigmodel.cn', 'api.z.ai'])

export interface ZhipuUsage {
  planName?: string
  quotas: QuotaEntry[]
}

/**
 * 解析单行 limits[] 的数量字段（limit=总量 / used=已用 / remaining=剩余）。
 *
 * 现行协议（2026-09-28 线上实测）：usage=总量、currentValue=已用。
 * 旧协议 fixture（usage 缺失且 currentValue 记总量）用 percentage（API 权威口径）
 * 判别 currentValue 语义，两种读法只有一种能对上 floor 百分比。
 */
function parseAmounts(item: Record<string, unknown>): { limit?: number; used?: number; remaining?: number } {
  const usage = toNumber(item.usage) ?? toNumber(item.total)
  const currentValue = toNumber(item.currentValue) ?? toNumber(item.used)
  const remaining = toNumber(item.remaining)
  const percentage = toNumber(item.percentage)

  // 现行协议：usage=总量在场，直接采用（currentValue=已用）
  if (usage != null) {
    return {
      limit: usage,
      used: currentValue ?? (remaining != null ? usage - remaining : undefined),
      remaining,
    }
  }

  // usage 缺失（旧协议形态）：总量 = 已用 + 剩余；percentage 能鉴别旧记录法时按旧读法
  if (currentValue != null && remaining != null) {
    const sum = currentValue + remaining
    const floorPct = (part: number, whole: number) =>
      whole > 0 ? Math.floor((part / whole) * 100) : -1
    const asUsed = percentage != null && floorPct(currentValue, sum) === Math.floor(percentage)
    const asTotal =
      percentage != null &&
      currentValue >= remaining &&
      floorPct(currentValue - remaining, currentValue) === Math.floor(percentage)
    if (asTotal && !asUsed) {
      // 旧协议：currentValue=总量，已用 = 总量 - 剩余
      return { limit: currentValue, used: currentValue - remaining, remaining }
    }
    return { limit: sum, used: currentValue, remaining }
  }

  return { limit: usage, used: currentValue, remaining }
}

function parseLimit(item: Record<string, unknown>): QuotaEntry | undefined {
  const type = item.type
  let kind: QuotaEntry['kind'] = 'other'
  let label = '其他配额'
  // 实测确认（2026-09）：现行 v2 积分制协议返回 CREDIT_LIMIT，旧协议为 TOKENS_LIMIT；
  // unit/number 语义一致：unit=3 number=5 → 5 小时窗口；unit=6 number=1 → 每周
  if (type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT') {
    if (toNumber(item.unit) === 3 && toNumber(item.number) === 5) {
      kind = 'window-5h'
      label = '5 小时窗口'
    } else if (toNumber(item.unit) === 6 && toNumber(item.number) === 1) {
      kind = 'weekly'
      label = '每周'
    }
  } else if (type === 'TIME_LIMIT' || type === 'MCP_LIMIT') {
    kind = 'monthly'
    label = 'MCP 工具配额'
  }

  const amounts = parseAmounts(item)
  const percentUsed =
    toNumber(item.percentage) ??
    (amounts.limit != null && amounts.limit > 0 && amounts.used != null
      ? Math.round((amounts.used / amounts.limit) * 1000) / 10
      : undefined)
  const resetAt = toIsoTime(item.nextResetTime)

  if (amounts.limit === undefined && amounts.remaining === undefined && amounts.used === undefined && percentUsed === undefined) {
    return undefined
  }
  return { kind, label, limit: amounts.limit, used: amounts.used, remaining: amounts.remaining, percentUsed, resetAt }
}

/** 解析 /api/monitor/usage/quota/limit 响应体。失败抛 AdapterError。 */
export function parseZhipuQuota(json: unknown): ZhipuUsage {
  if (!isRecord(json)) throw new AdapterError('parse', '智谱响应不是 JSON 对象')

  // 鉴权失败：{ success: false, code: 1001 | 401, msg }
  if (json.success === false) {
    const code = toNumber(json.code)
    if (code === 1001 || code === 401) {
      throw new AdapterError('auth', `智谱凭证无效或已过期：${String(json.msg ?? '')}`.trim())
    }
  }

  const data = isRecord(json.data) ? json.data : {}
  const planName = typeof data.level === 'string' ? data.level : undefined

  const quotas: QuotaEntry[] = []
  if (Array.isArray(data.limits)) {
    for (const item of data.limits) {
      if (!isRecord(item)) continue
      const q = parseLimit(item)
      if (q) quotas.push(q)
    }
  }
  if (quotas.length === 0) throw new AdapterError('parse', '智谱响应中未识别到配额字段')
  return { planName, quotas }
}

export interface FetchZhipuOptions {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

export async function fetchZhipuUsage(opts: FetchZhipuOptions): Promise<ZhipuUsage> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = new URL('/api/monitor/usage/quota/limit', ensureTrailingSlash(opts.baseUrl))
  const attachCreds = CREDENTIAL_HOSTS.has(url.hostname)

  // Bearer 优先，401 回退裸 token 重试一次
  let lastAuthError: AdapterError | undefined
  for (const mode of ['bearer', 'bare'] as const) {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (attachCreds) {
      headers.Authorization = mode === 'bearer' ? `Bearer ${opts.apiKey}` : opts.apiKey
    }
    let res: Response
    try {
      res = await fetchImpl(url, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
    } catch (err) {
      throw mapFetchError(err)
    }
    if (res.status >= 300 && res.status < 400) {
      throw new AdapterError('network', `智谱端点发生重定向（${res.status}），已按安全策略拒绝跟随`)
    }
    if (res.status === 401 || res.status === 403) {
      lastAuthError = new AdapterError('auth', '智谱凭证无效或已过期')
      continue // 回退裸 token 重试
    }
    if (res.status === 429) throw new AdapterError('rate-limit', '智谱端点限流，请稍后重试')
    if (!res.ok) {
      const snippet = redact(await safeText(res), [opts.apiKey])
      throw new AdapterError('unknown', `智谱请求失败（HTTP ${res.status}）：${snippet}`)
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new AdapterError('parse', '智谱响应不是合法 JSON')
    }
    return parseZhipuQuota(json)
  }
  throw lastAuthError ?? new AdapterError('auth', '智谱凭证无效或已过期')
}

function ensureTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : base + '/'
}

function mapFetchError(err: unknown): AdapterError {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new AdapterError('network', '智谱请求超时')
  }
  return new AdapterError('network', `智谱网络请求失败：${err instanceof Error ? err.message : String(err)}`)
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}

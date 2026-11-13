// 清单与展示资源守卫：Plugin Manager 不激活插件即读取 locale 元数据与
// icon，缺失/畸形会回退默认文案与图形。此处在测试层锁定：
// 1. exports 覆盖运行时入口、patch、locale 与 icon；files 覆盖全部发布资源；
// 2. zh/en 词典 meta.title / meta.description 非空且点明凭证引用名；
// 3. icon.svg 存在、尺寸合规（≤256KiB）、自包含（无 text/script/style/
//    image/foreignObject/事件处理器），本地引用 id 唯一且闭合。
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string>
  files: string[]
  dsh: { bundle: { patch: string } }
}

test('manifest exports and files cover runtime, patch, locales and icon', () => {
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  for (const entry of ['cordis.patch.yml', 'lib', 'locale/*.json', 'icon.svg']) {
    assert.ok(manifest.files.includes(entry), `files 缺少 ${entry}`)
  }
})

test('both locales ship non-empty meta title and description', () => {
  for (const lang of ['zh', 'en'] as const) {
    const dict = JSON.parse(readFileSync(join(root, `locale/${lang}.json`), 'utf8')) as {
      meta: { title: string, description: string }
    }
    assert.ok(dict.meta.title.length > 0, `${lang} meta.title 为空`)
    assert.ok(dict.meta.description.length > 0, `${lang} meta.description 为空`)
    assert.ok(dict.meta.description.includes('ZHIPU_CODING_PLAN_API_KEY'),
      `${lang} meta.description 应点明凭证引用名`)
  }
})

test('icon is a self-contained SVG within the size limit', () => {
  const path = join(root, 'icon.svg')
  assert.ok(statSync(path).size <= 256 * 1024, 'icon 超过 256KiB 上限')
  const svg = readFileSync(path, 'utf8')
  assert.ok(svg.startsWith('<svg'), 'icon 应为 SVG')
  assert.ok(svg.includes('viewBox="0 0 36 36"'), 'icon 应为 36×36 视口')
  for (const banned of ['<text', '<script', '<style', '<image', 'foreignObject', 'onload', 'onclick']) {
    assert.ok(!svg.includes(banned), `icon 含被禁内容 ${banned}`)
  }
  const ids = [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length, 'icon 内 id 重复')
  for (const ref of [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1])) {
    assert.ok(ids.includes(ref), `icon 引用了不存在的本地 id ${ref}`)
  }
})

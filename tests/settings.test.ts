import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connect } from './mcp-client.ts'
import { startConfiguredWorker, startWorker } from './worker.ts'

test('a temporary settings link moves source changes out of MCP', async t => {
  const worker = await startConfiguredWorker()
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  const reader = await connect(new URL('/mcp', worker.url), 'MCP_TOKEN-test')
  t.after(() => Promise.all([admin.close(), reader.close()]))

  const tools = (await admin.listTools()).tools.map(tool => tool.name)
  assert.ok(tools.includes('create_settings_link'))
  for (const name of ['set_source_paused', 'set_event_filter', 'register_side_chat', 'set_active_side_chat']) {
    assert.ok(!tools.includes(name))
  }
  assert.equal((await reader.callTool({ name: 'create_settings_link' })).isError, true)
  const issued = (await admin.callTool({ name: 'create_settings_link' })).structuredContent as { url: string }
  const link = new URL(issued.url)
  assert.equal(link.origin, worker.url.origin)
  const landing = await fetch(link)
  assert.equal(landing.status, 200)
  assert.equal(landing.headers.get('Referrer-Policy'), 'no-referrer')
  assert.match(landing.headers.get('Content-Security-Policy')!, /form-action 'self'/)
  assert.doesNotMatch(await landing.text(), /MCP_ADMIN_TOKEN-test/)

  const post = (url: URL, body: URLSearchParams, cookie?: string, origin = worker.url.origin, fetchSite?: string) => fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...(fetchSite ? { 'Sec-Fetch-Site': fetchSite } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body,
  })
  assert.equal((await post(link, new URLSearchParams(), undefined, 'https://other.example')).status, 403)
  assert.equal((await post(link, new URLSearchParams(), undefined, 'null', 'cross-site')).status, 403)
  assert.equal((await post(link, new URLSearchParams(), undefined, 'null')).status, 403)
  const opened = await post(link, new URLSearchParams(), undefined, 'null', 'same-origin')
  assert.equal(opened.status, 303)
  const cookie = opened.headers.get('Set-Cookie')!.split(';')[0]
  assert.match(cookie, /^__Host-museknock-settings=[0-9a-f]{64}$/)
  assert.equal((await post(link, new URLSearchParams())).status, 410)
  const page = new URL('/v1/setup/settings', worker.url)
  assert.equal((await fetch(page)).status, 410)
  assert.equal((await post(page, new URLSearchParams({ action: 'pause_source', source: 'custom', paused: 'true' }))).status, 410)
  const initialPage = await fetch(page, { headers: { Cookie: cookie } })
  assert.equal(initialPage.status, 200)
  const initialHtml = await initialPage.text()
  assert.match(initialHtml, /Custom webhook/)
  assert.match(initialHtml, /GitHub/)
  assert.match(initialHtml, /Notify on receipt/)
  assert.match(initialHtml, /Pause notifications/)
  assert.match(initialHtml, /name="type" value="push"/)
  assert.match(initialHtml, /Save selected events/)
  assert.match(initialHtml, /Allow all events/)
  assert.ok(initialHtml.includes(new URL('/v1/hooks/github', worker.url).href))
  assert.match(initialHtml, /README\.md#github-repository-events/)
  assert.equal((await post(page, new URLSearchParams({ action: 'pause_source', source: 'custom', paused: 'true' }), cookie, 'https://other.example')).status, 403)
  assert.equal((await post(page, new URLSearchParams({ action: 'pause_source', source: 'custom', paused: 'true' }), cookie, 'null', 'cross-site')).status, 403)

  const changed = await post(page, new URLSearchParams({ action: 'pause_source', source: 'custom', paused: 'true' }), cookie, 'null', 'same-origin')
  assert.equal(changed.status, 303)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'custom', paused: true, types: [] }],
  })
  assert.equal((await post(page, new URLSearchParams({ action: 'filter_source', source: 'custom', mode: 'selected', otherTypes: 'broken value' }), cookie)).status, 400)
  const noEvents = await post(page, new URLSearchParams({ action: 'filter_source', source: 'custom', mode: 'selected', otherTypes: '' }), cookie)
  assert.equal(noEvents.status, 400)
  assert.match(await noEvents.text(), /Select at least one event/)
  assert.equal((await post(page, new URLSearchParams([['action', 'pause_source'], ['action', 'filter_source'], ['source', 'custom'], ['paused', 'false']]), cookie)).status, 400)
  const filtered = await post(page, new URLSearchParams({ action: 'filter_source', source: 'custom', mode: 'selected', otherTypes: 'push, release' }), cookie)
  assert.equal(filtered.status, 303)
  const updatedHtml = await (await fetch(new URL(filtered.headers.get('Location')!, worker.url), { headers: { Cookie: cookie } })).text()
  assert.match(updatedHtml, /<details[^>]*open[^>]*>.*?Custom webhook/s)
  assert.match(updatedHtml, /Resume notifications/)
  assert.match(updatedHtml, /value="push, release"/)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'custom', paused: true, types: ['push', 'release'] }],
  })
  assert.equal((await post(page, new URLSearchParams({ action: 'filter_source', source: 'custom', mode: 'all' }), cookie)).status, 303)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [{ source: 'custom', paused: true, types: [] }],
  })
  assert.equal((await post(page, new URLSearchParams([
    ['action', 'filter_source'], ['source', 'github'], ['mode', 'selected'],
    ['type', 'push'], ['type', 'release'], ['otherTypes', ''],
  ]), cookie)).status, 303)
  assert.deepEqual((await reader.callTool({ name: 'list_sources' })).structuredContent, {
    sources: [
      { source: 'custom', paused: true, types: [] },
      { source: 'github', paused: false, types: ['push', 'release'] },
    ],
  })
})

test('a new link replaces an unused ticket and reset ends an open settings session', async t => {
  const worker = await startWorker(undefined, { MUSE_NODE_ID: undefined, MUSE_REFRESH_TOKEN: undefined })
  t.after(() => worker.close())
  const admin = await connect(new URL('/mcp', worker.url), 'MCP_ADMIN_TOKEN-test')
  t.after(() => admin.close())
  const issue = async () => new URL(String(((await admin.callTool({ name: 'create_settings_link' })).structuredContent as { url: string }).url))
  const old = await issue()
  const current = await issue()
  assert.equal((await fetch(old)).status, 410)
  assert.equal((await fetch(current)).status, 200)
  const opened = await fetch(current, { method: 'POST', redirect: 'manual',
    headers: { Origin: worker.url.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(),
  })
  const cookie = opened.headers.get('Set-Cookie')!.split(';')[0]
  const page = new URL('/v1/setup/settings', worker.url)
  assert.equal((await fetch(page, { headers: { Cookie: cookie } })).status, 200)
  const reset = await fetch(new URL('/v1/setup/reset', worker.url), {
    method: 'POST', headers: { Authorization: 'Bearer MCP_ADMIN_TOKEN-test' },
  })
  assert.equal(reset.status, 204)
  assert.equal((await fetch(page, { headers: { Cookie: cookie } })).status, 410)
})

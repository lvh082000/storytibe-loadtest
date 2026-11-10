// k6 load test for storytibe.com — simulates real readers, not a request flood.
//
// A reader's request profile was recorded from a real Chrome session on 2026-11-10 (ric-api
// docs/novel/02-ket-qua-do-hieu-nang.md §8): landing on a chapter = 1 HTML + /api/reader/me +
// ~38 Next.js segment prefetches (3–4 per link on the page, all reaching the origin) + cover
// images from storage.ricvina.vn (not behind Cloudflare) + CORS preflight + POST view. Moving to
// the next chapter is client-side: preflight + POST view + prefetch of the newly visible link.
// JS/CSS are served by Cloudflare's cache (HIT) and are skipped here.
//
// Modes (env MODE): smoke | readers | spike. One GitHub Actions job = one k6 process = one
// egress IP; per-IP limits of ric-api (view 120/min, unlock 30/min) are respected by spreading
// readers over many jobs.

import http from 'k6/http'
import { sleep } from 'k6'
import exec from 'k6/execution'
import { Counter } from 'k6/metrics'

const E = __ENV
const BASE = E.BASE || 'https://storytibe.com'
const API = E.API || 'https://api.ricvina.vn/api/v1'
const TENANT = E.TENANT || '83100c03-239a-4825-a018-b43076c65b6f'
const MODE = E.MODE || 'smoke'
const JOB = E.JOB || '0'
const VUS = toInt(E.VUS, 5)
const RAMP = E.RAMP || '1m'
const HOLD = E.HOLD || '1m'
const SPIKE_PER_MIN = toInt(E.SPIKE_PER_MIN, 20)
const SPIKE_CHAPTER = E.SPIKE_CHAPTER || 'chapter-1-the-deed-in-the-envelope'
const START_AT = toInt(E.START_AT, 0)
const READ_MIN = toInt(E.READ_MIN, 120)
const READ_MAX = toInt(E.READ_MAX, 240)
const UNLOCK_SHARE = Number(E.UNLOCK_SHARE || '0.4')
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0 Mobile Safari/537.36 storytibe-loadtest/1.0'

const KINDS = ['page', 'me', 'rsc', 'img', 'preflight', 'view', 'unlock']
const CLASSES = ['ok', '4xx', '429', '503', '5xx', 'err']
const STAGES = MODE === 'spike' ? ['spike'] : ['ramp', 'hold']
const STATIC_PAGES = ['/privacy-policy', '/terms-of-service', '/disclaimer']
const NO_PREFETCH = /^\/(login|register|library|forgot-password|reset-password|verify-email)\b/

const counters = {}
KINDS.forEach((k) => {
  CLASSES.forEach((c) => {
    counters[`${k}_${c}`] = new Counter(`st_${k}_${c}`)
  })
})

const thresholds = {}
KINDS.forEach((k) => {
  STAGES.forEach((s) => {
    // Always passes; declaring it makes k6 report this tag combination in the summary.
    thresholds[`http_req_duration{kind:${k},stage:${s}}`] = ['max>=0']
  })
})

const scenarios =
  MODE === 'spike'
    ? {
        spike: {
          executor: 'ramping-arrival-rate',
          exec: 'spikeReader',
          timeUnit: '1m',
          startRate: 0,
          preAllocatedVUs: Math.ceil(SPIKE_PER_MIN * 1.5),
          maxVUs: SPIKE_PER_MIN * 3,
          stages: [
            { duration: '10s', target: SPIKE_PER_MIN },
            { duration: '60s', target: SPIKE_PER_MIN },
            { duration: '5s', target: 0 },
          ],
          gracefulStop: '3m',
        },
      }
    : {
        readers: {
          executor: 'ramping-vus',
          exec: 'reader',
          startVUs: 0,
          stages: [
            { duration: RAMP, target: VUS },
            { duration: HOLD, target: VUS },
            { duration: '20s', target: 0 },
          ],
          gracefulRampDown: '5s',
          gracefulStop: '5s',
        },
      }

export const options = {
  scenarios,
  thresholds,
  setupTimeout: '15m',
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  userAgent: UA,
  discardResponseBodies: true,
}

function toInt(v, d) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : d
}

function durationMs(d) {
  const m = /^(\d+)(s|m)$/.exec(d)
  if (!m) return 0
  return Number(m[1]) * (m[2] === 'm' ? 60000 : 1000)
}

function rand(min, max) {
  return min + Math.random() * (max - min)
}

function classOf(res) {
  if (!res || res.status === 0) return 'err'
  if (res.status === 429) return '429'
  if (res.status === 503) return '503'
  if (res.status >= 500) return '5xx'
  if (res.status >= 400) return '4xx'
  return 'ok'
}

function count(kind, res) {
  counters[`${kind}_${classOf(res)}`].add(1)
}

function params(kind, stage, headers, text) {
  const p = { headers: headers || {}, tags: { kind, stage, name: kind }, timeout: '30s' }
  if (text) p.responseType = 'text'
  return p
}

function batch(reqs, kinds) {
  if (reqs.length === 0) return []
  const res = http.batch(reqs)
  res.forEach((r, i) => count(kinds[i], r))
  return res
}

function stageNow() {
  if (MODE === 'spike') return 'spike'
  return Date.now() - exec.scenario.startTime < durationMs(RAMP) ? 'ramp' : 'hold'
}

function segmentsFor(path) {
  if (path === '/') return ['/_tree', '/_head', '/__PAGE__']
  const m = /^\/(series|genre)\/[^/]+$/.exec(path)
  if (m) return ['/_tree', '/_head', `/${m[1]}/$d$slug`, `/${m[1]}/$d$slug/__PAGE__`]
  if (STATIC_PAGES.indexOf(path) >= 0) return ['/_tree', '/_head', path, `${path}/__PAGE__`]
  return ['/_tree', '/_head', '/$d$slug', '/$d$slug/__PAGE__']
}

function rscRequests(link, fromPath, stage) {
  return segmentsFor(link).map((seg) => [
    'GET',
    `${BASE}${link}?_rsc=${Math.random().toString(36).slice(2, 7)}`,
    null,
    params('rsc', stage, {
      RSC: '1',
      'Next-Router-Prefetch': '1',
      'Next-Router-Segment-Prefetch': seg,
      'Next-Url': fromPath,
    }),
  ])
}

function imgRequest(url, stage) {
  return ['GET', url, null, params('img', stage, { Accept: 'image/avif,image/webp,*/*' })]
}

function extractLinks(html, current) {
  const out = []
  const re = /href="(\/[^"#?]*)"/g
  let m
  while ((m = re.exec(html)) !== null) {
    const p = m[1]
    if (p.indexOf('//') === 0 || p.indexOf('/_next/') === 0 || p.indexOf('/api/') === 0) continue
    if (p === current || NO_PREFETCH.test(p) || /\.[a-z0-9]+$/i.test(p)) continue
    if (out.indexOf(p) < 0) out.push(p)
  }
  return out
}

function extractImages(html) {
  const out = []
  const re = /https:\/\/storage\.ricvina\.vn\/[^"\\\s)]+?\.(?:webp|jpe?g|png|gif|avif)/g
  let m
  while ((m = re.exec(html)) !== null) if (out.indexOf(m[0]) < 0) out.push(m[0])
  return out
}

function apiPost(kind, chapter, action, stage) {
  const url = `${API}/public/novel/chapters/${chapter.id}/${action}`
  const pre = http.options(
    url,
    null,
    params('preflight', stage, {
      Origin: BASE,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'x-tenant-context',
    }),
  )
  count('preflight', pre)
  const res = http.post(url, null, params(kind, stage, { Origin: BASE, 'X-Tenant-Context': TENANT }))
  count(kind, res)
  return res
}

function maybeUnlock(chapter, stage) {
  if (!chapter.isLocked || Math.random() >= UNLOCK_SHARE) return
  sleep(rand(5, 10)) // the rewarded ad (minSeconds 5)
  apiPost('unlock', chapter, 'unlock', stage)
}

/** Full page load of a chapter. Returns false when the HTML did not load. */
function land(chapter, seen) {
  const stage = stageNow()
  const path = `/${chapter.slug}`
  const page = http.get(
    `${BASE}${path}`,
    params(
      'page',
      stage,
      {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      true,
    ),
  )
  count('page', page)
  if (page.status !== 200 || typeof page.body !== 'string') return false

  const links = extractLinks(page.body, path)
  const imgs = extractImages(page.body).filter((u) => !seen[u])
  imgs.forEach((u) => {
    seen[u] = true
  })

  // Right after load: session check, the eager cover, the links above the fold.
  const first = [['GET', `${BASE}/api/reader/me`, null, params('me', stage, { Accept: '*/*' })]]
  const firstKinds = ['me']
  if (imgs.length > 0) {
    first.push(imgRequest(imgs[0], stage))
    firstKinds.push('img')
  }
  links.slice(0, 2).forEach((l) => {
    rscRequests(l, path, stage).forEach((r) => {
      first.push(r)
      firstKinds.push('rsc')
    })
  })
  batch(first, firstKinds)
  apiPost('view', chapter, 'view', stage)

  // While the reader scrolls: the remaining links and covers come into view.
  const rest = []
  links.slice(2).forEach((l) => {
    rscRequests(l, path, stage).forEach((r) => rest.push(r))
  })
  const restImgs = imgs.slice(1)
  for (let i = 0; i < rest.length || (i === 0 && restImgs.length > 0); i += 8) {
    sleep(rand(1.5, 3.5))
    const chunk = rest.slice(i, i + 8)
    const kinds = chunk.map(() => 'rsc')
    if (i === 0) {
      restImgs.forEach((u) => {
        chunk.push(imgRequest(u, stage))
        kinds.push('img')
      })
    }
    batch(chunk, kinds)
  }

  maybeUnlock(chapter, stageNow())
  return true
}

/** Client-side move to the next chapter: data was prefetched; only the new link is fetched. */
function navigate(chapter, after) {
  const stage = stageNow()
  const path = `/${chapter.slug}`
  apiPost('view', chapter, 'view', stage)
  if (after) {
    const reqs = rscRequests(`/${after.slug}`, path, stage)
    batch(
      reqs,
      reqs.map(() => 'rsc'),
    )
  }
  maybeUnlock(chapter, stage)
}

function nextOf(chapters, chapter) {
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]
    if (c.series === chapter.series && c.n === chapter.n + 1) return c
  }
  return null
}

export function setup() {
  if (START_AT > 0) {
    const wait = START_AT - Date.now() / 1000
    if (wait > 0) sleep(wait)
  }
  const h = { headers: { 'X-Tenant-Context': TENANT }, responseType: 'text', timeout: '30s' }
  const list = http.get(`${API}/public/novel/series`, h)
  const chapters = []
  JSON.parse(list.body).data.forEach((s) => {
    const detail = JSON.parse(http.get(`${API}/public/novel/series/${s.slug}`, h).body)
    ;(detail.toc || []).forEach((c) => {
      chapters.push({ id: c.id, slug: c.slug, isLocked: !!c.isLocked, series: s.slug, n: c.chapterNumber })
    })
  })
  if (chapters.length === 0) throw new Error('no published chapters')
  const trace = http.get(`${BASE}/cdn-cgi/trace`, { responseType: 'text' })
  const ipLine = String(trace.body || '')
    .split('\n')
    .filter((l) => l.indexOf('ip=') === 0)[0]
  return { chapters, ip: ipLine ? ipLine.slice(3) : 'unknown', startedAt: new Date().toISOString() }
}

export function reader(data) {
  const chapters = data.chapters
  const seen = {}
  let chapter = chapters[Math.floor(Math.random() * chapters.length)]
  if (!land(chapter, seen)) {
    sleep(rand(5, 15))
    return
  }
  const pages = 1 + Math.floor(Math.random() * 4)
  for (let i = 1; i < pages; i++) {
    const next = nextOf(chapters, chapter)
    if (!next) break
    sleep(rand(READ_MIN, READ_MAX))
    chapter = next
    navigate(chapter, nextOf(chapters, chapter))
  }
  sleep(rand(READ_MIN, READ_MAX))
}

export function spikeReader(data) {
  const chapters = data.chapters
  const chapter = chapters.filter((c) => c.slug === SPIKE_CHAPTER)[0] || chapters[0]
  if (!land(chapter, {})) return
  sleep(rand(60, 120))
  const next = nextOf(chapters, chapter)
  if (next && Math.random() < 0.5) navigate(next, nextOf(chapters, next))
}

export function handleSummary(data) {
  const m = data.metrics
  const setup = data.setup_data || {}
  const out = {
    job: JOB,
    mode: MODE,
    ip: setup.ip,
    startedAt: setup.startedAt,
    vus: VUS,
    ramp: RAMP,
    hold: HOLD,
    spikePerMin: SPIKE_PER_MIN,
    durations: {},
    statuses: {},
    totals: {},
  }
  Object.keys(m).forEach((key) => {
    if (key.indexOf('http_req_duration{') === 0) out.durations[key.slice(18, -1)] = m[key].values
    if (key.indexOf('st_') === 0) out.statuses[key.slice(3)] = m[key].values.count
  })
  ;['http_reqs', 'data_received', 'data_sent', 'iterations', 'dropped_iterations', 'vus_max'].forEach(
    (k) => {
      if (m[k]) out.totals[k] = m[k].values
    },
  )
  return {
    'summary.json': JSON.stringify(out, null, 1),
    stdout: `${JSON.stringify({ job: JOB, ip: out.ip, statuses: out.statuses, totals: out.totals })}\n`,
  }
}

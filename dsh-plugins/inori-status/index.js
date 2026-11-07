/**
 * Host half of the Inori status panel.
 *
 * The Client module renders the page; this half reads the qq-inori state files
 * on the Host and serves one same-origin JSON snapshot, so the browser never
 * needs a second port, CORS, or the bridge's console token.
 *
 * Every read is best-effort: a missing or half-written file only drops that
 * field from the snapshot instead of failing the request. Files that are large
 * or rewritten often (social graph, beliefs, token log, slang) are parsed once
 * per mtime/size change instead of once per poll.
 */
import { open, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Route shared with `client.js`; keep both constants in sync. */
const ROUTE_PATH = '/inori-status/state.json'
// 不写死作者机器路径：QQ_INORI_ROOT 优先，否则按插件位置推导仓库根
// （<repo>/dsh-plugins/inori-status → <repo>）。
const DEFAULT_ROOT = process.env.QQ_INORI_ROOT
  ? resolve(process.env.QQ_INORI_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/** A lock file this fresh means the bridge process is still alive. */
const BRIDGE_ALIVE_MS = 5 * 60 * 1000
const TAIL_BYTES = 64 * 1024
const TOKEN_TAIL_BYTES = 512 * 1024
const TOOLS_TAIL_BYTES = 512 * 1024

export const inject = ['webServer']

/** Console routes the debug view is allowed to touch. Anything else is refused. */
const DEBUG_PATHS = Object.freeze({
  state: '/inori-status/debug.json',
  action: '/inori-status/debug/action',
})
const CONSOLE_TIMEOUT_MS = 4000
const MODE_VALUES = Object.freeze(['chat', 'reserved', 'reserved2', 'closed-agent', 'simulation'])
const EFFORT_VALUES = Object.freeze(['low', 'high', 'max'])

export function apply(ctx, config) {
  const root = resolveRoot(config)

  const handler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    let body
    try {
      body = JSON.stringify(await collect(root))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: String((error && error.message) || error) }))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const debugState = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    let payload
    try {
      payload = await collectDebug(root)
    } catch (error) {
      return sendJson(res, 500, { error: String((error && error.message) || error) })
    }
    sendJson(res, 200, payload)
  }

  const debugAction = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    let payload
    try {
      payload = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
    let outcome
    try {
      outcome = await runDebugAction(root, payload)
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: String((error && error.message) || error) })
    }
    sendJson(res, outcome.ok ? 200 : 400, outcome)
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    'inori-status: state route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: DEBUG_PATHS.state, handler: debugState }),
    'inori-status: debug state route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: DEBUG_PATHS.action, handler: debugAction }),
    'inori-status: debug action route',
  )
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${(error && error.message) || error}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * One read-only call to the bridge console. The token never leaves the Host, so
 * the page never needs a second origin, CORS, or the console credential.
 */
async function consoleRequest(root, pathname, init) {
  const config = await readJson(join(root, 'qq-bridge', 'config.json'))
  const port = config && Number.isFinite(config.consolePort) ? config.consolePort : 3100
  const token = (await readText(join(root, 'qq-bridge', 'state', 'console-token'))).trim()
  if (!token) throw new Error('缺少控制台令牌（qq-bridge/state/console-token）')
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { 'x-console-token': token, ...((init && init.headers) || {}) },
    signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { ok: response.ok, status: response.status, body }
}

async function collectDebug(root) {
  const modeDoc = await readJson(join(root, 'qq-bridge', 'state', 'mode.json'))
  const result = {
    console: { ok: false, error: '' },
    model: null,
    status: null,
    modes: MODE_VALUES.slice(),
    efforts: EFFORT_VALUES.slice(),
    local: { mode: modeDoc && typeof modeDoc.mode === 'string' ? modeDoc.mode : '' },
  }

  const [modelResult, statusResult] = await Promise.all([
    consoleRequest(root, '/api/dsh/model').catch((error) => ({ ok: false, status: 0, body: { error: String((error && error.message) || error) } })),
    consoleRequest(root, '/api/status').catch((error) => ({ ok: false, status: 0, body: { error: String((error && error.message) || error) } })),
  ])

  if (modelResult.ok && modelResult.body && !modelResult.body.error) {
    result.model = {
      provider: text(modelResult.body.provider),
      model: text(modelResult.body.model),
      reasoningEffort: text(modelResult.body.reasoningEffort),
      options: Array.isArray(modelResult.body.options) ? modelResult.body.options.filter((item) => typeof item === 'string') : EFFORT_VALUES.slice(),
      catalogSource: text(modelResult.body.catalogSource),
      globalSideEffect: modelResult.body.globalSideEffect === true,
    }
    if (result.model.options.length) result.efforts = result.model.options
  } else {
    result.console.error = text(modelResult.body && modelResult.body.error) || `模型接口返回 ${modelResult.status}`
  }

  if (statusResult.ok && statusResult.body && !statusResult.body.error) {
    const onebot = statusResult.body.onebot && typeof statusResult.body.onebot === 'object' ? statusResult.body.onebot : {}
    result.status = {
      mode: text(statusResult.body.mode),
      role: text(statusResult.body.role),
      roleMode: text(statusResult.body.roleMode),
      dshReady: statusResult.body.dshReady === true,
      paused: statusResult.body.socialV2Paused === true,
      onebotConnected: onebot.connected === true,
      onebotUrl: text(onebot.url),
      allowGroups: Array.isArray(statusResult.body.allowGroups) ? statusResult.body.allowGroups.length : null,
      allowPrivate: Array.isArray(statusResult.body.allowPrivate) ? statusResult.body.allowPrivate.length : null,
    }
    result.console.ok = true
  } else if (!result.console.error) {
    result.console.error = text(statusResult.body && statusResult.body.error) || `状态接口返回 ${statusResult.status}`
  }

  return result
}

/**
 * Whitelisted hot switches. Each one is refused unless the action name and its
 * value are both known here, so the page cannot reach any other console route.
 */
async function runDebugAction(root, payload) {
  const action = payload && typeof payload.action === 'string' ? payload.action : ''

  if (action === 'effort') {
    const value = String(payload.value || '')
    if (!EFFORT_VALUES.includes(value)) return { ok: false, error: `思考强度只能是 ${EFFORT_VALUES.join(' / ')}` }
    const result = await consoleRequest(root, '/api/dsh/effort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: value }),
    })
    return normalizeActionResult(result, `思考强度已设为 ${value}`, '切换思考强度失败')
  }

  if (action === 'mode') {
    const value = String(payload.value || '')
    if (!MODE_VALUES.includes(value)) return { ok: false, error: `运行模式只能是 ${MODE_VALUES.join(' / ')}` }
    const result = await consoleRequest(root, '/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: value }),
    })
    return normalizeActionResult(result, `运行模式已设为 ${value}`, '切换运行模式失败')
  }

  if (action === 'pause') {
    const paused = payload.value === true
    const result = await consoleRequest(root, '/api/socialV2/activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused }),
    })
    return normalizeActionResult(result, paused ? '二代 AI 已暂停' : '二代 AI 已恢复', '切换暂停失败')
  }

  return { ok: false, error: `未知动作：${action || '(空)'}` }
}

function normalizeActionResult(result, okMessage, failMessage) {
  if (result.ok && result.body && result.body.ok !== false) {
    return { ok: true, message: okMessage }
  }
  const detail = result.body && (result.body.error || result.body.raw)
  return { ok: false, error: `${failMessage}${detail ? `：${String(detail).slice(0, 200)}` : `（HTTP ${result.status}）`}` }
}

function resolveRoot(config) {
  const configured = config && typeof config.root === 'string' ? config.root.trim() : ''
  return (configured || DEFAULT_ROOT).replace(/\\/g, '/').replace(/\/+$/, '')
}

async function collect(root) {
  const bridgeState = join(root, 'qq-bridge', 'state')
  const dataState = join(root, 'data', 'state')
  const mindDir = join(dataState, 'mind')
  const dataDir = join(root, 'data')

  const [
    roleDoc,
    modeDoc,
    selfState,
    styleDoc,
    offlineDoc,
    talkDoc,
    rhythm,
    plan,
    ownLife,
    loopsDoc,
    goalDoc,
    sessionDoc,
    memoryIndex,
    moodDoc,
    lock,
    diaryText,
    dailyText,
    actions,
    cognition,
    slang,
    social,
    wake,
    beliefs,
    lessons,
    aliases,
    usage,
    tools,
  ] = await Promise.all([
    readJson(join(bridgeState, 'current-role.json')),
    readJson(join(bridgeState, 'mode.json')),
    readJson(join(mindDir, 'self-state.json')),
    readJson(join(mindDir, 'style-baseline.json')),
    readJson(join(mindDir, 'offline-narrative.json')),
    readJson(join(dataState, 'inori_state.json')),
    readJson(join(bridgeState, 'own-life-rhythm.json')),
    readJson(join(bridgeState, 'day-plan.json')),
    readJson(join(bridgeState, 'own-life.json')),
    readJson(join(bridgeState, 'curiosity.json')),
    readJson(join(dataState, 'goals.json')),
    readJson(join(bridgeState, 'sessions.json')),
    readJson(join(dataDir, 'memory', 'index.json')),
    readJson(join(dataState, 'emotion-vector.json')),
    statOrUndefined(join(bridgeState, 'bridge.lock')),
    readText(join(dataDir, 'diary', 'diary.jsonl')),
    readText(join(dataDir, 'diary', 'daily.jsonl')),
    readTailJson(join(dataState, 'action-log.jsonl'), 8),
    readTailJson(join(dataState, 'cognition.jsonl'), 5),
    readSlang(join(bridgeState, 'slang.json')),
    readSocial(join(dataState, 'social-graph.json')),
    readWake(join(bridgeState, 'social-v2.json')),
    readBeliefs(join(mindDir, 'beliefs.json')),
    readLessons(join(mindDir, 'lessons-ledger.jsonl')),
    countLines(join(mindDir, 'identity-map.jsonl')),
    readUsage(join(bridgeState, 'token-usage.jsonl')),
    readTools(join(bridgeState, 'tool-calls.jsonl')),
  ])

  const pid = lock ? (await readText(join(bridgeState, 'bridge.lock'))).trim().slice(0, 16) : ''

  return {
    generatedAt: Date.now(),
    root,
    identity: {
      role: roleDoc && typeof roleDoc.role === 'string' ? roleDoc.role : '',
      mode: roleDoc && typeof roleDoc.mode === 'string' ? roleDoc.mode : '',
      simMode: modeDoc && typeof modeDoc.mode === 'string' ? modeDoc.mode : '',
      bridge: {
        alive: await isBridgeAlive(pid, lock),
        pid,
        lockAt: lock ? Math.round(lock.mtimeMs) : null,
      },
    },
    self: readSelf(selfState),
    style: readStyle(styleDoc),
    offline: readOffline(offlineDoc),
    talk: talkDoc && typeof talkDoc === 'object'
      ? {
        warmth: numberOrNull(talkDoc.warmth),
        energy: numberOrNull(talkDoc.energy),
        replies: Number.isFinite(talkDoc.replies) ? talkDoc.replies : null,
        lastTalkAt: numberOrNull(talkDoc.lastTalkAt),
      }
      : null,
    mood: readMood(moodDoc),
    plan: plan && Array.isArray(plan.items)
      ? {
        date: typeof plan.date === 'string' ? plan.date : '',
        items: plan.items.slice(0, 12).map((item) => ({
          at: text(item && item.at),
          what: text(item && item.what),
          mood: text(item && item.mood),
          detail: text(item && item.detail),
          done: Boolean(item && item.done),
        })),
      }
      : null,
    ownLife: ownLife && typeof ownLife === 'object'
      ? {
        firedToday: Number.isFinite(ownLife.firedToday) ? ownLife.firedToday : null,
        lastFiredAt: numberOrNull(ownLife.lastFiredAt),
        intervalMinutes: rhythm && Number.isFinite(rhythm.intervalMs)
          ? Math.max(1, Math.round(rhythm.intervalMs / 60000))
          : null,
      }
      : null,
    loops: loopsDoc && Array.isArray(loopsDoc.loops)
      ? loopsDoc.loops.slice(0, 6).map((loop) => ({
        text: text(loop && loop.text),
        source: text(loop && loop.source),
        ts: numberOrNull(loop && loop.ts),
      }))
      : [],
    thoughts: cognition.map((entry) => ({
      text: text(entry && entry.text),
      kind: text(entry && entry.kind),
      at: parseStamp(entry && entry.at),
    })).filter((entry) => entry.text),
    goals: splitGoals(goalDoc),
    actions: actions.map((entry) => ({
      at: numberOrNull(entry && entry.ts) ?? parseStamp(entry && entry.ts),
      t: text(entry && entry.t),
      key: text(entry && entry.key),
      outcome: text(entry && entry.outcome),
    })),
    diary: tailJsonLines(diaryText, 3).map((entry) => ({
      day: text(entry && entry.day),
      time: text(entry && entry.time),
      mood: text(entry && entry.mood),
      text: clip(text(entry && entry.text), 400),
    })),
    daily: (() => {
      const last = tailJsonLines(dailyText, 1)[0]
      if (!last) return null
      return { day: text(last.day), text: clip(text(last.text), 4000) }
    })(),
    slang,
    sessions: sessionList(sessionDoc),
    social,
    wake,
    mind: { beliefs, lessons, aliases },
    usage,
    tools,
    memory: memoryTotals(memoryIndex),
  }
}

/* ------------------------------------------------------------------ readers */

function readSelf(doc) {
  if (!doc || typeof doc !== 'object') return null
  return {
    at: numberOrNull(doc.at),
    energy: numberOrNull(doc.energy),
    sleepDebt: numberOrNull(doc.sleepDebt),
    socialHunger: numberOrNull(doc.socialHunger),
    curiosity: numberOrNull(doc.curiosity),
    competence: numberOrNull(doc.competence),
    stress: numberOrNull(doc.stress),
    valence: numberOrNull(doc.valence),
    arousal: numberOrNull(doc.arousal),
    mood: numberOrNull(doc.mood),
    affect: doc.affect && typeof doc.affect === 'object'
      ? {
        joy: numberOrNull(doc.affect.joy),
        sadness: numberOrNull(doc.affect.sadness),
        anger: numberOrNull(doc.affect.anger),
        fear: numberOrNull(doc.affect.fear),
        affection: numberOrNull(doc.affect.affection),
        curiosity: numberOrNull(doc.affect.curiosity),
      }
      : null,
    evidence: Array.isArray(doc.evidence)
      ? doc.evidence.slice(-2).reverse().map((item) => ({
        at: numberOrNull(item && item.at),
        kind: text(item && item.kind),
        note: clip(text(item && item.note), 120),
      }))
      : [],
  }
}

function readStyle(doc) {
  if (!doc || typeof doc !== 'object') return null
  const metrics = doc.metrics && typeof doc.metrics === 'object' ? doc.metrics : {}
  return {
    at: numberOrNull(doc.at),
    samples: Number.isFinite(doc.samples) ? doc.samples : null,
    insufficient: doc.insufficient === true,
    avgChars: numberOrNull(metrics.avgChars),
    emojiRate: numberOrNull(metrics.emojiRate),
    questionRate: numberOrNull(metrics.questionRate),
    firstPersonRate: numberOrNull(metrics.firstPersonRate),
  }
}

function readOffline(doc) {
  if (!doc || typeof doc !== 'object') return null
  const stats = doc.stats && typeof doc.stats === 'object' ? doc.stats : {}
  return {
    text: clip(text(doc.text), 300),
    gapHours: numberOrNull(stats.gapHours),
    received: Number.isFinite(stats.received) ? stats.received : null,
    sent: Number.isFinite(stats.sent) ? stats.sent : null,
    topKeys: Array.isArray(stats.topKeys)
      ? stats.topKeys.slice(0, 4).map((item) => ({
        key: text(item && item.key),
        count: Number.isFinite(item && item.count) ? item.count : 0,
      }))
      : [],
  }
}

function readMood(doc) {
  if (!doc || typeof doc !== 'object' || !doc.keys) return null
  const rows = []
  for (const key of Object.keys(doc.keys)) {
    const entry = doc.keys[key]
    if (!entry || typeof entry !== 'object') continue
    rows.push({
      key,
      at: numberOrNull(entry.at),
      joy: numberOrNull(entry.joy),
      sadness: numberOrNull(entry.sadness),
      anger: numberOrNull(entry.anger),
      fear: numberOrNull(entry.fear),
      affection: numberOrNull(entry.affection),
      curiosity: numberOrNull(entry.curiosity),
    })
  }
  rows.sort((left, right) => (right.joy || 0) + (right.affection || 0) - ((left.joy || 0) + (left.affection || 0)))
  return { updatedAt: numberOrNull(doc.updatedAt), rows: rows.slice(0, 8) }
}

async function readSocial(file) {
  return readCached(file, async () => {
    const doc = await readJson(file)
    const groupsDoc = doc && doc.groups && typeof doc.groups === 'object' ? doc.groups : {}
    const groups = []
    let totalPairs = 0
    for (const key of Object.keys(groupsDoc)) {
      const pairsDoc = groupsDoc[key] && groupsDoc[key].pairs && typeof groupsDoc[key].pairs === 'object'
        ? groupsDoc[key].pairs
        : {}
      const pairs = Object.values(pairsDoc)
      totalPairs += pairs.length
      const top = pairs
        .slice()
        .sort((left, right) => (right.ab + right.ba + right.reply) - (left.ab + left.ba + left.reply))
        .slice(0, 4)
        .map((pair) => ({
          a: text(pair.aName) || '匿名',
          b: text(pair.bName) || '匿名',
          ab: Number.isFinite(pair.ab) ? pair.ab : 0,
          ba: Number.isFinite(pair.ba) ? pair.ba : 0,
          reply: Number.isFinite(pair.reply) ? pair.reply : 0,
        }))
      groups.push({ key, pairs: pairs.length, top })
    }
    groups.sort((left, right) => right.pairs - left.pairs)
    return { totalPairs, groups: groups.slice(0, 6) }
  }, null)
}

async function readWake(file) {
  return readCached(file, async () => {
    const doc = await readJson(file)
    const conversations = doc && doc.conversations && typeof doc.conversations === 'object' ? doc.conversations : {}
    const rows = []
    for (const key of Object.keys(conversations)) {
      const config = conversations[key] && conversations[key].wakeConfig
      if (!config) continue
      rows.push({
        key,
        mode: text(config.mode),
        wakeCount: Number.isFinite(config.wakeCount) ? config.wakeCount : null,
        probability: config.triggers && Number.isFinite(config.triggers.probability)
          ? config.triggers.probability
          : null,
        keywords: config.triggers && Array.isArray(config.triggers.keywords)
          ? config.triggers.keywords.length
          : 0,
      })
    }
    rows.sort((left, right) => (right.wakeCount || 0) - (left.wakeCount || 0))
    return rows.slice(0, 8)
  }, [])
}

async function readBeliefs(file) {
  return readCached(file, async () => {
    const doc = await readJson(file)
    const peopleDoc = doc && doc.people && typeof doc.people === 'object' ? doc.people : {}
    const groupsDoc = doc && doc.groups && typeof doc.groups === 'object' ? doc.groups : {}
    const people = Object.values(peopleDoc).map((person) => ({
      id: text(person && person.id),
      trust: numberOrNull(person && person.trust),
      affinity: numberOrNull(person && person.affinity),
      familiarity: numberOrNull(person && person.familiarity),
      interactions: Number.isFinite(person && person.interactionCount) ? person.interactionCount : 0,
      lastContactAt: numberOrNull(person && person.lastContactAt),
    }))
    people.sort((left, right) => right.interactions - left.interactions)
    return {
      people: people.length,
      groups: Object.keys(groupsDoc).length,
      topPeople: people.slice(0, 6),
    }
  }, null)
}

async function readLessons(file) {
  return readCached(file, async () => {
    const raw = await readText(file)
    const rows = []
    const byKind = {}
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      const kind = text(entry.kind) || 'rule'
      byKind[kind] = (byKind[kind] || 0) + 1
      const rule = text(entry.rule)
      if (rule) rows.push({ rule: clip(rule, 160), kind, confidence: numberOrNull(entry.confidence) })
    }
    return { total: rows.length, byKind, recent: rows.slice(-5).reverse() }
  }, null)
}

async function readUsage(file) {
  return readCached(file, async () => {
    const raw = await readTextTail(file, TOKEN_TAIL_BYTES)
    if (!raw) return null
    const dayStart = startOfToday()
    const today = { turns: 0, cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 }
    let model = ''
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      if (!Number.isFinite(entry.t) || entry.t < dayStart) continue
      // `base` rows name the model in use, `turn` rows carry the token buckets,
      // and `evict` rows are end-of-session rollups appended out of time order.
      if (entry.k === 'base') {
        if (text(entry.model)) model = text(entry.model)
        continue
      }
      if (entry.k !== 'turn') continue
      const bucket = entry.b && typeof entry.b === 'object' ? entry.b : {}
      today.turns += 1
      today.cacheMiss += bucket.cacheMiss || 0
      today.cacheHit += bucket.cacheHit || 0
      today.cacheWrite += bucket.cacheWrite || 0
      today.output += bucket.output || 0
    }
    // Turn rows carry no conversation key, so a per-key split would be a lie.
    return { today, model }
  }, null)
}

async function readTools(file) {
  return readCached(file, async () => {
    const raw = await readTextTail(file, TOOLS_TAIL_BYTES)
    if (!raw) return null
    const byTool = new Map()
    let total = 0
    let ok = 0
    let fail = 0
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry
      try {
        entry = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (!entry || entry.type !== 'result') continue
      total += 1
      if (entry.ok) ok += 1
      else fail += 1
      const name = text(entry.tool) || '未知'
      const row = byTool.get(name) || { name, ok: 0, fail: 0 }
      if (entry.ok) row.ok += 1
      else row.fail += 1
      byTool.set(name, row)
    }
    const top = Array.from(byTool.values())
      .sort((left, right) => (right.ok + right.fail) - (left.ok + left.fail))
      .slice(0, 8)
    return { total, ok, fail, top }
  }, null)
}

async function readSlang(file) {
  return readCached(file, async () => {
    const doc = await readJson(file)
    if (!Array.isArray(doc)) return null
    const status = { confirmed: 0, candidate: 0, stale: 0, rejected: 0 }
    const rows = []
    for (const entry of doc) {
      if (!entry || typeof entry !== 'object') continue
      const state = text(entry.status)
      if (status[state] !== undefined) status[state] += 1
      const content = text(entry.content)
      if (!content) continue
      rows.push({
        content: clip(content, 30),
        meaning: clip(text(entry.meaning), 110),
        status: state,
        at: parseStamp(entry.updatedAt),
      })
    }
    rows.sort((left, right) => {
      const confirmDelta = (right.status === 'confirmed' ? 1 : 0) - (left.status === 'confirmed' ? 1 : 0)
      if (confirmDelta !== 0) return confirmDelta
      return (right.at || 0) - (left.at || 0)
    })
    return { total: doc.length, status, sample: rows.slice(0, 8) }
  }, null)
}

/* ------------------------------------------------------------------ helpers */

/**
 * Parse a file once per (mtime, size). A failed rebuild keeps the previous
 * value so one half-written file never blanks the panel.
 */
const fileCache = new Map()

async function readCached(file, build, fallback) {
  const info = await statOrUndefined(file)
  if (!info) return fallback
  const hit = fileCache.get(file)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value
  let value
  try {
    value = await build()
  } catch {
    return hit ? hit.value : fallback
  }
  if (value === undefined || value === null) return value
  fileCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, value })
  return value
}

function startOfToday() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

/**
 * The lock file carries the bridge's pid and is written once at startup, so
 * mtime alone is not liveness. Ask the OS about the pid first and fall back to
 * the lock's freshness when no pid is recorded.
 */
async function isBridgeAlive(pid, lock) {
  const numeric = Number.parseInt(pid, 10)
  if (Number.isFinite(numeric) && numeric > 0) {
    try {
      process.kill(numeric, 0)
      return true
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return true
      return false
    }
  }
  return Boolean(lock && Date.now() - lock.mtimeMs < BRIDGE_ALIVE_MS)
}

function splitGoals(doc) {
  const list = doc && Array.isArray(doc.goals) ? doc.goals : []
  const active = []
  const done = []
  for (const goal of list) {
    if (!goal) continue
    const status = text(goal.status)
    const item = {
      text: text(goal.text),
      touchedAt: numberOrNull(goal.touchedAt) ?? parseStamp(goal.touchedAt),
      progressCount: Array.isArray(goal.progress) ? goal.progress.length : 0,
    }
    if (!item.text) continue
    if (status === 'done' || status === 'dropped') done.push({ ...item, status })
    else active.push(item)
  }
  done.sort((left, right) => (right.touchedAt || 0) - (left.touchedAt || 0))
  return { active: active.slice(0, 6), done: done.slice(0, 3) }
}

function sessionList(doc) {
  const sessions = doc && doc.sessions && typeof doc.sessions === 'object' ? doc.sessions : {}
  const policies = doc && doc.sessionPolicies && typeof doc.sessionPolicies === 'object' ? doc.sessionPolicies : {}
  return Object.keys(sessions).map((key) => ({
    key,
    kind: key.startsWith('group:') ? 'group' : 'private',
    policy: policyLabel(policies[key]),
  }))
}

function policyLabel(raw) {
  if (typeof raw !== 'string') return ''
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return ''
    return parsed.find((part) => typeof part === 'string' && part.length > 0 && part !== 'reserved2') || ''
  } catch {
    return ''
  }
}

function memoryTotals(index) {
  const files = index && index.files && typeof index.files === 'object' ? index.files : null
  if (!files) return null
  let total = 0
  let sources = 0
  for (const key of Object.keys(files)) {
    const entry = files[key]
    if (!entry) continue
    sources += 1
    if (Number.isFinite(entry.total)) total += entry.total
  }
  return { total, sources }
}

async function countLines(file) {
  return readCached(file, async () => {
    const raw = await readText(file)
    if (!raw) return 0
    let count = 0
    for (const line of raw.split(/\r?\n/)) if (line.trim()) count += 1
    return count
  }, 0)
}

async function readJson(file) {
  const raw = await readText(file)
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function statOrUndefined(file) {
  try {
    return await stat(file)
  } catch {
    return undefined
  }
}

/** Read only the tail of a JSONL file so a growing log stays cheap. */
async function readTailJson(file, maxLines) {
  return tailJsonLines(await readTextTail(file, TAIL_BYTES), maxLines)
}

async function readTextTail(file, maxBytes) {
  let handle
  try {
    handle = await open(file, 'r')
    const info = await handle.stat()
    if (!info.size) return ''
    const length = Math.min(maxBytes, info.size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, info.size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

function tailJsonLines(raw, maxLines) {
  if (!raw) return []
  const lines = raw.split(/\r?\n/)
  const parsed = []
  for (let index = lines.length - 1; index >= 0 && parsed.length < maxLines; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') parsed.push(value)
    } catch {
      // A tail read can start mid-record; skip the fragment.
    }
  }
  return parsed.reverse()
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function parseStamp(value) {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

function clip(value, max) {
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

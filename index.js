/**
 * Context Anchor — long-horizon attention and memory for DeepSeek Harness sessions.
 *
 * Two mechanisms, both derived from the ONE source of truth (the session log):
 *
 * 1. A rebuilt-every-step "anchor" prompt context: the live thread (recent user
 *    intent), the active todo list, the files in play, and the last assistant
 *    action — recomputed from the complete log on each request, so compaction
 *    can shadow history without the model losing the plot.
 *
 * 2. Two recall tools that read the FULL log, not the compacted surface:
 *    `context_recall` searches every earlier message and tool result,
 *    `context_expand` returns an exact seq range verbatim. Compaction replaces
 *    surface nodes; it never deletes log events, so nothing is truly forgotten.
 *
 * 3. A memory policy the panel can steer: either leave compaction to the
 *    harness (auto) or compact earlier at a chosen hot-context percentage, and
 *    — once anything has been archived — automatically re-surface the archived
 *    excerpts that match the newest instruction.
 *
 * Imports are Node builtins only, so the plugin stays installable from any
 * profile (no dependency on harness packages).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'context-anchor'

/** Services this plugin needs; absent ones keep it inactive instead of throwing. */
export const inject = ['systemPrompt', 'tools']

const DEFAULTS = {
  /** Hard cap on the anchor text, so the anchor never becomes the problem. */
  maxAnchorChars: 1000,
  /** How many recent user messages the anchor quotes. */
  recentUserMessages: 2,
  /** How many distinct files the anchor lists. */
  recentFiles: 3,
  /** Characters kept per quoted user message. */
  quoteChars: 130,
  /** Anchor placement among runtime contexts (working directory is 100). */
  order: 105,
}

// --- Memory policy ---------------------------------------------------------
// The panel's one setting: either let the harness decide when to condense
// (`auto`, the default and a no-op), or condense early once hot context reaches
// a chosen percentage. The percentage is capped at the harness's own default
// trigger (80%), because the built-in automatic compaction fires there first.

const SETTINGS_DEFAULT = { mode: 'auto', percent: 70, autoRecall: true, protect: [] }
const SETTINGS_MIN_PERCENT = 30
const SETTINGS_MAX_PERCENT = 80
const SETTINGS_PATH_SEGMENTS = ['storages', 'context-anchor', 'settings.json']
const SETTINGS_ROUTE = '/api/dsh-context-anchor'
const MAX_HISTORY_POINTS = 50

/** Global defaults for this host process; replaced wholesale on every save. */
let settings = { ...SETTINGS_DEFAULT }

/**
 * Per-session overrides, keyed by session id. The panel edits the session it is
 * attached to; a session without an override follows the global default, so a
 * fresh conversation never inherits a threshold tuned somewhere else.
 */
let sessionPolicies = Object.create(null)

/** Per-session throttle so a failed or fruitless compaction cannot retry every step. */
const compactionAttempts = new WeakMap()

/** Last auto-recall result per session, keyed by the log/surface cursor it was derived from. */
const recallCache = new WeakMap()

/** Last anchor actually handed to the model, per session: chars + rough tokens. */
const anchorStats = new WeakMap()

const clampPercent = (value) => Math.min(
  SETTINGS_MAX_PERCENT,
  Math.max(SETTINGS_MIN_PERCENT, Number.isInteger(value) ? value : SETTINGS_DEFAULT.percent),
)

/** Protection needles are matched case-insensitively, but must stay short and few. */
const PROTECT_MAX_ITEMS = 8
const PROTECT_MAX_CHARS = 64

/** Keep the protection list usable: trimmed, de-duplicated, bounded, no empties. */
function normalizeProtect(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : []
  const seen = new Set()
  const kept = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const needle = item.trim().slice(0, PROTECT_MAX_CHARS)
    if (needle.length === 0) continue
    const key = needle.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(needle)
    if (kept.length >= PROTECT_MAX_ITEMS) break
  }
  return kept
}

/** Accept anything the client sends; every field has a safe fallback. */
function normalizeSettings(raw) {
  const source = isObject(raw) ? raw : {}
  return {
    mode: source.mode === 'custom' ? 'custom' : 'auto',
    percent: clampPercent(source.percent),
    autoRecall: source.autoRecall !== false,
    protect: normalizeProtect(source.protect),
  }
}

/** A session id, whichever shape this runtime hands over. */
function sessionIdOf(session) {
  if (typeof session?.id === 'string' && session.id.length > 0) return session.id
  if (typeof session?.sessionId === 'string' && session.sessionId.length > 0) return session.sessionId
  return undefined
}

/**
 * The policy in force for one session: its own override when it has one, else
 * the global default. Everything that acts on a session — the compaction gate,
 * the auto-recall block, the panel — goes through here, so one conversation's
 * threshold can never leak into another's.
 */
function settingsFor(sessionId) {
  const patch = typeof sessionId === 'string' ? sessionPolicies[sessionId] : undefined
  return normalizeSettings(isObject(patch) ? { ...settings, ...patch } : settings)
}

/** `$DSH_HOME/storages/context-anchor/settings.json`, matching the host home layout. */
function settingsFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, ...SETTINGS_PATH_SEGMENTS)
}

/** Load the persisted policy once per host process; a missing or broken file means defaults. */
function loadSettings() {
  sessionPolicies = Object.create(null)
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    settings = normalizeSettings(raw)
    if (isObject(raw?.sessions)) {
      for (const [key, value] of Object.entries(raw.sessions)) {
        if (isObject(value)) sessionPolicies[key] = normalizeSettings({ ...settings, ...value })
      }
    }
  } catch {
    settings = { ...SETTINGS_DEFAULT }
  }
}

/** Persist global defaults plus every per-session override, atomically. */
function persistSettings(next, policies = sessionPolicies) {
  const target = settingsFile()
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ ...next, sessions: policies }, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
}

/** Per-session incremental fold cache: folding the whole log every step would be O(n^2). */
const folds = new WeakMap()

const isObject = (value) => typeof value === 'object' && value !== null

/** Collapse whitespace and cut to a readable length. */
function clip(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(0, limit - 1))}…`
}

/** Cut by code point; `slice` could split a surrogate pair and emit half an emoji. */
function cutText(text, limit) {
  if (text.length <= limit) return text
  return Array.from(text).slice(0, Math.max(0, limit)).join('')
}

/** Flatten one message's content blocks into plain text (tool calls included). */
function blocksText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!isObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push(`[tool ${block.name}] ${String(block.arguments ?? '')}`)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push(`[file ${block.attachment?.name ?? ''}]`)
  }
  return parts.join('\n')
}

// --- Cached-content pricing -------------------------------------------------
// The recall tools can replay every message and tool exchange in the log, so the
// content they can still reach is what this plugin holds "cached locally". It is
// priced with the same fixed-density heuristic the composer's context meter uses
// (@deepseek-ai/dsh-token-meter/estimate), so both readings speak one unit.

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

/** Price one content block exactly as the meter's estimate module does. */
function priceBlock(block) {
  if (!isObject(block)) return 0
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    case 'tool-call':
      return Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN)
        + Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN)
        + BLOCK_OVERHEAD
    default:
      try {
        return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
      } catch {
        return BLOCK_OVERHEAD
      }
  }
}

/** Price a message's content blocks; `chars` is the raw text size for display. */
function priceContent(content) {
  if (!Array.isArray(content)) return { chars: 0, tokens: 0 }
  let chars = 0
  let tokens = 0
  for (const block of content) {
    if (!isObject(block)) continue
    if (typeof block.text === 'string') chars += block.text.length
    else if (block.type === 'tool-call') chars += String(block.name ?? '').length + String(block.arguments ?? '').length
    tokens += priceBlock(block)
  }
  return { chars, tokens }
}

/** Price one log event's recallable content; `null` when it carries none. */
function priceEvent(event) {
  const data = event.data ?? {}
  let priced
  let frame = ROLE_OVERHEAD
  switch (event.type) {
    case 'user/message':
      priced = priceContent(data.content)
      break
    case 'assistant/message':
      priced = priceContent(data.message?.content)
      break
    case 'tool/result':
      priced = priceContent(data.message?.content)
      break
    case 'tool/call':
      priced = priceContent([{ type: 'tool-call', name: data.name, arguments: data.arguments }])
      frame = 0
      break
    default:
      return null
  }
  if (priced.chars === 0 && priced.tokens === 0) return null
  return { chars: priced.chars, tokens: priced.tokens + frame }
}

/** Projection key the Client half reads through `useProjection`. */
const CACHE_PROJECTION = 'contextAnchorCache'

/**
 * The registry only ever calls `schema.parse`, and this state is produced and
 * consumed entirely in-process, so an identity schema keeps the plugin
 * dependency-free (it ships no `zod`).
 */
const identitySchema = { parse: (value) => value }

/** The two recall tools this plugin owns, and the memory state each one names. */
const RECALL_TOOLS = { context_recall: 'recall', context_expand: 'expand', context_memory: 'memory' }

/** Memory state after one event: a recall call starts it, any tool result ends it. */
function activityOf(state, event) {
  if (event.type === 'tool/call') {
    const next = RECALL_TOOLS[event.data?.name]
    if (next !== undefined) return next
  }
  if (event.type === 'tool/result' && state !== 'idle') return 'idle'
  return state
}

/** Register the client-visible "cached locally" size for every session. */
function registerCacheProjection(ctx) {
  ctx.inject(['sessionProjections'], (scope) => {
    scope.sessionProjections.register({
      key: CACHE_PROJECTION,
      stateVersion: 1,
      stateSchema: identitySchema,
      init: () => ({
        tokens: 0,
        chars: 0,
        events: 0,
        recalls: 0,
        activity: 'idle',
        at: -1,
        lastAt: 0,
        history: [],
      }),
      apply: (state, event) => {
        const activity = activityOf(state.activity ?? 'idle', event)
        const priced = priceEvent(event)
        if (priced === null && activity === state.activity) return state
        const recall = RECALL_TOOLS[event.data?.name] === 'recall' ? 1 : 0
        const nextTokens = (state.tokens ?? 0) + (priced?.tokens ?? 0)
        const nextChars = (state.chars ?? 0) + (priced?.chars ?? 0)
        
        // Record history point when tokens change
        let nextHistory = state.history ?? []
        if (priced !== null && event.time) {
          const percent = Math.round((nextTokens / 1_000_000) * 100)
          nextHistory = [...nextHistory, { time: event.time, percent }]
          if (nextHistory.length > MAX_HISTORY_POINTS) {
            nextHistory = nextHistory.slice(-MAX_HISTORY_POINTS)
          }
        }
        
        return {
          tokens: nextTokens,
          chars: nextChars,
          events: (state.events ?? 0) + (priced === null ? 0 : 1),
          recalls: (state.recalls ?? 0) + recall,
          activity,
          at: event.seq,
          lastAt: event.time ?? state.lastAt ?? 0,
          history: nextHistory,
        }
      },
      wire: {
        viewSchema: identitySchema,
        view: (state) => ({
          tokens: state.tokens ?? 0,
          chars: state.chars ?? 0,
          events: state.events ?? 0,
          recalls: state.recalls ?? 0,
          activity: state.activity ?? 'idle',
          at: state.at ?? -1,
          lastAt: state.lastAt ?? 0,
          history: state.history ?? [],
        }),
      },
    })
  })
}

/** Best-effort file path from one tool call's raw JSON arguments. */
function toolPaths(name, rawArgs) {
  if (typeof rawArgs !== 'string' || rawArgs.length === 0) return []
  let parsed
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return []
  }
  if (!isObject(parsed)) return []
  const found = []
  for (const key of ['file_path', 'path', 'target', 'cwd']) {
    const value = parsed[key]
    if (typeof value === 'string' && value.length > 0 && value.length < 400) found.push({ path: value, op: name })
  }
  return found
}

/** Fresh fold state for one session. */
function emptyFold() {
  return {
    seq: -1,
    turns: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    recentUser: [],
    files: new Map(),
    todos: null,
    lastAssistant: '',
    compactions: 0,
    lastCompactionSeq: -1,
  }
}

/** Fold one session event into the anchor state. Pure; returns a new state only when it changes. */
function foldEvent(state, event, config) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'turn/start':
      return { ...state, turns: Math.max(state.turns, Number(data.turn) || 0) }
    case 'user/message': {
      // Only the human's own words belong in the live thread; plugin-injected
      // notices (time, working directory, compaction checkpoints) are context,
      // not intent, and would drown the signal.
      if (data.source?.kind !== 'user') return state
      const text = clip(blocksText(data.content), config.quoteChars)
      // Runtime checkpoints are metadata, not human intent; they may arrive as
      // ordinary user messages and otherwise dominate both the anchor and recall.
      if (text.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')) return state
      const recent = text.length === 0
        ? state.recentUser
        : [...state.recentUser, { seq: event.seq, text }].slice(-64)
      return {
        ...state,
        userMessages: state.userMessages + 1,
        recentUser: recent,
      }
    }
    case 'assistant/message': {
      const text = blocksText(data.message?.content)
      return {
        ...state,
        assistantMessages: state.assistantMessages + 1,
        lastAssistant: text.length > 0 ? clip(text, 240) : state.lastAssistant,
      }
    }
    case 'tool/call': {
      const files = new Map(state.files)
      for (const { path, op } of toolPaths(data.name, data.arguments)) {
        const prior = files.get(path) ?? { count: 0, ops: [], seq: event.seq }
        const ops = prior.ops.includes(op) ? prior.ops : [...prior.ops, op].slice(-3)
        files.set(path, { count: prior.count + 1, ops, seq: event.seq })
      }
      return { ...state, toolCalls: state.toolCalls + 1, files }
    }
    case 'todo/write':
      return { ...state, todos: Array.isArray(data.todos) ? data.todos : null }
    case 'compaction/end': {
      // A failed compaction also closes its bracket; only a successful one has
      // archived anything, so only that one may switch auto-recall on.
      if (data.error !== undefined) return state
      return { ...state, compactions: state.compactions + 1, lastCompactionSeq: event.seq }
    }
    default:
      // Compaction changes the surface, never the log: the anchor keeps reading the log.
      return state
  }
}

/** Advance the fold to the session cursor, reusing the cached prefix. */
function foldSession(session, config) {
  const cached = folds.get(session)
  let state = cached ?? emptyFold()
  const last = session.seq - 1
  if (state.seq > last) state = emptyFold()
  for (let seq = state.seq + 1; seq <= last; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    state = foldEvent(state, event, config)
    state.seq = seq
  }
  state.seq = Math.max(state.seq, last)
  folds.set(session, state)
  return state
}

/** Render the anchor text. Recomputed from the full log, so it outlives compaction. */
function renderAnchor(session, config) {
  const state = foldSession(session, config)
  const lines = []
  lines.push('上下文锚点（来自完整会话日志）')

  const recent = state.recentUser.slice(-Math.max(1, config.recentUserMessages))
  if (recent.length > 0) {
    lines.push('当前主线 —— 用户最近的指令，由旧到新：')
    for (const entry of recent) lines.push(`- [#${entry.seq}] ${entry.text}`)
  }

  if (Array.isArray(state.todos) && state.todos.length > 0) {
    const count = (status) => state.todos.filter((todo) => todo?.status === status).length
    const active = state.todos.filter((todo) => todo?.status === 'in_progress').map((todo) => todo.content)
    lines.push(
      `任务列表：${count('completed')} 项已完成，${count('in_progress')} 项进行中，${count('pending')} 项待办`
      + (active.length > 0 ? ` —— 正在做：${active.map((entry) => clip(entry, 90)).join('；')}` : ''),
    )
  }

  if (state.files.size > 0) {
    const entries = [...state.files.entries()].sort((a, b) => b[1].seq - a[1].seq).slice(0, config.recentFiles)
    lines.push(`涉及文件：${entries.map(([path]) => path).join('，')}`)
  }

  if (state.lastAssistant.length > 0) lines.push(`上一步：${clip(state.lastAssistant, 120)}`)

  // Memory that matters should arrive on its own: whenever part of the log has
  // left the surface (compaction, or just a long session), pull back the
  // archived excerpts that match what is being worked on right now — without
  // waiting for the model to decide to search, and without the user asking.
  const offSurface = session.seq - (session.surface?.nodes?.length ?? 0)
  if (settingsFor(sessionIdOf(session)).autoRecall && (state.compactions > 0 || offSurface > 60)) {
    try {
      const recalled = recallArchived(session, state, config)
      if (recalled.length > 0) lines.push(recalled)
    } catch {
      // A recall failure must never take the whole anchor down with it.
    }
  }

  lines.push('更早历史仍在日志：需要原话时用 context_recall 搜索，再用 context_expand 按 seq 读取。')

  let text = lines.join('\n')
  if (text.length > config.maxAnchorChars) {
    const head = lines.slice(0, -1).join('\n')
    const tail = lines.at(-1) ?? ''
    const budget = Math.max(0, config.maxAnchorChars - tail.length - 8)
    // Cut by code point, so an emoji at the boundary cannot become half a pair.
    text = `${head.length > budget ? `${cutText(head, budget)}…` : head}\n${tail}`
  }
  // What the model actually pays for this step. The panel shows it so "did the
  // budget change help?" is answerable instead of a guess.
  anchorStats.set(session, {
    chars: text.length,
    tokens: Math.ceil(text.length / CHARS_PER_TOKEN),
    lines: lines.length,
    recalled: lines.some((line) => line.startsWith('- [#')),
    at: session.seq,
    time: Date.now(),
  })
  return text
}

/** The last anchor written for a session, or undefined before the first step. */
function anchorStatsOf(session) {
  return session === undefined ? undefined : anchorStats.get(session)
}

/** One readable line per event, used by both recall tools. */
function eventText(event) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'user/message': {
      const text = blocksText(data.content)
      return text.length > 0 ? `用户：${text}` : ''
    }
    case 'assistant/message': {
      const text = blocksText(data.message?.content)
      return text.length > 0 ? `助手：${text}` : ''
    }
    case 'tool/call':
      return `工具调用 ${data.name}：${String(data.arguments ?? '')}`
    case 'tool/result': {
      const text = blocksText(data.message?.content)
      return text.length > 0 ? `工具结果：${text}` : ''
    }
    case 'compaction/end':
      return data.error === undefined
        ? '压缩：更早的表层历史已被摘要成一条检查点'
        : '压缩失败：更早的表层历史保持不变'
    default:
      return ''
  }
}

/** Chinese names for the event kinds the recall tools echo back. */
const TYPE_LABELS = {
  'user/message': '用户消息',
  'assistant/message': '助手消息',
  'tool/call': '工具调用',
  'tool/result': '工具结果',
  'compaction/end': '压缩',
}

const typeLabel = (type) => TYPE_LABELS[type] ?? type

// --- Local retrieval kernel ------------------------------------------------
//
// The model never scans the log: it sends a query and this kernel does the
// work. One incremental inverted index per session (latin words + CJK bigrams,
// because Chinese has no word boundaries), BM25 scoring over those postings,
// phrase boosts, and structured filters parsed out of the query itself.

/** Per-session inverted index, advanced event by event like the anchor fold. */
const kernels = new WeakMap()

const WORD_RE = /[a-z0-9_]{2,}/g
const CJK_RUN_RE = /[\u3400-\u9fff\uf900-\ufaff]+/g

/**
 * Function-word bigrams and single characters. Chinese has no word boundary, so
 * the kernel indexes adjacent bigrams; these are the ones that appear in almost
 * every sentence. Skipping them at index time keeps the index smaller and stops
 * "the/of/and" from outranking the words that actually identify a passage.
 */
const CJK_STOP = new Set([
  '的了', '的时', '时候', '我们', '你们', '他们', '这个', '那个', '这些', '那些',
  '就是', '可以', '还是', '但是', '因为', '所以', '如果', '然后', '现在', '已经',
  '需要', '使用', '一个', '没有', '不是', '这么', '那么', '什么', '怎么', '这样',
  '那样', '一下', '一些', '而且', '并且', '或者', '以及', '对于', '关于', '通过',
  '进行', '能够', '应该', '可能', '其实', '只是', '还有', '也是', '都是', '我要',
  '的是', '是的', '了吗', '呢？', '好的', '我先', '让我', '了吧',
])
const CJK_STOP_CHARS = new Set(['的', '了', '是', '在', '和', '就', '不', '都', '也', '很', '与', '或', '个', '我', '你', '他', '这', '那', '吗', '呢', '吧', '啊', '着', '过', '把', '被', '给', '对', '从', '到'])

/**
 * Tokens for indexing and querying: latin words of two or more characters, and
 * adjacent-character bigrams for every CJK run.
 */
function kernelTokens(text) {
  const lower = String(text ?? '').toLowerCase()
  const tokens = []
  let match
  WORD_RE.lastIndex = 0
  while ((match = WORD_RE.exec(lower)) !== null) tokens.push(match[0])
  CJK_RUN_RE.lastIndex = 0
  while ((match = CJK_RUN_RE.exec(lower)) !== null) {
    const run = match[0]
    if (run.length === 1) {
      if (!CJK_STOP_CHARS.has(run)) tokens.push(run)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (!CJK_STOP.has(bigram)) tokens.push(bigram)
    }
  }
  return tokens
}

/** Fresh index for one session. */
function emptyKernel() {
  return { seq: 0, docs: new Map(), postings: new Map(), totalLen: 0 }
}

/** Add one event's text to the index as a document. */
function kernelAdd(kernel, event, text) {
  const tokens = kernelTokens(text)
  if (tokens.length === 0) return
  const tf = new Map()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  const data = event.data ?? {}
  kernel.docs.set(event.seq, {
    seq: event.seq,
    type: event.type,
    tool: event.type === 'tool/call' ? String(data.name ?? '') : '',
    text,
    lower: text.toLowerCase(),
    tf,
    len: tokens.length,
  })
  for (const [token, count] of tf) {
    let posting = kernel.postings.get(token)
    if (posting === undefined) {
      posting = new Map()
      kernel.postings.set(token, posting)
    }
    posting.set(event.seq, count)
  }
  kernel.totalLen += tokens.length
}

/** Advance the index to the session cursor, reusing the cached prefix. */
function kernelOf(session) {
  let kernel = kernels.get(session)
  if (kernel === undefined || kernel.seq > session.seq) {
    kernel = emptyKernel()
    kernels.set(session, kernel)
  }
  for (let seq = kernel.seq; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const text = eventText(event)
    if (text.length === 0) continue
    kernelAdd(kernel, event, text)
  }
  kernel.seq = session.seq
  return kernel
}

const FILTER_KEYS = new Set(['type', 'tool', 'file', 'after', 'before'])

/**
 * Split a query into kernel terms plus optional structure:
 * `"exact phrase"`, `-must-not-contain`, `type:user|assistant|tool|call`,
 * `tool:read`, `file:Temperat`, `after:120`, `before:300`.
 */
function parseQuery(raw) {
  const terms = []
  const phrases = []
  const exclude = []
  const filters = {}
  let wordParts = 0
  for (const part of String(raw ?? '').match(/"[^"]*"|\S+/g) ?? []) {
    if (part.length > 2 && part.startsWith('"') && part.endsWith('"')) {
      phrases.push(part.slice(1, -1).toLowerCase())
      wordParts += 1
      continue
    }
    const filter = /^([a-z]+):(.+)$/i.exec(part)
    if (filter !== null && FILTER_KEYS.has(filter[1].toLowerCase())) {
      const key = filter[1].toLowerCase()
      const value = filter[2]
      if (key === 'after' || key === 'before') {
        const bound = Number.parseInt(value, 10)
        if (Number.isInteger(bound)) filters[key] = bound
      } else {
        filters[key] = value.toLowerCase()
      }
      continue
    }
    if (part.startsWith('-') && part.length > 1) {
      exclude.push(part.slice(1).toLowerCase())
      continue
    }
    wordParts += 1
    terms.push(...kernelTokens(part))
  }
  return { terms: [...new Set(terms)], phrases, exclude, filters, wordParts }
}

/** Does one document survive the parsed filters? */
function kernelMatch(doc, filters) {
  if (filters.type !== undefined) {
    const wanted = filters.type
    const ok = wanted === 'call'
      ? doc.type === 'tool/call'
      : wanted === 'tool'
        ? doc.type === 'tool/result'
        : doc.type.startsWith(`${wanted}/`)
    if (!ok) return false
  }
  if (filters.tool !== undefined && !doc.tool.toLowerCase().includes(filters.tool)) return false
  if (filters.file !== undefined && !doc.lower.includes(filters.file)) return false
  if (filters.after !== undefined && doc.seq < filters.after) return false
  if (filters.before !== undefined && doc.seq > filters.before) return false
  if (excludeHits(doc, filters)) return false
  return true
}

/** Exclusion terms are a plain "must not contain" list. */
function excludeHits(doc, filters) {
  const list = filters.exclude ?? []
  for (const word of list) if (doc.lower.includes(word)) return true
  return false
}

/**
 * Rank documents for one parsed query: BM25 over the postings, plus a bonus for
 * each phrase that appears verbatim. A filter-only query ranks by recency.
 */
function kernelSearch(kernel, parsed, limit, keep) {
  const docs = kernel.docs
  const n = docs.size
  if (n === 0) return { hits: [], total: 0, stats: { terms: kernel.postings.size, docs: 0 } }
  const avgLen = kernel.totalLen / n || 1
  const k1 = 1.2
  const b = 0.75
  const scores = new Map()

  for (const term of parsed.terms) {
    const posting = kernel.postings.get(term)
    if (posting === undefined) continue
    const df = posting.size
    // A term in more than half the documents says nothing about which passage
    // matters; its IDF is ~0 anyway, so skipping it saves the whole posting scan.
    if (df > n / 2 && parsed.terms.length > 1) continue
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    for (const [seq, tf] of posting) {
      const doc = docs.get(seq)
      if (doc === undefined) continue
      const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.len) / avgLen))
      scores.set(seq, (scores.get(seq) ?? 0) + idf * norm)
    }
  }

  for (const phrase of parsed.phrases) {
    for (const doc of docs.values()) {
      if (doc.lower.indexOf(phrase) < 0) continue
      scores.set(doc.seq, (scores.get(doc.seq) ?? 0) + 4 + Math.min(4, phrase.length / 4))
    }
  }

  // Filter-only query (no searchable word was even typed): every surviving doc
  // competes on recency. When words exist but rank nothing — including words
  // that were all stopword-filtered — the honest answer is "no hit", not the
  // whole log.
  if (scores.size === 0 && parsed.wordParts === 0) {
    for (const doc of docs.values()) scores.set(doc.seq, 1)
  }

  const filters = { ...parsed.filters, exclude: parsed.exclude }
  let total = 0
  const hits = []
  for (const [seq, score] of scores) {
    const doc = docs.get(seq)
    if (doc === undefined || !kernelMatch(doc, filters)) continue
    if (keep !== undefined && !keep(doc)) continue
    total += 1
    hits.push({ seq, type: doc.type, text: doc.text, score })
  }
  hits.sort((left, right) => right.score - left.score || right.seq - left.seq)
  return {
    hits: hits.slice(0, limit),
    total,
    stats: { terms: kernel.postings.size, docs: n },
  }
}

/**
 * Mark the needles that actually matched, so the eye lands on the reason a hit
 * was returned. Plain text output, so the marker is a bracketing glyph rather
 * than styling; the budget keeps a broad query from turning a snippet into
 * confetti.
 */
function highlightSnippet(text, parsed) {
  const budget = 5
  const seen = new Set()
  let out = text
  let marks = 0
  for (const needle of [...parsed.phrases, ...parsed.terms]) {
    if (marks >= budget) break
    if (typeof needle !== 'string' || needle.length === 0) continue
    const key = needle.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const at = out.toLowerCase().indexOf(key)
    if (at < 0) continue
    out = `${out.slice(0, at)}«${out.slice(at, at + needle.length)}»${out.slice(at + needle.length)}`
    marks += 1
  }
  return out
}

/** A window of the document centered on the first matched term or phrase. */
function kernelSnippet(doc, parsed, width) {
  const lower = doc.lower
  let at = -1
  for (const phrase of parsed.phrases) {
    const index = lower.indexOf(phrase)
    if (index >= 0) {
      at = index
      break
    }
  }
  if (at < 0) {
    for (const term of parsed.terms) {
      const index = lower.indexOf(term)
      if (index >= 0 && (at < 0 || index < at)) at = index
    }
  }
  if (at < 0) at = 0
  const start = at > Math.floor(width / 4) ? at - Math.floor(width / 4) : 0
  const end = start + width
  const raw = `${start > 0 ? '…' : ''}${doc.text.slice(start, end)}${end < doc.text.length ? '…' : ''}`
  return highlightSnippet(raw, parsed)
}


// --- Automatic recall of archived history ---------------------------------

/** Function words that would match almost every archived paragraph. */
/**
 * The newest instruction's best matching archived excerpts. "Archived" means
 * logged but no longer on the surface: exactly what compaction hid from the
 * hot context and what the recall tools can still reach.
 */
function recallArchived(session, state, config) {
  const latest = state.recentUser.at(-1)
  if (latest === undefined) return ''

  // The query is the current task, not just the last sentence: the instruction,
  // the previous action and the files in play together describe what the model
  // is working on — and "the memory it needs" means the history behind exactly
  // that, not behind the wording of any single message.
  // Rank by the latest human request, not assistant/tool boilerplate or every
  // previously touched path (which favored unrelated code fragments).
  const parsed = parseQuery(latest.text)
  if (parsed.terms.length === 0 && parsed.phrases.length === 0) return ''

  // The anchor is rebuilt on every request; re-ranking per step would be wasted
  // work when neither the log, the surface nor the task focus has moved.
  const cacheKey = `${session.seq}:${session.surface?.nodes?.length ?? 0}:${state.compactions}:`
    + `${latest.seq}:${state.lastAssistant.length}:${state.files.size}`
  const cached = recallCache.get(session)
  if (cached?.key === cacheKey) return cached.text

  const kernel = kernelOf(session)
  const surface = new Set(session.surface?.nodes ?? [])
  // Rank through the same kernel the recall tool uses, keeping only what the
  // surface no longer carries: archived history, not the live turn.
  const { hits } = kernelSearch(kernel, parsed, 6, (doc) => (
    doc.seq < latest.seq && !surface.has(doc.seq) && doc.type !== 'compaction/end'
    && !(doc.type === 'user/message' && doc.text.startsWith('用户：Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'))
  ))
  if (hits.length === 0) {
    recallCache.set(session, { key: cacheKey, text: '' })
    return ''
  }

  // Automatic injection is more expensive than an on-demand search. Drop
  // runtime snapshots, weak matches and near-duplicates; the explicit recall
  // tool still exposes every original event when the agent actually needs it.
  const seen = new Set()
  const lines = hits.filter((hit) => {
    if (hit.score < 1.25) return false
    const key = clip(hit.text.toLowerCase(), 160)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 2).map((hit) => {
    const doc = kernel.docs.get(hit.seq)
    const excerpt = doc === undefined ? hit.text : kernelSnippet(doc, parsed, 110)
    return `- [#${hit.seq}] ${typeLabel(hit.type)}：${clip(excerpt, 110)}`
  })
  if (lines.length === 0) {
    recallCache.set(session, { key: cacheKey, text: '' })
    return ''
  }
  const text = [
    '可能相关的旧记录（详情按 seq 回读）：',
    ...lines,
  ].join('\n')
  recallCache.set(session, { key: cacheKey, text })
  return text
}

// --- Categorized memory store ----------------------------------------------
// The anchor is a summary that costs tokens every step. A memory store is the
// opposite: the log is classified once as it arrives, kept by category, and
// returned only when the model asks. Classification is deterministic (pattern
// based), so it is reproducible across fork/resume and needs no model call.

/** Category ids, in the order the panel lists them. */
const MEMORY_KINDS = [
  'decision',   // a choice that was made and must not be re-litigated
  'constraint', // a rule, preference or requirement the user stated
  'problem',    // an error, failure or blocker that was hit
  'task',       // an outstanding TODO or next step
  'file',       // a file that matters, with why
  'command',    // a command worth repeating (build, test, deploy)
  'fact',       // a durable fact about the project or environment
]

const MEMORY_LABELS = {
  decision: '决定',
  constraint: '约束',
  problem: '问题',
  task: '待办',
  file: '文件',
  command: '命令',
  fact: '事实',
}

/**
 * Pattern rules, one pass per event. Order matters: the first matching kind
 * wins for an event, so specific signals (an error) beat generic ones (a fact).
 * Kept deliberately narrow — a wrong memory is worse than a missing one.
 */
const MEMORY_RULES = [
  {
    kind: 'problem',
    // Error text, stack markers, or an explicit failure report.
    test: /(error|exception|traceback|failed|failure|cannot|can't|unable|报错|失败|崩溃|不工作|打不开|异常|\bat .+\(.+:\d+\))/i,
  },
  {
    kind: 'decision',
    test: /(决定|定了|采用|改用|选择|就按|结论是|最终|decided|we'?ll use|going with|settled on|choose|chose)/i,
  },
  {
    kind: 'constraint',
    test: /(必须|不要|别|只能|禁止|要求|偏好|约定|规则|never|always|must|should not|don't|do not|only|required|prefer)/i,
  },
  {
    kind: 'task',
    test: /(TODO|FIXME|待办|下一步|接下来|还需要|尚未|还没|remaining|next step|still need|left to do)/i,
  },
  {
    kind: 'command',
    test: /(npm |pnpm |yarn |git |node |python |cargo |docker |kubectl |systemctl |Get-Content|Invoke-)/,
  },
  {
    kind: 'file',
    test: /([\w./\\-]+\.(?:js|mjs|ts|tsx|jsx|json|md|yml|yaml|css|html|py|rs|go|java|sh|ps1|toml|ini))(?::\d+)?/i,
  },
]

/** Categories whose memories are worth carrying even without a query match. */
const MEMORY_PINNED = new Set(['constraint', 'decision'])

/** Cap per category, so one noisy kind cannot crowd out the rest. */
const MEMORY_PER_KIND = 40

/** Identity of a memory: the same sentence said twice is one memory. */
function memoryKey(kind, text) {
  return `${kind}:${String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)}`
}

/**
 * Classify one event into zero or more memories. User messages are the strongest
 * signal (requirements and corrections live there); assistant messages carry
 * decisions and conclusions; tool calls carry files and commands.
 */
function classifyEvent(event, config) {
  const data = event.data ?? {}
  const kindOfSource = event.type === 'user/message'
    ? 'user'
    : event.type === 'assistant/message'
      ? 'assistant'
      : event.type === 'tool/call'
        ? 'tool'
        : null
  if (kindOfSource === null) return []

  const text = clip(
    event.type === 'user/message'
      ? blocksText(data.content)
      : event.type === 'assistant/message'
        ? blocksText(data.message?.content)
        // Tool-call arguments are a raw JSON string, not content blocks.
        : typeof data.arguments === 'string'
          ? data.arguments
          : String(data.arguments ?? ''),
    config.quoteChars,
  )

  if (text.length < (kindOfSource === 'tool' ? 12 : 8)) return []

  if (kindOfSource === 'tool') {
    // A tool call is a file touch or a command — never a decision or a rule,
    // and never a "problem" just because the arguments mention an error string.
    const found = []
    for (const { path } of toolPaths(data.name, data.arguments)) {
      found.push({ kind: 'file', text: `${clip(path, 120)}（${data.name}）` })
    }
    const command = commandOf(data.name, data.arguments)
    if (command !== null) found.push({ kind: 'command', text: command })
    return found.map((entry) => ({ ...entry, seq: event.seq, source: kindOfSource, time: event.time }))
  }

  const found = []
  for (const rule of MEMORY_RULES) {
    if (!rule.test.test(text)) continue
    // Commands are read from tool calls only: a sentence that merely mentions
    // "npm test" is a bug report, not a command worth repeating.
    if (rule.kind === 'command' || rule.kind === 'file') continue
    found.push({ kind: rule.kind, text: clip(text, 160) })
  }

  // An assistant summary with no rule hit is still a durable statement of state.
  if (found.length === 0 && kindOfSource === 'assistant') {
    found.push({ kind: 'fact', text: clip(text, 140) })
  }
  return found.map((entry) => ({ ...entry, seq: event.seq, source: kindOfSource, time: event.time }))
}

/** The command line behind a tool call, when it has one worth repeating. */
function commandOf(name, rawArgs) {
  if (typeof rawArgs !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const line = typeof parsed.command === 'string'
    ? parsed.command
    : typeof parsed.cmd === 'string'
      ? parsed.cmd
      : null
  if (line === null) return null
  const flat = clip(line, 160)
  return flat.length >= 4 ? flat : null
}

/** Per-session memory store, advanced event by event like the anchor fold. */
const memories = new WeakMap()

function emptyMemoryStore() {
  return { seq: -1, byKind: Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, []])) }
}

/** Fold one event into the store. Pure; returns the same reference when nothing changed. */
function foldMemory(store, event, config) {
  const entries = classifyEvent(event, config)
  if (entries.length === 0) return store

  let next = null
  for (const entry of entries) {
    const list = (next ?? store).byKind[entry.kind]
    const key = memoryKey(entry.kind, entry.text)
    if (list.some((prior) => prior.key === key)) continue
    next ??= {
      ...store,
      byKind: Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, [...store.byKind[kind]]])),
    }
    const bucket = next.byKind[entry.kind]
    bucket.push({ ...entry, key })
    if (bucket.length > MEMORY_PER_KIND) bucket.splice(0, bucket.length - MEMORY_PER_KIND)
  }
  return next ?? store
}

/** Advance the store to the session cursor, reusing the cached prefix. */
function memoryOf(session, config) {
  let store = memories.get(session)
  if (store === undefined || store.seq > session.seq) {
    store = emptyMemoryStore()
    memories.set(session, store)
  }
  for (let seq = store.seq + 1; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    store = foldMemory(store, event, config)
    store.seq = seq
  }
  store.seq = Math.max(store.seq, session.seq - 1)
  memories.set(session, store)
  return store
}

/** Counts per category, for the panel and the tool's header. */
function memoryCounts(store) {
  const counts = {}
  for (const kind of MEMORY_KINDS) counts[kind] = store.byKind[kind].length
  return counts
}

// --- Early compaction at the configured percentage -------------------------

/** Diagnostics: one JSONL line per compaction decision, so "no effect" is explainable. */
function traceCompaction(entry) {
  try {
    const file = settingsFile().replace(/settings\.json$/, 'trace.jsonl')
    let prior = ''
    try {
      prior = readFileSync(file, 'utf8')
    } catch {
      prior = ''
    }
    if (prior.length > 65_536) prior = prior.slice(-32_768)
      writeFileSync(file, `${prior}${new Date().toISOString()} ${JSON.stringify(entry)}\n`)
  } catch {
    // Diagnostics must never break a step.
  }
}

/** Hot-context occupancy, read the same way the composer's meter reads it. */
function occupancyOf(scope, session) {
  const pressure = scope.get?.('sessionProjections')?.stateOf?.(session, 'contextPressure')
  if (pressure !== undefined && Number.isFinite(pressure?.contextWindow)) {
    return {
      used: pressure.pressureTokens ?? pressure.surfaceTokens ?? 0,
      window: pressure.contextWindow,
    }
  }
  const measured = scope.get?.('tokenMeter')?.measure?.(session)
  return {
    used: measured?.totalTokens ?? measured?.surfaceTokens,
    window: session.requestContext?.()?.contextWindow,
  }
}

/**
 * Compact once the hot context reaches the configured share of the window.
 * Only the automatic harness path is left untouched in `auto` mode; here the
 * plugin asks the same compaction service for an explicit, turn-aligned region,
 * so the log still keeps everything and `context_recall` keeps reaching it.
 */
/**
 * Pull the cut back so nothing matching a protection needle is folded away.
 *
 * The first protected event inside the region becomes the new boundary, then
 * the boundary retreats to the nearest turn start (never splitting a pair). A
 * floor keeps the rule from paralyzing compaction: if honouring it would leave
 * under a quarter of the original region to archive, the base cut stands — a
 * protected phrase must not be able to disable compaction entirely.
 */
function shrinkForProtection(session, nodes, startIndex, endIndex, protect) {
  if (!Array.isArray(protect) || protect.length === 0) return endIndex

  const needles = protect.map((needle) => needle.toLowerCase()).filter((needle) => needle.length > 0)
  if (needles.length === 0) return endIndex

  let hitIndex = -1
  for (let index = startIndex; index <= endIndex; index += 1) {
    const text = eventText(session.eventAt(nodes[index])).toLowerCase()
    if (text.length === 0) continue
    if (needles.some((needle) => text.includes(needle))) {
      hitIndex = index
      break
    }
  }
  if (hitIndex < 0) return endIndex

  let next = hitIndex - 1
  while (next > startIndex + 1 && session.eventAt(nodes[next + 1])?.type !== 'user/message') next -= 1

  const floor = startIndex + Math.max(2, Math.floor((endIndex - startIndex) * 0.25))
  if (next <= startIndex + 1 || next < floor) return endIndex
  return next
}

/**
 * The region an early compaction folds when it fires: from the first non-system
 * node up to a turn boundary near 60% of the surface, never splitting a
 * tool-call/result pair and never swallowing the instruction in flight.
 *
 * Shared with the panel's preview, so what the panel promises is exactly what
 * the gate will do — the two must not drift apart.
 */
function archiveRegionOf(session, protect = []) {
  const surface = session?.surface
  if (surface === undefined || !Array.isArray(surface.nodes)) return { skip: 'no-surface' }

  const nodes = [...surface.nodes]
  if (nodes.length < 8) return { skip: 'few-nodes', nodes: nodes.length }

  const startIndex = nodes.findIndex((seq) => session.eventAt(seq)?.type !== 'system/message')
  if (startIndex < 0) return { skip: 'no-start' }

  // The newest user message is the instruction this open turn is working on;
  // folding it into the checkpoint would hide the very request in flight.
  let lastUserIndex = -1
  for (let index = nodes.length - 1; index > startIndex; index -= 1) {
    if (session.eventAt(nodes[index])?.type === 'user/message') {
      lastUserIndex = index
      break
    }
  }

  // Stop at a turn boundary near 60% of the surface, so recent turns stay
  // verbatim and the cut never splits a tool-call/result pair.
  let endIndex = Math.min(Math.floor(nodes.length * 0.6), lastUserIndex - 1)
  while (endIndex > startIndex + 1 && session.eventAt(nodes[endIndex + 1])?.type !== 'user/message') endIndex -= 1
  if (endIndex <= startIndex + 1 || session.eventAt(nodes[endIndex + 1])?.type !== 'user/message') {
    return { skip: 'no-boundary', startIndex, lastUserIndex, endIndex }
  }

  const baseEnd = endIndex
  endIndex = shrinkForProtection(session, nodes, startIndex, endIndex, protect)
  return { nodes, startIndex, endIndex, baseEnd, protected: endIndex !== baseEnd }
}

async function compactEarly(scope, session, agent, signal) {
  // Read the policy for *this* session: a threshold set in one conversation
  // must not decide when another one condenses.
  const policy = settingsFor(sessionIdOf(session))
  if (policy.mode !== 'custom') return traceCompaction({ skip: 'mode', mode: policy.mode })
  if (signal?.aborted) return traceCompaction({ skip: 'aborted' })

  // Resolve the service from the composition that owns it: the preset mounts it,
  // the profile root does not.
  const compaction = scope.get?.('compaction')
  if (typeof compaction?.compactRegion !== 'function') return traceCompaction({ skip: 'no-service' })

  const { used, window } = occupancyOf(scope, session)
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) {
    return traceCompaction({ skip: 'no-window', used, window })
  }
  const percent = Math.round((used / window) * 100)
  if (percent < policy.percent) return traceCompaction({ skip: 'below', percent, threshold: policy.percent })

  const now = Date.now()
  const previous = compactionAttempts.get(session) ?? 0
  if (now - previous < 45_000) return traceCompaction({ skip: 'throttled', percent })
  compactionAttempts.set(session, now)

  const region = archiveRegionOf(session, policy.protect)
  if (region.skip !== undefined) return traceCompaction({ skip: region.skip, ...region })
  const { nodes, startIndex, endIndex } = region

  try {
    const result = await compaction.compactRegion(nodes[startIndex], nodes[endIndex], agent, signal)
    traceCompaction({
      compacted: result.shadowedSeqs.length,
      tokens: result.shadowedTokenCount,
      percent,
      threshold: policy.percent,
    })
  } catch (error) {
    traceCompaction({ failed: String(error), percent, threshold: policy.percent })
    throw error
  }
}

/**
 * What the next early compaction would fold, computed without touching the
 * session: the count, the seq range, a couple of excerpted endpoints, and the
 * occupancy that decides when it fires. Purely a read, so the panel can show it
 * on every poll.
 */
function archivePreviewOf(scope, session, protect = []) {
  const region = archiveRegionOf(session, protect)
  if (region.skip !== undefined) return { available: false, reason: region.skip }

  const { nodes, startIndex, endIndex } = region
  const seqs = nodes.slice(startIndex, endIndex + 1)
  const { used, window } = occupancyOf(scope, session)
  const percent = Number.isFinite(used) && Number.isFinite(window) && window > 0
    ? Math.round((used / window) * 100)
    : 0
  const samples = []
  // Three endpoints are what a reader needs: where the region starts, the first
  // instruction inside it, and where it ends. Anything more is noise at 264px.
  const firstUserOffset = seqs.findIndex((seq) => session.eventAt(seq)?.type === 'user/message')
  const picks = [...new Set([0, firstUserOffset, seqs.length - 1])].filter((index) => index >= 0).sort((a, b) => a - b)
  for (const index of picks) {
    const seq = seqs[index]
    if (seq === undefined) continue
    const event = session.eventAt(seq)
    const text = eventText(event)
    if (text.length === 0) continue
    samples.push({ seq, type: event.type, text: text.slice(0, 140) })
  }
  return {
    available: true,
    count: seqs.length,
    total: nodes.length,
    from: seqs[0],
    to: seqs.at(-1),
    samples,
    protected: region.protected === true,
    used: percent > 0 ? used : 0,
    window: percent > 0 ? window : 0,
    percent,
  }
}

/**
 * Size of the retrieval index for one session, for the panel's monitoring row.
 * `kernelOf` advances the index to the session cursor, so this is exact at the
 * moment it is read rather than a stale count.
 */
function indexStatsOf(session) {
  const kernel = kernelOf(session)
  return { docs: kernel.docs.size, terms: kernel.postings.size, at: kernel.seq }
}

/** Resolve the live session behind an id, if this host is currently driving it. */function liveSessionOf(scope, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const agents = scope.get('agents')
  const live = typeof agents?.list === 'function' ? agents.list() : []
  for (const agent of live) {
    if (sessionIdOf(agent?.session) === sessionId) return agent.session
  }
  return undefined
}

/**
 * Run the threshold check before every step without ever blocking the step.
 *
 * `agent/pre-step` is a scoped waterfall, so the payload may omit the agent on
 * some compositions; fall back to the agent this process is currently driving.
 */
function registerEarlyCompaction(ctx) {
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent ?? ctx.get('agents')?.currentInitiator?.()
    const session = agent?.session
    const scope = agent?.ctx
    if (session === undefined || scope === undefined) {
      traceCompaction({ skip: 'no-agent', hasPayload: payload !== undefined })
      return next()
    }
    try {
      await compactEarly(scope, session, agent, payload?.signal)
    } catch (error) {
      ctx.logger?.warn?.(`context-anchor: early compaction skipped: ${String(error)}`)
    }
    return next()
  }))
}

// --- Panel settings over one authenticated host route ----------------------

/** Answer with JSON, never cached. */
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Read a small JSON body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8_192) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** What the panel needs to render the settings block for one session. */
function settingsPayload(scope, sessionId, config) {
  // A preset-mounted compaction backend is invisible from the profile root, so
  // ask the live agents too: whichever composition owns a session owns the
  // service that can actually compact it.
  const agents = scope.get('agents')
  const live = typeof agents?.list === 'function' ? agents.list() : []
  const fromAgents = live.some((agent) => agent?.ctx?.get?.('compaction') !== undefined)
  const scoped = typeof sessionId === 'string' && sessionId.length > 0
  const session = liveSessionOf(scope, sessionId)
  const policy = settingsFor(sessionId)
  return {
    settings: policy,
    defaults: settings,
    perSession: scoped,
    limits: { min: SETTINGS_MIN_PERCENT, max: SETTINGS_MAX_PERCENT },
    protectLimits: { maxItems: PROTECT_MAX_ITEMS, maxChars: PROTECT_MAX_CHARS },
    sessionCount: Object.keys(sessionPolicies).length,
    index: session === undefined ? undefined : indexStatsOf(session),
    anchor: anchorStatsOf(session),
    memory: session === undefined || config === undefined
      ? undefined
      : memoryCounts(memoryOf(session, config)),
    compactions: session === undefined || config === undefined
      ? undefined
      : compactionStatsOf(session, config),
    compaction: fromAgents || scope.get('compaction') !== undefined,
    preview: session === undefined ? undefined : archivePreviewOf(scope, session, policy.protect),
  }
}

/** Successful compactions seen in this session, plus the seq of the latest one. */
function compactionStatsOf(session, config) {
  if (session === undefined) return undefined
  const state = foldSession(session, config)
  return { count: state.compactions, lastSeq: state.lastCompactionSeq }
}

/**
 * `GET /settings` reads the policy, `POST /settings` replaces it. The route is
 * authenticated with the same connection check the shipped routes use, so the
 * panel talks to its own host half without widening the page's reach.
 */
function registerSettingsRoute(ctx, config) {
  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: SETTINGS_ROUTE,
      async handler(req, res) {
        const rejection = scope.connection.requestRejection(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, { error: rejection === 401 ? 'unauthenticated' : 'forbidden' })
          return
        }
        const url = new URL(req.url ?? SETTINGS_ROUTE, 'http://localhost')
        const action = url.pathname.slice(SETTINGS_ROUTE.length).replace(/^\/+|\/+$/g, '')
        if (action !== 'settings') {
          sendJson(res, 404, { error: 'unknown method' })
          return
        }
        // The panel names the session it is attached to; without one the route
        // reads and writes the global default.
        const querySession = url.searchParams.get('session') ?? undefined
        if (req.method === 'GET') {
          sendJson(res, 200, settingsPayload(scope, querySession, config))
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'GET or POST required' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const sessionId = typeof body?.session === 'string' && body.session.length > 0
            ? body.session
            : querySession
          // POST carries the page's Origin, so the panel reads through POST too.
          if (isObject(body) && body.action === 'read') {
            sendJson(res, 200, settingsPayload(scope, sessionId, config))
            return
          }
          if (isObject(body) && body.action === 'client-error') {
            // The page's only channel back here: a crashed slot entry reports
            // itself instead of failing as a silent dead click.
            traceCompaction({
              clientError: String(body.message ?? 'unknown').slice(0, 300),
              stack: String(body.stack ?? '').slice(0, 1500),
            })
            sendJson(res, 200, { ok: true })
            return
          }
          if (isObject(body) && body.action === 'delete') {
            // Delete per-session override; only valid when sessionId is present
            if (typeof sessionId === 'string' && sessionId.length > 0) {
              const { [sessionId]: _, ...rest } = sessionPolicies
              sessionPolicies = rest
              persistSettings(settings, sessionPolicies)
              sendJson(res, 200, settingsPayload(scope, sessionId, config))
            } else {
              sendJson(res, 400, { error: 'delete requires a session id' })
            }
            return
          }
          if (isObject(body) && body.action === 'clear-sessions') {
            // Drop every per-session override at once, keeping the global default.
            sessionPolicies = Object.create(null)
            persistSettings(settings, sessionPolicies)
            sendJson(res, 200, settingsPayload(scope, sessionId, config))
            return
          }
          if (isObject(body) && body.action === 'export') {
            // Export complete settings: global + all session overrides
            sendJson(res, 200, {
              settings,
              sessions: sessionPolicies,
            })
            return
          }
          if (isObject(body) && body.action === 'import') {
            // Import complete settings; replaces everything
            const imported = body.data
            if (!isObject(imported)) {
              sendJson(res, 400, { error: 'import data must be an object' })
              return
            }
            settings = normalizeSettings(imported.settings ?? imported)
            sessionPolicies = isObject(imported.sessions) ? imported.sessions : Object.create(null)
            // Normalize each session policy
            for (const sid in sessionPolicies) {
              if (Object.prototype.hasOwnProperty.call(sessionPolicies, sid)) {
                sessionPolicies[sid] = normalizeSettings(sessionPolicies[sid])
              }
            }
            persistSettings(settings, sessionPolicies)
            sendJson(res, 200, { success: true })
            return
          }
          const next = normalizeSettings(body)
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            sessionPolicies = { ...sessionPolicies, [sessionId]: next }
          } else {
            settings = next
          }
          persistSettings(settings, sessionPolicies)
          sendJson(res, 200, settingsPayload(scope, sessionId, config))
        } catch (error) {
          scope.logger?.warn?.(`context-anchor: settings save failed: ${String(error)}`)
          sendJson(res, 500, { error: 'settings could not be saved' })
        }
      },
    }))
  })
}

const RECALL_DESCRIPTION =
  '把一个检索指令交给本地检索内核：它在完整会话日志的倒排索引上做相关度排序（BM25），'
  + '覆盖更早的每条用户消息、助手消息和工具结果，以及已被压缩摘要掉的历史，返回原文片段与 seq 编号。'
  + '支持 "精确短语"、-排除词，以及 type:user|assistant|tool|call、tool:read、file:Temp、after:120、before:300 这类过滤。'
  + '片段中被 «» 括起的是命中的词，不是原文的一部分。'
  + '需要本会话早先的事实、决定、路径、命令或原话时用它，不要猜。'

const EXPAND_DESCRIPTION =
  '按 seq 区间逐字读取完整会话日志，包括被压缩隐藏的历史。'
  + 'seq 编号来自 context_recall 的结果（或上下文锚点）；用它读取前后文。'

const MEMORY_DESCRIPTION =
  '读取本会话自动分类存放的记忆：决定、约束、问题、待办、文件、命令、事实。'
  + '日志到达时按固定规则归类，不需要模型先总结。'
  + '问"之前定了什么/有什么要求/上次报错是什么"这类问题时先读它，比全文检索快且省 token。'
  + '需要原话上下文时，再用 context_expand 按返回的 seq 读取。'

/** Build the two recall tools. Self-contained: no framework imports needed. */
function recallTools(config) {
  return [
    {
      name: 'context_recall',
      description: RECALL_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: '要在完整会话日志里查找的字面文本或正则表达式。',
          },
          regex: {
            type: 'boolean',
            description: '把 query 当作 JavaScript 正则表达式。默认 false（不区分大小写的子串匹配）。',
          },
          limit: {
            type: 'integer',
            description: '最多返回多少条匹配，1–40，默认 12。',
          },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            matches: { type: 'integer' },
            total: { type: 'integer' },
          },
          required: ['text', 'matches', 'total'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute(args, exec) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query.length === 0) throw new Error('context_recall 需要非空的 query')
        const limit = Math.min(40, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 12))
        const session = exec.agent?.session
        if (session === undefined) throw new Error('context_recall 需要一个所属的 agent 会话')

        const kernel = kernelOf(session)
        const started = Date.now()

        // A regex is not something an inverted index can answer; the log is
        // small enough for one literal pass, and the index still supplies the
        // documents.
        if (args?.regex === true) {
          let pattern
          try {
            pattern = new RegExp(query, 'i')
          } catch (error) {
            throw new Error(`context_recall 的正则表达式无效：${error instanceof Error ? error.message : String(error)}`)
          }
          const hits = []
          let total = 0
          for (const doc of kernel.docs.values()) {
            if (!pattern.test(doc.text)) continue
            total += 1
            if (hits.length < limit) hits.push(doc)
          }
          const header = `检索内核（正则直扫）：${kernel.docs.size} 篇文档，${Date.now() - started} ms；命中 ${total} 条。`
          if (total === 0) {
            return {
              text: `${header}\n没有找到 ${JSON.stringify(query)}。可以换个更短的词，或对你已知的 seq 用 context_expand。`,
              matches: 0,
              total: 0,
            }
          }
          const body = hits.map((doc) => `[#${doc.seq}] ${typeLabel(doc.type)}\n${clip(doc.text, 322)}`).join('\n\n')
          const note = total > hits.length ? `\n\n（另有 ${total - hits.length} 条未显示；调大 limit 或缩小查询范围。）` : ''
          return {
            text: `${header}\n\n${body}${note}\n\n带上这些 seq 调 context_expand({ from, to })，可以逐字读取前后文。`,
            matches: hits.length,
            total,
          }
        }

        const parsed = parseQuery(query)
        const { hits, total, stats } = kernelSearch(kernel, parsed, limit)
        const header = `检索内核：${stats.terms} 个词条 / ${stats.docs} 篇文档，${Date.now() - started} ms；`
          + `命中 ${total} 条${total > hits.length ? `（按相关度显示前 ${hits.length} 条）` : ''}。`

        // The caller is a model deciding its next move, not a human browsing
        // results: close every answer with the one action that follows from this
        // result shape, so it neither re-queries blindly nor reads everything.
        const nextStep = () => {
          const filters = Object.keys(parsed.filters)
          if (total === 0) {
            if (filters.length > 0) return `下一步：去掉 ${filters.map((key) => `${key}:`).join('/')} 重新查——是过滤条件把结果清空的。`
            if (parsed.phrases.length > 0) return '下一步：去掉引号，改用 2-3 个关键词；精确短语可能太严。'
            return '下一步：换更短、更常见的词（路径、命令、错误码比整句好搜），或对已知 seq 用 context_expand。'
          }
          if (total > hits.length) return `下一步：加 "短语"、type:/tool:/after: 收窄，或调大 limit（当前 ${hits.length}）；现在只给了前 ${hits.length} 条。`
          return '下一步：挑最相关的 seq 调 context_expand({ from, to }) 读原文；不够再换词重搜。'
        }

        if (total === 0) {
          return {
            text: `${header}\n没有找到 ${JSON.stringify(query)}。\n${nextStep()}`,
            matches: 0,
            total: 0,
          }
        }

        const body = hits.map((hit) => {
          const doc = kernel.docs.get(hit.seq)
          const excerpt = doc === undefined ? hit.text : kernelSnippet(doc, parsed, 320)
          return `[#${hit.seq}] ${typeLabel(hit.type)} · 相关度 ${hit.score.toFixed(2)}\n${excerpt}`
        }).join('\n\n')

        return {
          text: `${header}\n\n${body}\n\n${nextStep()}`,
          matches: hits.length,
          total,
        }
      },
    },
    {
      name: 'context_expand',
      description: EXPAND_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: {
            type: 'integer',
            description: '起始 seq（含）。',
          },
          to: {
            type: 'integer',
            description: '结束 seq（含）。默认等于 from。',
          },
          maxChars: {
            type: 'integer',
            description: `输出字符上限，200–${config.expandMaxChars}。默认 ${Math.min(4000, config.expandMaxChars)}。`,
          },
        },
        required: ['from'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            events: { type: 'integer' },
          },
          required: ['text', 'events'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) throw new Error('context_expand 需要一个所属的 agent 会话')
        const from = Math.max(0, Number.isInteger(args?.from) ? args.from : 0)
        const to = Math.min(session.seq - 1, Math.max(from, Number.isInteger(args?.to) ? args.to : from))
        const budget = Math.min(config.expandMaxChars, Math.max(200, Number.isInteger(args?.maxChars) ? args.maxChars : 20000))

        const parts = []
        let used = 0
        let events = 0
        for (let seq = from; seq <= to; seq += 1) {
          const event = session.eventAt(seq)
          if (event === undefined) continue
          const text = eventText(event)
          if (text.length === 0) continue
          const line = `[#${seq}] ${text}`
          if (used + line.length > budget) {
            parts.push(`… 输出已达 ${budget} 字符上限，停在 seq ${seq}；继续请用 context_expand({ from: ${seq} })。`)
            break
          }
          parts.push(line)
          used += line.length + 1
          events += 1
        }

        if (events === 0) {
          return {
            text: `seq ${from}..${to} 之间没有可读的日志事件；会话当前结束于 seq ${session.seq - 1}。`,
            events: 0,
          }
        }
        return {
          text: `日志 seq ${from}..${to} 原文（${events} 条事件，${used} 字符）：\n\n${parts.join('\n')}`,
          events,
        }
      },
    },
    {
      name: 'context_memory',
      description: MEMORY_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: [...MEMORY_KINDS, 'all'],
            description: '要读的分类；all 表示全部。默认 all。',
          },
          query: {
            type: 'string',
            description: '可选：只返回包含这些词条的条目（多个词用空格分隔）。',
          },
          limit: {
            type: 'integer',
            description: '每个分类最多返回多少条，1–40，默认 8。',
          },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            counts: { type: 'object' },
            total: { type: 'integer' },
          },
          required: ['text', 'counts', 'total'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) throw new Error('context_memory 需要一个所属的 agent 会话')

        const store = memoryOf(session, config)
        const counts = memoryCounts(store)
        const wanted = MEMORY_KINDS.includes(args?.kind) ? [args.kind] : MEMORY_KINDS
        const limit = Math.min(40, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 8))
        const terms = typeof args?.query === 'string'
          ? kernelTokens(args.query)
          : []

        const header = MEMORY_KINDS
          .map((kind) => `${MEMORY_LABELS[kind]} ${counts[kind]}`)
          .join(' · ')

        const blocks = []
        let total = 0
        for (const kind of wanted) {
          let entries = store.byKind[kind]
          if (terms.length > 0) {
            entries = entries.filter((entry) => {
              const lower = entry.text.toLowerCase()
              return terms.some((term) => lower.includes(term))
            })
          }
          if (entries.length === 0) continue
          total += entries.length
          // Newest first: a later decision supersedes an earlier one.
          const shown = [...entries].reverse().slice(0, limit)
          blocks.push([
            `## ${MEMORY_LABELS[kind]}（${entries.length} 条）`,
            ...shown.map((entry) => `- [#${entry.seq}] ${entry.text}`),
            ...(entries.length > shown.length ? [`（更早 ${entries.length - shown.length} 条未显示，可调大 limit 或加 query）`] : []),
          ].join('\n'))
        }

        if (blocks.length === 0) {
          return {
            text: `分类记忆：${header}\n没有符合条件的记忆。`,
            counts,
            total: 0,
          }
        }
        return {
          text: `分类记忆：${header}\n\n${blocks.join('\n\n')}\n\n需要原文上下文时，用 context_expand 按上面的 seq 读取。`,
          counts,
          total,
        }
      },
    },
  ]
}

/** Resolve user config defensively; every field is optional. */
function resolveConfig(raw) {
  const source = isObject(raw) ? raw : {}
  const int = (value, fallback, min, max) => (
    Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
  )
  return {
    maxAnchorChars: int(source.maxAnchorChars, DEFAULTS.maxAnchorChars, 400, 20000),
    recentUserMessages: int(source.recentUserMessages, DEFAULTS.recentUserMessages, 1, 12),
    recentFiles: int(source.recentFiles, DEFAULTS.recentFiles, 0, 40),
    quoteChars: int(source.quoteChars, DEFAULTS.quoteChars, 40, 600),
    order: Number.isFinite(source.order) ? source.order : DEFAULTS.order,
    expandMaxChars: int(source.expandMaxChars, 60000, 1000, 400000),
    disabled: source.disabled === true,
  }
}

/**
 * Register the anchor context and the recall tools on the plugin's own context,
 * so unloading the plugin removes both.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (config.disabled) return

  ctx.effect(() => {
    const disposeContext = ctx.systemPrompt.context({
      name: 'context-anchor:live',
      order: config.order,
      interpolate: false,
      required: false,
      text: (context) => {
        const agent = context?.agent
        const session = agent?.session
        if (session === undefined) return ''
        try {
          return renderAnchor(session, config)
        } catch (error) {
          ctx.logger?.warn?.(`context-anchor: failed to rebuild the anchor: ${String(error)}`)
          return ''
        }
      },
    })
    return disposeContext
  })

  for (const tool of recallTools(config)) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  // The composer's "cached locally" reading: the recallable log, priced in tokens.
  registerCacheProjection(ctx)

  // The panel's memory policy: persisted next to the harness home, applied live.
  loadSettings()
  registerSettingsRoute(ctx, config)
  registerEarlyCompaction(ctx)

  ctx.logger?.info?.('context-anchor: live anchor context and full-log recall tools registered')
}

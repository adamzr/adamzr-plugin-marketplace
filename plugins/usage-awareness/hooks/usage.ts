/**
 * Pure logic of the usage-awareness mod: merging the engine's figures with
 * the claude.ai usage endpoint, judging thresholds and ceilings, and
 * formatting what the model and the person read. No `$` here, so every
 * function is unit-testable.
 */
import type { SessionRateLimit } from 'claude-code'

import type {
  ExtraUsage,
  FiredAlert,
  PolicyMode,
  UsageLevel,
  UsagePolicy,
  UsageSnapshot,
  UsageTracking,
  UsageWindow,
} from '../types'

export const PLUGIN = 'usage-awareness'
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** The thresholds and defaults read from the plugin's userConfig. */
export type Thresholds = {
  warnPercent: number
  criticalPercent: number
  allowExtraUsage: boolean
  enforce: boolean
  pollMinutes: number
}

export const readThresholds = (
  options: Readonly<Record<string, unknown>>,
): Thresholds => {
  const num = (key: string, fallback: number): number => {
    const v = Number(options[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  const bool = (key: string, fallback: boolean): boolean =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback
  const warn = num('warnPercent', 80)
  const critical = Math.max(warn, num('criticalPercent', 95))
  return {
    warnPercent: warn,
    criticalPercent: critical,
    allowExtraUsage: bool('allowExtraUsage', false),
    enforce: bool('enforce', true),
    pollMinutes: num('pollMinutes', 5),
  }
}

export const defaultPolicy = (t: Thresholds, now: string): UsagePolicy => ({
  allowExtraUsage: t.allowExtraUsage,
  mode: 'block',
  setAt: now,
})

export const emptyTracking = (): UsageTracking => ({
  fired: {},
  extraSpendUsd: 0,
  lastCostUsd: 0,
})

// ---------------------------------------------------------------- labels

const LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day (all models)',
  seven_day_opus: 'Opus 7-day',
  seven_day_sonnet: 'Sonnet 7-day',
  seven_day_oauth_apps: 'OAuth apps 7-day',
  spend_limit: 'Spend limit',
}

export const labelFor = (kind: string): string => {
  if (kind.startsWith('model_scoped:')) {
    return `${kind.slice('model_scoped:'.length)} 7-day`
  }
  return LABELS[kind] ?? kind.replaceAll('_', ' ')
}

// --------------------------------------------------------- endpoint parse

/** The usage endpoint's answer, reduced to what the mod uses. */
export type OauthUsage = {
  windows: UsageWindow[]
  extraUsage?: ExtraUsage
}

const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** `resets_at` arrives as an ISO string or epoch seconds; answer ISO. */
export const toIso = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000
    return new Date(ms).toISOString()
  }
  if (typeof v === 'string' && Number.isFinite(Date.parse(v))) {
    return new Date(v).toISOString()
  }
  return undefined
}

const round1 = (n: number): number => Math.round(n * 10) / 10

const windowOf = (kind: string, raw: unknown): UsageWindow | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const utilization = asNumber(r.utilization)
  if (utilization === null) return null
  return {
    kind,
    label: labelFor(kind),
    percentUsed: round1(utilization),
    resetsAt: toIso(r.resets_at),
  }
}

/** Tolerant parse of the usage endpoint's JSON; null when it is not usage. */
export const parseOauthUsage = (json: unknown): OauthUsage | null => {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  const windows: UsageWindow[] = []
  for (const kind of [
    'five_hour',
    'seven_day',
    'seven_day_opus',
    'seven_day_sonnet',
    'seven_day_oauth_apps',
  ]) {
    const w = windowOf(kind, j[kind])
    if (w) windows.push(w)
  }
  if (Array.isArray(j.model_scoped)) {
    for (const entry of j.model_scoped) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const name =
        typeof e.display_name === 'string' && e.display_name.trim()
          ? e.display_name.trim()
          : 'Model'
      const w = windowOf(`model_scoped:${name}`, e)
      if (w) windows.push(w)
    }
  }
  // Newer answers list every window under `limits`, the per-model weekly ones as
  // `weekly_scoped` with a model scope (`scope.model.display_name`, e.g. Fable).
  if (Array.isArray(j.limits)) {
    const have = new Set(windows.map(w => w.kind))
    for (const entry of j.limits) {
      if (!entry || typeof entry !== 'object') continue
      const l = entry as Record<string, unknown>
      const kindRaw = typeof l.kind === 'string' ? l.kind : ''
      const percent = asNumber(l.percent)
      if (percent === null) continue
      const scope = l.scope && typeof l.scope === 'object' ? (l.scope as Record<string, unknown>) : undefined
      const model = scope?.model && typeof scope.model === 'object' ? (scope.model as Record<string, unknown>) : undefined
      const name = typeof model?.display_name === 'string' && model.display_name.trim() ? model.display_name.trim() : undefined
      let kind: string
      if (kindRaw === 'session') kind = 'five_hour'
      else if (kindRaw === 'weekly_all') kind = 'seven_day'
      else if (kindRaw === 'weekly_scoped' && name) kind = `model_scoped:${name}`
      else if (name) kind = `model_scoped:${name}`
      else kind = kindRaw || 'limit'
      if (have.has(kind)) continue
      have.add(kind)
      windows.push({ kind, label: labelFor(kind), percentUsed: round1(percent), resetsAt: toIso(l.resets_at) })
    }
  }
  let extraUsage: ExtraUsage | undefined
  const x = j.extra_usage
  if (x && typeof x === 'object') {
    const e = x as Record<string, unknown>
    const cents = (v: unknown): number | null => {
      const n = asNumber(v)
      return n === null ? null : Math.round(n) / 100
    }
    extraUsage = {
      isEnabled: e.is_enabled === true,
      usedUsd: cents(e.used_credits),
      monthlyLimitUsd: cents(e.monthly_limit),
      utilization: asNumber(e.utilization),
      currency:
        typeof e.currency === 'string' && e.currency
          ? e.currency.toUpperCase()
          : 'USD',
    }
  }
  if (windows.length === 0 && !extraUsage) return null
  return { windows, extraUsage }
}

// ----------------------------------------------------------------- merge

export type EngineFigures = {
  rateLimits: readonly SessionRateLimit[]
  cost?: { usd: number }
  context?: { percent?: number | null }
}

/**
 * The engine's windows win for the kinds both report; the endpoint adds the
 * per-model windows and the credits. A simulated percent, when set, is one
 * more window so every path (status, band, warnings, block) sees it.
 */
export const mergeSnapshot = (
  engine: EngineFigures,
  oauth: OauthUsage | null | undefined,
  oauthState: UsageSnapshot['oauth'],
  now: string,
  simulated?: number,
): UsageSnapshot => {
  const byKind = new Map<string, UsageWindow>()
  for (const w of oauth?.windows ?? []) byKind.set(w.kind, w)
  for (const r of engine.rateLimits) {
    byKind.set(r.kind, {
      kind: r.kind,
      label: labelFor(r.kind),
      percentUsed: round1(r.percentUsed),
      resetsAt: toIso(r.resetsAt),
    })
  }
  if (simulated !== undefined) {
    byKind.set('simulated', {
      kind: 'simulated',
      label: 'SIMULATED (test)',
      percentUsed: simulated,
      resetsAt: new Date(Date.parse(now) + 60 * 60 * 1000).toISOString(),
    })
  }
  const contextPercent = engine.context?.percent
  return {
    at: now,
    windows: [...byKind.values()],
    sessionCostUsd: engine.cost?.usd,
    contextPercent:
      typeof contextPercent === 'number' ? round1(contextPercent) : undefined,
    extraUsage: oauth?.extraUsage,
    oauth: oauthState,
    simulated,
  }
}

// ------------------------------------------------------------- judgement

export const levelFor = (percent: number, t: Thresholds): UsageLevel => {
  if (percent >= 100) return 'exhausted'
  if (percent >= t.criticalPercent) return 'critical'
  if (percent >= t.warnPercent) return 'warn'
  return 'ok'
}

const RANK: Record<UsageLevel, number> = { ok: 0, warn: 1, critical: 2, exhausted: 3 }

/** Plan windows: the ones a subscription counts; a gateway spend limit too. */
const isPlanWindow = (w: UsageWindow): boolean =>
  w.kind !== 'seven_day_oauth_apps'

export const worstWindow = (s: UsageSnapshot): UsageWindow | undefined =>
  s.windows
    .filter(isPlanWindow)
    .reduce<UsageWindow | undefined>(
      (worst, w) => (!worst || w.percentUsed > worst.percentUsed ? w : worst),
      undefined,
    )

export const isExhausted = (s: UsageSnapshot): UsageWindow | undefined =>
  s.windows.filter(isPlanWindow).find(w => w.percentUsed >= 100)

export type Alert = { window: UsageWindow; level: UsageLevel }

export type Verdict = {
  level: UsageLevel
  worst?: UsageWindow
  newAlerts: Alert[]
  /** Why work must stop now; absent while nothing is exceeded. */
  blockedReason?: string
  /** The block that stood is over (its window reset or ceiling lifted). */
  unblocked: boolean
  tracking: UsageTracking
}

const money = (n: number): string => `$${n.toFixed(2)}`

/**
 * Judges a snapshot against the policy. Pure: answers new tracking rather
 * than mutating. Alerts fire once per (window, level) and again only once the
 * window has reset (its percent fell well below the fired level, or its
 * resetsAt moved).
 */
export const evaluate = (
  s: UsageSnapshot,
  policy: UsagePolicy,
  t: Thresholds,
  prior: UsageTracking,
): Verdict => {
  const fired: Record<string, FiredAlert> = { ...prior.fired }
  const newAlerts: Alert[] = []

  // Extra spend: this session's cost accrued while a plan window is exhausted.
  const cost = s.sessionCostUsd ?? prior.lastCostUsd
  const delta = Math.max(0, cost - prior.lastCostUsd)
  const exhausted = isExhausted(s)
  const extraSpendUsd = prior.extraSpendUsd + (exhausted ? delta : 0)

  let level: UsageLevel = 'ok'
  const worst = worstWindow(s)
  for (const w of s.windows.filter(isPlanWindow)) {
    const lv = levelFor(w.percentUsed, t)
    if (RANK[lv] > RANK[level]) level = lv
    const was = fired[w.kind]
    const hasReset =
      was !== undefined &&
      (w.percentUsed < Math.max(0, thresholdOf(was.level, t) - 10) ||
        (was.resetsAt !== undefined &&
          w.resetsAt !== undefined &&
          was.resetsAt !== w.resetsAt &&
          w.percentUsed < thresholdOf(was.level, t)))
    if (hasReset) delete fired[w.kind]
    const nowFired = fired[w.kind]
    if (lv !== 'ok' && (!nowFired || RANK[lv] > RANK[nowFired.level])) {
      fired[w.kind] = { level: lv, resetsAt: w.resetsAt }
      newAlerts.push({ window: w, level: lv })
    }
  }

  let blockedReason: string | undefined
  if (policy.stopAtPercent !== undefined && worst && worst.percentUsed >= policy.stopAtPercent) {
    blockedReason = `the ${worst.label} window is at ${worst.percentUsed}% and this session's policy says stop at ${policy.stopAtPercent}%`
  } else if (exhausted && !policy.allowExtraUsage) {
    blockedReason = `the ${exhausted.label} window is exhausted (${exhausted.percentUsed}%) and extra usage is not allowed in this session`
  } else if (
    policy.creditCeilingUsd !== undefined &&
    extraSpendUsd - (policy.creditBaselineUsd ?? 0) >= policy.creditCeilingUsd
  ) {
    blockedReason = `this session has spent ${money(extraSpendUsd - (policy.creditBaselineUsd ?? 0))} of extra usage, at its ceiling of ${money(policy.creditCeilingUsd)}`
  } else if (
    policy.sessionCostCeilingUsd !== undefined &&
    cost >= policy.sessionCostCeilingUsd
  ) {
    blockedReason = `this session's cost is ${money(cost)}, at its ceiling of ${money(policy.sessionCostCeilingUsd)}`
  }

  const tracking: UsageTracking = {
    fired,
    extraSpendUsd,
    lastCostUsd: cost,
    blockedReason,
    blockedAt: blockedReason ? (prior.blockedReason ? prior.blockedAt : s.at) : undefined,
  }
  return {
    level,
    worst,
    newAlerts,
    blockedReason,
    unblocked: prior.blockedReason !== undefined && blockedReason === undefined,
    tracking,
  }
}

const thresholdOf = (level: UsageLevel, t: Thresholds): number =>
  level === 'exhausted' ? 100 : level === 'critical' ? t.criticalPercent : level === 'warn' ? t.warnPercent : 0

// ------------------------------------------------------------ formatting

const pad = (n: number): string => String(n).padStart(2, '0')

/** `Oct 25, 2026 3:10 pm` in the host's local time zone. */
export const localTime = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const month = d.toLocaleString('en-US', { month: 'short' })
  let h = d.getHours()
  const ampm = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${month} ${d.getDate()}, ${d.getFullYear()} ${h}:${pad(d.getMinutes())} ${ampm}`
}

export const relative = (iso: string, nowIso: string): string => {
  const ms = Date.parse(iso) - Date.parse(nowIso)
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 48) return m ? `in ${h}h ${m}m` : `in ${h}h`
  const d = Math.floor(h / 24)
  return `in ${d}d ${h % 24}h`
}

/** A one-shot CronCreate expression (local time) for one minute past a reset. */
export const cronFor = (iso: string): string | undefined => {
  const d = new Date(Date.parse(iso) + 60 * 1000)
  if (Number.isNaN(d.getTime())) return undefined
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
}

const shortLabel = (w: UsageWindow): string => {
  if (w.kind === 'five_hour') return '5h'
  if (w.kind === 'seven_day') return '7d'
  if (w.kind === 'seven_day_opus') return 'Opus'
  if (w.kind === 'seven_day_sonnet') return 'Sonnet'
  if (w.kind === 'spend_limit') return 'spend'
  if (w.kind === 'simulated') return 'SIM'
  if (w.kind.startsWith('model_scoped:')) return w.kind.slice('model_scoped:'.length)
  return w.kind
}

/** The status-line entry: `5h 42% · 7d 61% · Fable 30% · $12.40`. */
export const statusText = (s: UsageSnapshot | null, tracking?: UsageTracking): string => {
  if (!s) return 'usage: …'
  const parts = s.windows
    .filter(isPlanWindow)
    .map(w => `${shortLabel(w)} ${Math.round(w.percentUsed)}%`)
  if (s.sessionCostUsd !== undefined) parts.push(money(s.sessionCostUsd))
  if (parts.length === 0) parts.push('usage: no windows reported')
  if (tracking?.blockedReason) parts.unshift('BLOCKED')
  return parts.join(' · ')
}

export const policyText = (p: UsagePolicy): string => {
  const lines: string[] = []
  lines.push(
    p.allowExtraUsage
      ? 'Extra usage (credits): allowed in this session'
      : 'Extra usage (credits): NOT allowed in this session (the mod blocks once a window is exhausted)',
  )
  if (p.creditCeilingUsd !== undefined) {
    lines.push(`Credit ceiling: ${money(p.creditCeilingUsd)} of extra usage, counted from when it was set`)
  }
  if (p.sessionCostCeilingUsd !== undefined) {
    lines.push(`Session cost ceiling: ${money(p.sessionCostCeilingUsd)}`)
  }
  if (p.stopAtPercent !== undefined) {
    lines.push(`Stop when any window reaches ${p.stopAtPercent}%`)
  }
  lines.push(`At a ceiling: ${p.mode === 'block' ? 'deny tool calls and abort the turn' : 'warn only'}`)
  if (p.note) lines.push(`Note: ${p.note}`)
  return lines.join('\n')
}

/** What `get_usage` and `/usage-aware` print. */
export const formatForModel = (
  s: UsageSnapshot | null,
  policy: UsagePolicy,
  tracking: UsageTracking,
  t: Thresholds,
  nowIso: string,
): string => {
  const out: string[] = []
  if (!s) {
    out.push('No usage reading yet (the first API response reports the windows).')
  } else {
    const plan = s.windows.filter(isPlanWindow)
    if (plan.length === 0) {
      out.push(
        'No rate-limit windows reported. This session is not on a subscription (API key, Bedrock, Vertex or Foundry), so only session cost applies.',
      )
    } else {
      out.push('| Window | Used | Resets | | Resume cron (one-shot, local time) |')
      out.push('| --- | ---: | --- | --- | --- |')
      for (const w of plan) {
        const lv = levelFor(w.percentUsed, t)
        const flag = lv === 'ok' ? '' : lv.toUpperCase()
        const reset = w.resetsAt ? `${localTime(w.resetsAt)} (${relative(w.resetsAt, nowIso)})` : 'unknown'
        const cron = w.resetsAt ? `\`${cronFor(w.resetsAt)}\`` : ''
        out.push(`| ${w.label} | ${w.percentUsed}% | ${reset} | ${flag} | ${cron} |`)
      }
    }
    const extra: string[] = []
    if (s.sessionCostUsd !== undefined) extra.push(`Session cost so far: ${money(s.sessionCostUsd)}`)
    if (s.contextPercent !== undefined) extra.push(`Context window: ${s.contextPercent}% full`)
    if (s.extraUsage) {
      const x = s.extraUsage
      const used = x.usedUsd === null ? 'unknown' : money(x.usedUsd)
      const limit = x.monthlyLimitUsd === null ? 'no monthly limit' : `${money(x.monthlyLimitUsd)} monthly limit`
      extra.push(
        `Extra usage (account-wide, this billing period): ${x.isEnabled ? 'enabled' : 'not enabled'}; ${used} used, ${limit}`,
      )
    } else if (s.oauth === 'unavailable') {
      extra.push('Extra-usage credits: not available for this login.')
    } else if (s.oauth === 'error') {
      extra.push('Extra-usage credits: the usage endpoint could not be read (will retry).')
    }
    if (tracking.extraSpendUsd > 0) {
      extra.push(`Extra usage spent by this session: ${money(tracking.extraSpendUsd)}`)
    }
    if (s.simulated !== undefined) {
      extra.push(`A SIMULATED window at ${s.simulated}% is in effect (/usage-aware simulate off to clear).`)
    }
    out.push('', ...extra)
  }
  out.push('', 'Policy for this session:', policyText(policy))
  out.push('', `Thresholds: warn at ${t.warnPercent}%, critical at ${t.criticalPercent}%.`)
  if (tracking.blockedReason) {
    out.push('', `BLOCKED: ${tracking.blockedReason}.`, 'Tool calls are denied until the user runs /usage-aware lift (or /usage-aware clear), or the window resets.')
  }
  const worst = s ? worstWindow(s) : undefined
  if (worst) {
    const lv = levelFor(worst.percentUsed, t)
    if (lv === 'ok') {
      out.push('', `Headroom: the tightest window is ${worst.label} at ${worst.percentUsed}%. Fine to continue.`)
    } else if (lv === 'warn') {
      out.push('', `Headroom: ${worst.label} is at ${worst.percentUsed}% (warn). Finish the current unit of work, avoid starting new large parallel work, and plan a checkpoint.`)
    } else {
      out.push('', `Headroom: ${worst.label} is at ${worst.percentUsed}% (${lv}). Checkpoint now (see the protocol in your instructions) and ask the user before continuing into extra usage.`)
    }
  }
  return out.join('\n')
}

/** The row injected into the conversation when a threshold is crossed. */
export const warningText = (
  alert: Alert,
  s: UsageSnapshot,
  policy: UsagePolicy,
  t: Thresholds,
  nowIso: string,
): string => {
  const w = alert.window
  const reset = w.resetsAt ? `${localTime(w.resetsAt)} (${relative(w.resetsAt, nowIso)})` : 'unknown'
  const cron = w.resetsAt ? cronFor(w.resetsAt) : undefined
  const head = `[usage-awareness] ${alert.level.toUpperCase()}: the ${w.label} usage window is at ${w.percentUsed}%. It resets ${reset}.`
  if (alert.level === 'warn') {
    return [
      head,
      `You are past the ${t.warnPercent}% warning line. Finish the current unit of work, do not start new large parallel work or spawn more subagents than needed, and plan a checkpoint. Call get_usage to re-check. Policy: ${policy.allowExtraUsage ? 'extra usage is allowed' : 'extra usage is NOT allowed'} in this session.`,
    ].join('\n')
  }
  const protocol = [
    'Checkpoint protocol, do it now:',
    '1. Stop spawning new subagents. Tell every running subagent (SendMessage, or TaskStop if it does not respond) to stop and write its progress to progress/<agent-name>.md, then return.',
    '2. Write PROGRESS.md at the project root: current state, what is done, what is next, decisions made, and links to every progress/*.md file, so work can resume from these files alone.',
    '3. Then stop and ask the user whether to continue into extra usage (credits).',
    cron
      ? `4. If the user wants work to resume after the reset, schedule it with CronCreate: cron "${cron}", recurring: false, prompt "Read PROGRESS.md and continue the work."`
      : '4. If the user wants work to resume after the reset, schedule it with CronCreate at the reset time.',
  ]
  if (alert.level === 'critical') {
    return [
      head,
      `You are past the ${t.criticalPercent}% critical line. ${policy.allowExtraUsage ? 'Extra usage is allowed in this session, but checkpoint first.' : 'Extra usage is NOT allowed in this session: once this window hits 100% the mod will deny tool calls and abort the turn.'}`,
      ...protocol,
    ].join('\n')
  }
  return [
    head,
    policy.allowExtraUsage
      ? 'This window is exhausted. Further work uses extra-usage credits. Checkpoint if you have not, and confirm with the user that spending credits is still wanted.'
      : 'This window is exhausted and extra usage is not allowed in this session. Tool calls are now denied. Ask the user to run /usage-aware lift if they want to continue, or to wait for the reset.',
    ...protocol,
  ].join('\n')
}

export const blockText = (reason: string, s: UsageSnapshot | null, nowIso: string): string => {
  const worst = s ? worstWindow(s) : undefined
  const reset = worst?.resetsAt ? ` The tightest window resets ${localTime(worst.resetsAt)} (${relative(worst.resetsAt, nowIso)}).` : ''
  return [
    `[usage-awareness] STOP: ${reason}.${reset}`,
    'Tool calls are denied (except AskUserQuestion, the usage-awareness tools, CronCreate/CronList/CronDelete, TaskStop, SendMessage and ListAgents). Do not keep trying tools.',
    'If PROGRESS.md is not written yet, say so and summarize the current state in your reply so the user can save it.',
    'Tell the user: run /usage-aware lift to allow extra usage and continue, /usage-aware clear to drop every ceiling, or ask me to schedule a resume with CronCreate after the reset. Then end your turn.',
  ].join('\n')
}

// ------------------------------------------------------- policy parsing

export type PolicyChange = {
  allowExtraUsage?: boolean
  creditCeilingUsd?: number | null
  sessionCostCeilingUsd?: number | null
  stopAtPercent?: number | null
  mode?: PolicyMode
  note?: string
  clear?: boolean
  lift?: boolean
}

export type ParsedCommand =
  | { kind: 'show' }
  | { kind: 'help' }
  | { kind: 'simulate'; percent: number | null }
  | { kind: 'default'; change: PolicyChange }
  | { kind: 'set'; change: PolicyChange }
  | { kind: 'error'; message: string }

export const HELP = [
  '/usage-aware                 show usage, reset times and the session policy',
  '/usage-aware credits 50      allow extra usage, up to $50 in this session (from now)',
  '/usage-aware allow-extra     allow extra usage in this session, no ceiling',
  '/usage-aware no-extra        never use extra usage in this session (block when exhausted)',
  '/usage-aware cost 20         stop when this session has cost $20',
  '/usage-aware stop-at 95      stop when any window reaches 95%',
  '/usage-aware block | warn    at a ceiling: deny tool calls and abort, or only warn',
  '/usage-aware lift            lift the block that is in force (allows extra usage, drops the ceiling hit)',
  '/usage-aware clear           drop every ceiling for this session and unblock',
  '/usage-aware default <...>   set the default policy new sessions start with (same words)',
  '/usage-aware simulate 96     pretend a window is at 96% (testing); "simulate off" clears',
].join('\n')

const parseMoney = (s: string | undefined): number | null => {
  if (!s) return null
  const n = Number(s.replace(/^\$/, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export const parseCommand = (args: string): ParsedCommand => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'show' }
  const [head, ...rest] = words
  const word = (head ?? '').toLowerCase()
  if (word === 'help' || word === '?') return { kind: 'help' }
  if (word === 'default') {
    const inner = parseCommand(rest.join(' '))
    if (inner.kind === 'set') return { kind: 'default', change: inner.change }
    return { kind: 'error', message: `usage: /usage-aware default <credits N | allow-extra | no-extra | cost N | stop-at N | block | warn | clear>` }
  }
  if (word === 'simulate' || word === 'sim') {
    const v = (rest[0] ?? '').toLowerCase()
    if (v === 'off' || v === 'clear' || v === '') return { kind: 'simulate', percent: null }
    const n = Number(v.replace(/%$/, ''))
    if (!Number.isFinite(n) || n < 0) return { kind: 'error', message: 'usage: /usage-aware simulate <percent> | off' }
    return { kind: 'simulate', percent: n }
  }
  const change: PolicyChange = {}
  const toks = [...words]
  while (toks.length > 0) {
    const w = (toks.shift() ?? '').toLowerCase()
    switch (w) {
      case 'credits':
      case 'credit': {
        const n = parseMoney(toks.shift())
        if (n === null) return { kind: 'error', message: 'usage: /usage-aware credits <dollars>' }
        change.creditCeilingUsd = n
        change.allowExtraUsage = true
        break
      }
      case 'allow-extra':
      case 'allow':
        change.allowExtraUsage = true
        break
      case 'no-extra':
      case 'no-credits':
      case 'deny-extra':
        change.allowExtraUsage = false
        change.creditCeilingUsd = null
        break
      case 'cost': {
        const n = parseMoney(toks.shift())
        if (n === null) return { kind: 'error', message: 'usage: /usage-aware cost <dollars>' }
        change.sessionCostCeilingUsd = n
        break
      }
      case 'stop-at':
      case 'stop': {
        const n = Number((toks.shift() ?? '').replace(/%$/, ''))
        if (!Number.isFinite(n) || n <= 0) return { kind: 'error', message: 'usage: /usage-aware stop-at <percent>' }
        change.stopAtPercent = n
        break
      }
      case 'block':
        change.mode = 'block'
        break
      case 'warn':
      case 'warn-only':
        change.mode = 'warn'
        break
      case 'lift':
      case 'resume':
      case 'unblock':
        change.lift = true
        break
      case 'clear':
      case 'reset':
        change.clear = true
        break
      case 'note':
        change.note = toks.splice(0).join(' ')
        break
      default:
        return { kind: 'error', message: `Unknown word "${w}".\n${HELP}` }
    }
  }
  return { kind: 'set', change }
}

/** Applies a change to a policy; answers the new policy and what it did. */
export const applyChange = (
  policy: UsagePolicy,
  change: PolicyChange,
  tracking: UsageTracking,
  t: Thresholds,
  nowIso: string,
): { policy: UsagePolicy; tracking: UsageTracking; summary: string } => {
  let next: UsagePolicy = { ...policy, setAt: nowIso }
  let track: UsageTracking = { ...tracking }
  const did: string[] = []
  if (change.clear) {
    next = defaultPolicy(t, nowIso)
    track = { ...track, blockedReason: undefined, blockedAt: undefined }
    did.push('cleared every ceiling for this session')
  }
  if (change.lift) {
    const reason = tracking.blockedReason
    next = { ...next, allowExtraUsage: true }
    if (reason?.includes('extra usage') && reason.includes('ceiling')) {
      next = { ...next, creditCeilingUsd: undefined, creditBaselineUsd: undefined }
    }
    if (reason?.includes("session's cost")) next = { ...next, sessionCostCeilingUsd: undefined }
    if (reason?.includes('stop at')) next = { ...next, stopAtPercent: undefined }
    track = { ...track, blockedReason: undefined, blockedAt: undefined }
    did.push(reason ? `lifted the block (${reason})` : 'allowed extra usage (nothing was blocked)')
  }
  if (change.allowExtraUsage !== undefined) {
    next = { ...next, allowExtraUsage: change.allowExtraUsage }
    did.push(change.allowExtraUsage ? 'extra usage allowed' : 'extra usage not allowed')
  }
  if (change.creditCeilingUsd !== undefined) {
    if (change.creditCeilingUsd === null) {
      next = { ...next, creditCeilingUsd: undefined, creditBaselineUsd: undefined }
      did.push('credit ceiling removed')
    } else {
      next = { ...next, creditCeilingUsd: change.creditCeilingUsd, creditBaselineUsd: tracking.extraSpendUsd }
      if (change.allowExtraUsage !== false) next = { ...next, allowExtraUsage: true }
      did.push(`credit ceiling ${money(change.creditCeilingUsd)} from now`)
    }
  }
  if (change.sessionCostCeilingUsd !== undefined) {
    next = { ...next, sessionCostCeilingUsd: change.sessionCostCeilingUsd ?? undefined }
    did.push(change.sessionCostCeilingUsd === null ? 'session cost ceiling removed' : `session cost ceiling ${money(change.sessionCostCeilingUsd)}`)
  }
  if (change.stopAtPercent !== undefined) {
    next = { ...next, stopAtPercent: change.stopAtPercent ?? undefined }
    did.push(change.stopAtPercent === null ? 'stop-at removed' : `stop at ${change.stopAtPercent}%`)
  }
  if (change.mode) {
    next = { ...next, mode: change.mode }
    did.push(change.mode === 'block' ? 'mode: block' : 'mode: warn only')
  }
  if (change.note !== undefined) next = { ...next, note: change.note || undefined }
  return { policy: next, tracking: track, summary: did.length ? did.join('; ') : 'no change' }
}

/** The row injected when a ceiling is hit while the mod only warns. */
export const softBlockText = (reason: string, s: UsageSnapshot | null, nowIso: string): string => {
  const worst = s ? worstWindow(s) : undefined
  const reset = worst?.resetsAt ? ` The tightest window resets ${localTime(worst.resetsAt)} (${relative(worst.resetsAt, nowIso)}).` : ''
  return [
    `[usage-awareness] CEILING REACHED: ${reason}.${reset}`,
    'This session is in warn-only mode, so nothing is denied. Checkpoint now if you have not (PROGRESS.md and progress/*.md), then stop and ask the user whether to continue. Do not continue on your own.',
  ].join('\n')
}

/** What a denied tool call tells the model. */
export const denyText = (reason: string): string =>
  `usage-awareness: tool call denied: ${reason}. Do not retry tools. Summarize the current state for the user and end your turn; the user can run /usage-aware lift to continue.`

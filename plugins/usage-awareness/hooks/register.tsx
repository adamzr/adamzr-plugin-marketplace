import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { UsagePolicy, UsageSnapshot, UsageTracking } from '../types'
import {
  HELP,
  PLUGIN,
  USAGE_URL,
  applyChange,
  blockText,
  defaultPolicy,
  denyText,
  emptyTracking,
  evaluate,
  formatForModel,
  mergeSnapshot,
  parseCommand,
  parseOauthUsage,
  policyText,
  readThresholds,
  softBlockText,
  statusText,
  warningText,
  worstWindow,
  levelFor,
  relative,
  type EngineFigures,
  type OauthUsage,
  type PolicyChange,
  type Thresholds,
} from './usage'

const snapshotAtom = atom({ plugin: 'usage-awareness', key: 'snapshot' } as const, null)
const policyAtom = atom({ plugin: 'usage-awareness', key: 'policy' } as const, null)
const trackingAtom = atom({ plugin: 'usage-awareness', key: 'tracking' } as const, emptyTracking())

const COMMAND = 'usage-aware'
const TOOL_GET = `mcp__${PLUGIN}__get_usage`
const TOOL_SET = `mcp__${PLUGIN}__set_usage_policy`

/** Tools that stay callable while blocked: asking, scheduling, stopping, and this mod's own. */
const ALLOWED_WHILE_BLOCKED =
  /^(mcp__usage-awareness__|AskUserQuestion$|CronCreate$|CronList$|CronDelete$|TaskStop$|SendMessage$|ListAgents$)/

const PROTOCOL = `# Usage awareness (usage-awareness mod)

You can see your own plan usage. The tool \`${TOOL_GET}\` reports every rate-limit window (5-hour, 7-day, per-model weekly such as Opus, Sonnet or Fable), its percent used and reset time, this session's cost, extra-usage credits, and the policy the user set for this session. \`${TOOL_SET}\` records a policy the user states in words, such as "only use $50 of credits", "never use extra usage", or "stop at 90% and resume after the reset".

Rules:
- Before starting long or parallel work (many subagents, a loop, a big migration), call \`${TOOL_GET}\` once and size the work to the headroom.
- When a [usage-awareness] WARN message appears: finish the current unit of work, do not start new large parallel work, and plan a checkpoint.
- When a [usage-awareness] CRITICAL message appears: run the checkpoint protocol, then stop and ask the user before continuing into extra usage (credits). Never spend credits without the user saying so in this session, unless the policy already allows it.
- When a [usage-awareness] STOP message appears or a tool call is denied by usage-awareness: do not retry tools. Summarize state and end your turn. The user lifts the block with /usage-aware lift.
- If the user tells you how much usage or money to spend, call \`${TOOL_SET}\` right away so the mod enforces it, then confirm the policy back to them.

Checkpoint protocol: (1) stop spawning subagents and tell running ones (SendMessage, or TaskStop) to write progress/<agent-name>.md and return; (2) write PROGRESS.md at the project root with current state, done, next, decisions, and links to every progress/*.md; (3) ask the user. To resume after a reset, use CronCreate with the one-shot expression \`${TOOL_GET}\` gives for that window, recurring: false, prompt "Read PROGRESS.md and continue the work."`

// Module state: lost on a hot reload; everything that matters lives in $.state and $.store.
let t: Thresholds = readThresholds({})
let sessionId = ''
let mainTurnId: string | undefined
let isMainTurnRunning = false
let lastBlockedReason: string | undefined
let simulated: number | undefined
let oauth: { at: number; data: OauthUsage | null; state: UsageSnapshot['oauth'] } = {
  at: 0,
  data: null,
  state: 'pending',
}
let timer: { cancel: () => void } | undefined
let noticedTurn: string | undefined
let hasSentProtocol = false
let lastShape = ''

/** The endpoint's top-level keys and each window-like entry, for the debug log (no secrets ride in it). */
const describeShape = (json: unknown): string => {
  if (!json || typeof json !== 'object') return typeof json
  const parts: string[] = []
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    parts.push(`${k}=${v === undefined ? 'undefined' : JSON.stringify(v)}`)
  }
  return parts.join(' ')
}

type Dollar = EngineInterface

const nowIso = async ($: Dollar): Promise<string> => new Date(await $.clock.now()).toISOString()

const storeKey = (what: 'policy' | 'track'): string => `${what}:${sessionId}`

const isEnforcing = (p: UsagePolicy): boolean => t.enforce && p.mode === 'block'

const getPolicy = async ($: Dollar): Promise<UsagePolicy> => {
  const held = await read($, policyAtom)
  if (held) return held
  const stored = (sessionId && (await $.store.get(storeKey('policy')))) as UsagePolicy | undefined
  const fallback = (await $.store.get('policy:default')) as UsagePolicy | undefined
  const p = stored ?? fallback ?? defaultPolicy(t, await nowIso($))
  await update($, policyAtom, () => p)
  return p
}

const persist = async ($: Dollar, p: UsagePolicy, tr: UsageTracking): Promise<void> => {
  if (!sessionId) return
  await $.store.set(storeKey('policy'), p)
  await $.store.set(storeKey('track'), tr)
}

const appendMain = async ($: Dollar, text: string, agentId?: string): Promise<void> => {
  try {
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text }] },
      ...(agentId ? { agentId } : {}),
    })
  } catch (error) {
    $.ui.log(`${PLUGIN}: could not append a note: ${String(error)}`, { to: 'debug' })
  }
}

/** Reads the claude.ai usage endpoint with the session's credential (never seen by this code). */
const fetchOauth = async ($: Dollar): Promise<void> => {
  const at = await $.clock.now()
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') {
      oauth = { at, data: null, state: 'unavailable' }
      return
    }
    const res = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { Accept: 'application/json' },
    })
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      oauth = { at, data: null, state: 'unavailable' }
      return
    }
    if (!res.ok) {
      oauth = { at, data: oauth.data, state: 'error' }
      $.ui.log(`${PLUGIN}: usage endpoint answered ${res.status}`, { to: 'debug' })
      return
    }
    const json: unknown = JSON.parse(res.text)
    lastShape = describeShape(json)
    $.ui.log(`${PLUGIN}: usage endpoint shape: ${lastShape}`, { to: 'debug' })
    const parsed = parseOauthUsage(json)
    oauth = { at, data: parsed, state: parsed ? 'ok' : 'error' }
  } catch (error) {
    oauth = { at, data: oauth.data, state: 'error' }
    $.ui.log(`${PLUGIN}: usage endpoint read failed: ${String(error)}`, { to: 'debug' })
  }
}

/** Re-measures, re-judges, and acts on what changed. */
const refresh = async (
  $: Dollar,
  engine?: EngineFigures,
  wantOauth: 'always' | 'if-stale' | 'never' = 'if-stale',
): Promise<void> => {
  const now = await $.clock.now()
  const staleMs = Math.max(60_000, t.pollMinutes * 60_000)
  if (wantOauth === 'always' || (wantOauth === 'if-stale' && now - oauth.at > staleMs)) {
    await fetchOauth($)
  }
  const figures: EngineFigures = engine ?? (await $.session.usage())
  const iso = new Date(now).toISOString()
  const snap = mergeSnapshot(figures, oauth.data, oauth.state, iso, simulated)
  await update($, snapshotAtom, () => snap)
  await judge($, snap, iso)
}

const judge = async ($: Dollar, snap: UsageSnapshot, iso: string): Promise<void> => {
  const policy = await getPolicy($)
  const prior = await read($, trackingAtom)
  const verdict = evaluate(snap, policy, t, prior)
  await update($, trackingAtom, () => verdict.tracking)
  lastBlockedReason = isEnforcing(policy) ? verdict.blockedReason : undefined
  // The status line only shows once a window reaches the warn threshold or a block is in force.
  const worst = worstWindow(snap)
  const isNotable = verdict.tracking.blockedReason || (worst && levelFor(worst.percentUsed, t) !== 'ok')
  $.ui.status(isNotable ? statusText(snap, verdict.tracking) : undefined)

  for (const alert of verdict.newAlerts) {
    const text = warningText(alert, snap, policy, t, iso)
    $.ui.toast(`usage: ${alert.window.label} at ${alert.window.percentUsed}% (${alert.level})`, { timeoutMs: 8000 })
    await appendMain($, text)
    if (alert.level !== 'warn') {
      for (const agent of await $.agent.list()) {
        if (agent.status === 'running') await appendMain($, text, agent.id)
      }
    }
  }

  if (verdict.blockedReason && !prior.blockedReason) {
    const enforcing = isEnforcing(policy)
    const text = enforcing
      ? blockText(verdict.blockedReason, snap, iso)
      : softBlockText(verdict.blockedReason, snap, iso)
    await appendMain($, text)
    for (const agent of await $.agent.list()) {
      if (agent.status === 'running') await appendMain($, text, agent.id)
    }
    $.ui.toast(`usage-awareness: ${enforcing ? 'BLOCKED' : 'ceiling reached'}: ${verdict.blockedReason}`, { timeoutMs: 15000 })
    void $.ui.notify(`${verdict.blockedReason}. ${enforcing ? 'Tool calls are denied; run /usage-aware lift to continue.' : 'Warn-only mode.'}`, { title: 'Claude Code usage' }).catch(() => {})
    if (enforcing && isMainTurnRunning && mainTurnId) {
      const turnId = mainTurnId
      $.clock.after(1500, () => {
        void $.turn.abort({ turnId }).catch(() => {})
      })
    }
  } else if (verdict.unblocked) {
    $.ui.toast('usage-awareness: block lifted (window reset or ceiling removed)', { timeoutMs: 8000 })
    await appendMain($, '[usage-awareness] The block is lifted: the window reset or the ceiling was removed. You may continue; call get_usage to see headroom.')
  }
  await persist($, policy, verdict.tracking)
}

const setPolicy = async ($: Dollar, change: PolicyChange): Promise<string> => {
  const policy = await getPolicy($)
  const tracking = await read($, trackingAtom)
  const iso = await nowIso($)
  const applied = applyChange(policy, change, tracking, t, iso)
  await update($, policyAtom, () => applied.policy)
  await update($, trackingAtom, () => applied.tracking)
  lastBlockedReason = isEnforcing(applied.policy) ? applied.tracking.blockedReason : undefined
  await persist($, applied.policy, applied.tracking)
  // Re-judge against the new policy (a ceiling may already be exceeded, or a block may now be over).
  const snap = await read($, snapshotAtom)
  if (snap) await judge($, snap, iso)
  const after = await read($, trackingAtom)
  const tail = after.blockedReason ? `\nStill blocked: ${after.blockedReason}.` : ''
  return `Done: ${applied.summary}.\n\nPolicy for this session:\n${policyText(applied.policy)}${tail}`
}

export const register: Register = (on, options) => {
  t = readThresholds(options)

  // ------------------------------------------------------------ session

  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const storedTracking = (await $.store.get(storeKey('track'))) as UsageTracking | undefined
    if (storedTracking) {
      await update($, trackingAtom, () => ({ ...emptyTracking(), ...storedTracking }))
      lastBlockedReason = storedTracking.blockedReason
    }
    await getPolicy($)

    await $.tool.register({
      name: 'get_usage',
      description:
        'Reports your own Claude Code usage: every rate-limit window (5-hour, 7-day, per-model weekly) with percent used and reset time, session cost, extra-usage credits, the policy set for this session, and a one-shot cron expression per reset for CronCreate. Call it before long or parallel work and whenever a [usage-awareness] message appears.',
      inputSchema: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Also re-read the claude.ai usage endpoint now (per-model windows and credits).' },
          raw: { type: 'boolean', description: 'Debugging: also include the raw keys the usage endpoint answered.' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'set_usage_policy',
      description:
        "Records the user's usage policy for THIS session so the mod enforces it. Use when the user says how much usage or money to spend, e.g. 'only $50 of credits', 'never use extra usage', 'stop at 90%', 'warn only'. Omit fields you are not changing. clear: true drops every ceiling; lift: true lifts a block in force.",
      inputSchema: {
        type: 'object',
        properties: {
          allowExtraUsage: { type: 'boolean', description: 'May this session consume extra-usage credits once a plan window is exhausted?' },
          creditCeilingUsd: { type: ['number', 'null'], description: 'Max dollars of extra usage this session may spend from now (implies allowExtraUsage). null removes it.' },
          sessionCostCeilingUsd: { type: ['number', 'null'], description: 'Stop when this session has cost this many dollars in total. null removes it.' },
          stopAtPercent: { type: ['number', 'null'], description: 'Stop when any window reaches this percent. null removes it.' },
          mode: { type: 'string', enum: ['block', 'warn'], description: 'At a ceiling: block (deny tool calls and abort the turn) or warn only.' },
          note: { type: 'string', description: "The user's words, kept with the policy." },
          clear: { type: 'boolean' },
          lift: { type: 'boolean' },
        },
      },
      isDeferred: false,
    })
    await $.command.register({
      name: COMMAND,
      description: 'Show usage limits and reset times, or set this session\'s spend policy (credits N, no-extra, lift, clear, help)',
      argumentHint: '[credits N | allow-extra | no-extra | cost N | stop-at N | block | warn | lift | clear | default ... | simulate N]',
      immediate: true,
    })

    const started = await next(e)
    await refresh($, undefined, 'always')
    timer = $.clock.every(Math.max(1, t.pollMinutes) * 60_000, () => {
      void refresh($, undefined, 'always')
    })
    return started
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, e as SessionMeasureInput, 'if-stale')
    return next(e)
  })

  // --------------------------------------------------------------- turns

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurnId = e.turnId
      isMainTurnRunning = true
      const tr = await read($, trackingAtom)
      const p = await getPolicy($)
      if (tr.blockedReason && noticedTurn !== e.turnId) {
        noticedTurn = e.turnId
        const snap = await read($, snapshotAtom)
        const iso = await nowIso($)
        await appendMain($, isEnforcing(p) ? blockText(tr.blockedReason, snap, iso) : softBlockText(tr.blockedReason, snap, iso))
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) isMainTurnRunning = false
    return next(e)
  })

  // ------------------------------------------------------------- prompts

  on('prompt.submit', async ($, e, next) => {
    const snap = await read($, snapshotAtom)
    if (!snap) return next(e)
    const tr = await read($, trackingAtom)
    const p = await getPolicy($)
    const worst = worstWindow(snap)
    const iso = await nowIso($)
    const resets = worst?.resetsAt ? `, resets ${relative(worst.resetsAt, iso)}` : ''
    const protocol = hasSentProtocol ? '' : `\n\n${PROTOCOL}`
    hasSentProtocol = true
    const line = `[usage-awareness] ${statusText(snap, tr)}${resets}. Extra usage ${p.allowExtraUsage ? 'allowed' : 'NOT allowed'} this session${p.creditCeilingUsd !== undefined ? `, credit ceiling $${p.creditCeilingUsd.toFixed(2)}` : ''}${p.sessionCostCeilingUsd !== undefined ? `, cost ceiling $${p.sessionCostCeilingUsd.toFixed(2)}` : ''}${p.stopAtPercent !== undefined ? `, stop at ${p.stopAtPercent}%` : ''}. Call get_usage for detail.${protocol}`
    return next({ ...e, context: [...(e.context ?? []), line] })
  })

  // The protocol rides on the first prompt's context (prompt.compose is skipped by a managed
  // plugin here); compaction can summarize it away, so send it again on the next prompt.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (!('skip' in compacted)) hasSentProtocol = false
    return compacted
  })

  // --------------------------------------------------------------- guard

  on('tool.call', async ($, e, next) => {
    if (lastBlockedReason && !ALLOWED_WHILE_BLOCKED.test(String(e.tool))) {
      return { deny: denyText(lastBlockedReason) }
    }
    return next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    return lastBlockedReason && !ALLOWED_WHILE_BLOCKED.test(String(e.tool))
      ? { deny: denyText(lastBlockedReason) }
      : next(e)
  })

  // ---------------------------------------------------------------- tools

  on('tool.call', { tool: 'mcp__usage-awareness__get_usage' }, async ($, e) => {
    const input = e as unknown as { refresh?: boolean; raw?: boolean }
    await refresh($, undefined, input.refresh ? 'always' : 'if-stale')
    const snap = await read($, snapshotAtom)
    const p = await getPolicy($)
    const tr = await read($, trackingAtom)
    const text = formatForModel(snap, p, tr, t, await nowIso($))
    return { result: input.raw ? `${text}\n\nRaw endpoint (${oauth.state}): ${lastShape || '(nothing read yet)'}` : text }
  })

  on('tool.call', { tool: 'mcp__usage-awareness__set_usage_policy' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const change: PolicyChange = {}
    if (typeof input.allowExtraUsage === 'boolean') change.allowExtraUsage = input.allowExtraUsage
    const numOrNull = (v: unknown): number | null | undefined =>
      v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
    const cc = numOrNull(input.creditCeilingUsd)
    if (cc !== undefined) {
      change.creditCeilingUsd = cc
      if (cc !== null) change.allowExtraUsage = true
    }
    const sc = numOrNull(input.sessionCostCeilingUsd)
    if (sc !== undefined) change.sessionCostCeilingUsd = sc
    const sp = numOrNull(input.stopAtPercent)
    if (sp !== undefined) change.stopAtPercent = sp
    if (input.mode === 'block' || input.mode === 'warn') change.mode = input.mode
    if (typeof input.note === 'string') change.note = input.note
    if (input.clear === true) change.clear = true
    if (input.lift === true) change.lift = true
    return { result: await setPolicy($, change) }
  })

  // -------------------------------------------------------------- command

  on('command.run', { command: COMMAND }, async ($, e) => {
    const parsed = parseCommand(e.args)
    switch (parsed.kind) {
      case 'help':
        return { text: HELP }
      case 'error':
        return { text: parsed.message }
      case 'simulate': {
        simulated = parsed.percent ?? undefined
        await refresh($, undefined, 'never')
        const tr = await read($, trackingAtom)
        return {
          text: simulated === undefined
            ? `Simulation cleared. ${tr.blockedReason ? `Still blocked: ${tr.blockedReason} (run /usage-aware lift).` : ''}`
            : `Simulating a window at ${simulated}%. ${tr.blockedReason ? `Now blocked: ${tr.blockedReason}.` : ''}`,
        }
      }
      case 'default': {
        const iso = await nowIso($)
        const base = ((await $.store.get('policy:default')) as UsagePolicy | undefined) ?? defaultPolicy(t, iso)
        const applied = applyChange(base, parsed.change, emptyTracking(), t, iso)
        await $.store.set('policy:default', applied.policy)
        return { text: `Default policy for new sessions: ${applied.summary}.\n${policyText(applied.policy)}` }
      }
      case 'set':
        return { text: await setPolicy($, parsed.change) }
      case 'show':
      default: {
        await refresh($, undefined, 'if-stale')
        const snap = await read($, snapshotAtom)
        const p = await getPolicy($)
        const tr = await read($, trackingAtom)
        return { text: formatForModel(snap, p, tr, t, await nowIso($)) }
      }
    }
  }).catch(async ($, e) => {
    // A lift or clear must never be lost to a failure: do the minimum and say so.
    const parsed = parseCommand(e.args)
    if (parsed.kind === 'set' && (parsed.change.lift || parsed.change.clear)) {
      lastBlockedReason = undefined
      await update($, trackingAtom, tr => ({ ...tr, blockedReason: undefined, blockedAt: undefined }))
      await update($, policyAtom, p => ({ ...(p ?? defaultPolicy(t, new Date().toISOString())), allowExtraUsage: true }))
      return { text: 'usage-awareness: the command hit an error, but the block is lifted and extra usage is allowed for this session.' }
    }
    return { text: `usage-awareness: the command failed (see the debug log). Try again, or /usage-aware help.` }
  })


  // ----------------------------------------------------------------- band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await read($, snapshotAtom)
    const tr = await read($, trackingAtom)
    const p = await getPolicy($)
    const worst = snap ? worstWindow(snap) : undefined
    const level = worst ? levelFor(worst.percentUsed, t) : 'ok'
    const hasCeiling = p.creditCeilingUsd !== undefined || p.sessionCostCeilingUsd !== undefined || p.stopAtPercent !== undefined
    if (!tr.blockedReason && level === 'ok' && !hasCeiling) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const iso = new Date(await $.clock.now()).toISOString()
    const color = tr.blockedReason ? 'red' : level === 'ok' ? undefined : level === 'warn' ? 'yellow' : 'red'
    const parts: string[] = []
    if (tr.blockedReason) parts.push(`BLOCKED: ${tr.blockedReason} · /usage-aware lift`)
    else if (worst) parts.push(`${worst.label} ${worst.percentUsed}%${worst.resetsAt ? ` (resets ${relative(worst.resetsAt, iso)})` : ''}`)
    if (p.creditCeilingUsd !== undefined) parts.push(`credits ≤ $${p.creditCeilingUsd.toFixed(2)} (spent $${Math.max(0, tr.extraSpendUsd - (p.creditBaselineUsd ?? 0)).toFixed(2)})`)
    if (p.sessionCostCeilingUsd !== undefined) parts.push(`cost ≤ $${p.sessionCostCeilingUsd.toFixed(2)}${snap?.sessionCostUsd !== undefined ? ` (now $${snap.sessionCostUsd.toFixed(2)})` : ''}`)
    if (p.stopAtPercent !== undefined) parts.push(`stop at ${p.stopAtPercent}%`)
    if (!p.allowExtraUsage) parts.push('no extra usage')
    return (
      <Box>
        <Text color={color} wrap="truncate-end">usage: {parts.join(' · ')}</Text>
      </Box>
    )
  })
}

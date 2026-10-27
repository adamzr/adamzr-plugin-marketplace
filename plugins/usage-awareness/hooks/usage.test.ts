import { describe, expect, test } from 'claude-code/testing'

import {
  applyChange,
  cronFor,
  defaultPolicy,
  emptyTracking,
  evaluate,
  levelFor,
  mergeSnapshot,
  parseCommand,
  parseOauthUsage,
  readThresholds,
  statusText,
  toIso,
} from './usage'

const T = readThresholds({})
const NOW = '2026-10-25T19:00:00.000Z'

describe('parseOauthUsage', () => {
  test('reads windows, model buckets and credits in cents', async () => {
    const parsed = parseOauthUsage({
      five_hour: { utilization: 42.25, resets_at: '2026-10-25T21:00:00Z' },
      seven_day: { utilization: 61, resets_at: 1761600000 },
      seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 30, resets_at: '2026-10-29T00:00:00Z' }],
      extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 1234, utilization: 12.34, currency: 'usd' },
    })
    expect(parsed).not.toBeNull()
    const kinds = parsed!.windows.map(w => w.kind)
    expect(kinds).toEqual(['five_hour', 'seven_day', 'model_scoped:Fable'])
    expect(parsed!.windows[0]!.percentUsed).toBe(42.3)
    expect(parsed!.windows[1]!.resetsAt).toBe(toIso(1761600000))
    expect(parsed!.windows[2]!.label).toBe('Fable 7-day')
    expect(parsed!.extraUsage).toEqual({ isEnabled: true, usedUsd: 12.34, monthlyLimitUsd: 100, utilization: 12.34, currency: 'USD' })
  })

  test('reads per-model windows from the limits list (the shape seen live on a Team plan)', async () => {
    const parsed = parseOauthUsage({
      five_hour: { utilization: 13, resets_at: '2026-10-25T19:40:00.040333+00:00' },
      seven_day: { utilization: 94, resets_at: '2026-10-26T05:00:00.040351+00:00' },
      seven_day_opus: null,
      limits: [
        { kind: 'session', group: 'session', percent: 13, resets_at: '2026-10-25T19:40:00.040333+00:00', scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 94, resets_at: '2026-10-26T05:00:00.040351+00:00', scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 84, resets_at: '2026-10-26T05:00:00.040486+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 300000, used_credits: 4520, utilization: 1.5, currency: 'USD' },
    })
    const kinds = parsed!.windows.map(w => `${w.kind}:${w.percentUsed}`)
    expect(kinds).toEqual(['five_hour:13', 'seven_day:94', 'model_scoped:Fable:84'])
    expect(parsed!.windows[2]!.label).toBe('Fable 7-day')
    expect(parsed!.windows[2]!.resetsAt).toBe('2026-10-26T05:00:00.040Z')
    expect(parsed!.extraUsage!.usedUsd).toBe(45.2)
    expect(parsed!.extraUsage!.monthlyLimitUsd).toBe(3000)
  })

  test('answers null for something that is not usage', async () => {
    expect(parseOauthUsage({ error: 'nope' })).toBeNull()
    expect(parseOauthUsage('x')).toBeNull()
  })
})

describe('mergeSnapshot', () => {
  test('engine windows win, endpoint adds the rest, simulation is one more window', async () => {
    const snap = mergeSnapshot(
      { rateLimits: [{ kind: 'five_hour', percentUsed: 50, resetsAt: '2026-10-25T21:00:00.000Z' }], cost: { usd: 1.5 }, context: { percent: 12 } },
      { windows: [{ kind: 'five_hour', label: '5-hour', percentUsed: 40 }, { kind: 'seven_day_opus', label: 'Opus 7-day', percentUsed: 70 }] },
      'ok',
      NOW,
      96,
    )
    expect(snap.windows.find(w => w.kind === 'five_hour')!.percentUsed).toBe(50)
    expect(snap.windows.find(w => w.kind === 'seven_day_opus')!.percentUsed).toBe(70)
    expect(snap.windows.find(w => w.kind === 'simulated')!.percentUsed).toBe(96)
    expect(snap.sessionCostUsd).toBe(1.5)
    expect(snap.contextPercent).toBe(12)
    expect(statusText(snap)).toBe('5h 50% · Opus 70% · SIM 96% · $1.50')
  })
})

describe('evaluate', () => {
  const policy = defaultPolicy(T, NOW)
  const snapAt = (percent: number, cost = 0) =>
    mergeSnapshot({ rateLimits: [{ kind: 'seven_day', percentUsed: percent, resetsAt: '2026-10-29T00:00:00.000Z' }], cost: { usd: cost } }, null, 'ok', NOW)

  test('levels', async () => {
    expect(levelFor(10, T)).toBe('ok')
    expect(levelFor(80, T)).toBe('warn')
    expect(levelFor(95, T)).toBe('critical')
    expect(levelFor(100, T)).toBe('exhausted')
  })

  test('an alert fires once per level and not again', async () => {
    const v1 = evaluate(snapAt(81), policy, T, emptyTracking())
    expect(v1.newAlerts.map(a => a.level)).toEqual(['warn'])
    const v2 = evaluate(snapAt(83), policy, T, v1.tracking)
    expect(v2.newAlerts).toEqual([])
    const v3 = evaluate(snapAt(96), policy, T, v2.tracking)
    expect(v3.newAlerts.map(a => a.level)).toEqual(['critical'])
    expect(v3.blockedReason).toBeUndefined()
  })

  test('exhausted with extra usage not allowed blocks; a reset unblocks and re-arms', async () => {
    const v1 = evaluate(snapAt(100), policy, T, emptyTracking())
    expect(v1.blockedReason).toContain('exhausted')
    const v2 = evaluate(snapAt(3), policy, T, v1.tracking)
    expect(v2.blockedReason).toBeUndefined()
    expect(v2.unblocked).toBe(true)
    expect(v2.tracking.fired.seven_day).toBeUndefined()
    const v3 = evaluate(snapAt(85), policy, T, v2.tracking)
    expect(v3.newAlerts.map(a => a.level)).toEqual(['warn'])
  })

  test('exhausted with extra usage allowed does not block; the credit ceiling counts session cost while exhausted', async () => {
    const allowed = applyChange(policy, { creditCeilingUsd: 5 }, emptyTracking(), T, NOW).policy
    expect(allowed.allowExtraUsage).toBe(true)
    const v1 = evaluate(snapAt(100, 10), allowed, T, { ...emptyTracking(), lastCostUsd: 10 })
    expect(v1.blockedReason).toBeUndefined()
    const v2 = evaluate(snapAt(100, 13), allowed, T, v1.tracking)
    expect(v2.tracking.extraSpendUsd).toBe(3)
    expect(v2.blockedReason).toBeUndefined()
    const v3 = evaluate(snapAt(100, 15.5), allowed, T, v2.tracking)
    expect(v3.tracking.extraSpendUsd).toBe(5.5)
    expect(v3.blockedReason).toContain('ceiling')
  })

  test('stop-at and session cost ceilings', async () => {
    const stop = applyChange(policy, { stopAtPercent: 90 }, emptyTracking(), T, NOW).policy
    expect(evaluate(snapAt(89), stop, T, emptyTracking()).blockedReason).toBeUndefined()
    expect(evaluate(snapAt(90), stop, T, emptyTracking()).blockedReason).toContain('stop at 90%')
    const cost = applyChange(policy, { sessionCostCeilingUsd: 2 }, emptyTracking(), T, NOW).policy
    expect(evaluate(snapAt(1, 2.01), cost, T, emptyTracking()).blockedReason).toContain("session's cost")
  })

  test('no windows (API key) raises nothing', async () => {
    const v = evaluate(mergeSnapshot({ rateLimits: [], cost: { usd: 3 } }, null, 'unavailable', NOW), policy, T, emptyTracking())
    expect(v.level).toBe('ok')
    expect(v.newAlerts).toEqual([])
    expect(v.blockedReason).toBeUndefined()
  })
})

describe('policy words', () => {
  test('parseCommand', async () => {
    expect(parseCommand('')).toEqual({ kind: 'show' })
    expect(parseCommand('credits $50')).toEqual({ kind: 'set', change: { creditCeilingUsd: 50, allowExtraUsage: true } })
    expect(parseCommand('no-extra')).toEqual({ kind: 'set', change: { allowExtraUsage: false, creditCeilingUsd: null } })
    expect(parseCommand('stop-at 90% warn')).toEqual({ kind: 'set', change: { stopAtPercent: 90, mode: 'warn' } })
    expect(parseCommand('lift')).toEqual({ kind: 'set', change: { lift: true } })
    expect(parseCommand('simulate 96')).toEqual({ kind: 'simulate', percent: 96 })
    expect(parseCommand('simulate off')).toEqual({ kind: 'simulate', percent: null })
    expect(parseCommand('default no-extra').kind).toBe('default')
    expect(parseCommand('bogus').kind).toBe('error')
  })

  test('lift clears the block and the ceiling that was hit', async () => {
    const p = applyChange(defaultPolicy(T, NOW), { creditCeilingUsd: 5 }, emptyTracking(), T, NOW).policy
    const blocked = { ...emptyTracking(), extraSpendUsd: 6, blockedReason: 'this session has spent $6.00 of extra usage, at its ceiling of $5.00' }
    const lifted = applyChange(p, { lift: true }, blocked, T, NOW)
    expect(lifted.tracking.blockedReason).toBeUndefined()
    expect(lifted.policy.creditCeilingUsd).toBeUndefined()
    expect(lifted.policy.allowExtraUsage).toBe(true)
  })

  test('cronFor is one minute past the reset, local time', async () => {
    const d = new Date(Date.parse('2026-10-29T00:00:00.000Z') + 60_000)
    expect(cronFor('2026-10-29T00:00:00.000Z')).toBe(`${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`)
  })
})

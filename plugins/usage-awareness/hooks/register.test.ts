import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const RUN = { origin: { kind: 'composer' } as const, presentation: { isFullscreen: true, columns: 120 } }
const WINDOW = (percentUsed: number) => ({ kind: 'seven_day', percentUsed, resetsAt: '2026-10-29T00:00:00.000Z' })

/** Stands in for the engine beneath the mod: registrations, usage, no endpoint. */
const stubEngine = (on: On, percent: () => number) => {
  mock.clock(on, { now: Date.parse('2026-10-25T19:00:00.000Z') })
  mock.store(on)
  const session = mock.session(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'mcp__usage-awareness__x' } }))
  on('command.register', () => ({ value: { command: 'usage-aware' } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.authorize', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [WINDOW(percent())], cost: { usd: 1 } } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { ok: true } }))
  return session
}

test('a warning is appended once when a window crosses 80%', async ($, on) => {
  let percent = 10
  const session = stubEngine(on, () => percent)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(session.appended().length).toBe(0)

  percent = 81
  await $.session.measure({ context: { window: 200000 }, rateLimits: [WINDOW(81)], cost: { usd: 1 }, changed: ['rateLimits'] })
  const rows = session.appended()
  expect(rows.length).toBe(1)
  expect(JSON.stringify(rows[0]!.message.content)).toContain('WARN')

  await $.session.measure({ context: { window: 200000 }, rateLimits: [WINDOW(83)], cost: { usd: 1 }, changed: ['rateLimits'] })
  expect(session.appended().length).toBe(1)
})

test('an exhausted window with extra usage not allowed denies Bash but not AskUserQuestion, and lift restores it', async ($, on) => {
  let percent = 10
  stubEngine(on, () => percent)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const before = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(before.deny).toBeUndefined()

  percent = 100
  await $.session.measure({ context: { window: 200000 }, rateLimits: [WINDOW(100)], cost: { usd: 1 }, changed: ['rateLimits'] })

  const denied = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(denied.deny).toContain('usage-awareness')
  const asked = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(asked.deny).toBeUndefined()

  const lifted = await $.command.run({ ...RUN, command: 'usage-aware', args: 'lift' })
  expect(lifted.text).toContain('lifted')
  const after = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(after.deny).toBeUndefined()
})

test('the policy is reported back and survives a reload of the hooks', async ($, on) => {
  stubEngine(on, () => 10)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const set = await $.command.run({ ...RUN, command: 'usage-aware', args: 'credits 50' })
  expect(set.text).toContain('Credit ceiling: $50.00')
  const shown = await $.command.run({ ...RUN, command: 'usage-aware', args: '' })
  expect(shown.text).toContain('Credit ceiling: $50.00')
  expect(shown.text).toContain('7-day (all models) | 10%')
})

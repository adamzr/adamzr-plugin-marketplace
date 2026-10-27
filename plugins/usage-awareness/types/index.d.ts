/**
 * The state contract of the usage-awareness mod: every value it keeps in
 * `$.state`, declared under its name in PluginState.
 */

/** How far along a window is, judged against the configured thresholds. */
export type UsageLevel = 'ok' | 'warn' | 'critical' | 'exhausted'

/**
 * One rate-limit window. `kind` is the engine's or the usage endpoint's key
 * (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
 * `model_scoped:<name>`, `spend_limit`); `label` is what people read.
 */
export type UsageWindow = {
  kind: string
  label: string
  percentUsed: number
  resetsAt?: string
}

/** Extra-usage (overage) credits for the billing period, account-wide. */
export type ExtraUsage = {
  isEnabled: boolean
  usedUsd: number | null
  monthlyLimitUsd: number | null
  utilization: number | null
  currency: string
}

/** What the mod knows about usage at one moment. */
export type UsageSnapshot = {
  at: string
  windows: UsageWindow[]
  sessionCostUsd?: number
  contextPercent?: number
  extraUsage?: ExtraUsage
  /** Whether the claude.ai usage endpoint answered. */
  oauth: 'ok' | 'unavailable' | 'error' | 'pending'
  /** A fake window percent set by `/usage-aware simulate <n>`; absent normally. */
  simulated?: number
}

export type PolicyMode = 'block' | 'warn'

/**
 * The policy the person set for this session. Ceilings are per session:
 * `creditCeilingUsd` is measured against this session's own cost accrued
 * while a plan window is exhausted (extra usage in effect), from the moment
 * the ceiling was set (`creditBaselineUsd`).
 */
export type UsagePolicy = {
  allowExtraUsage: boolean
  mode: PolicyMode
  creditCeilingUsd?: number
  creditBaselineUsd?: number
  sessionCostCeilingUsd?: number
  stopAtPercent?: number
  note?: string
  setAt: string
}

/** One warning already raised for a window, so it is not raised twice. */
export type FiredAlert = { level: UsageLevel; resetsAt?: string }

/** What the mod tracks for this session: alerts raised, block, extra spend. */
export type UsageTracking = {
  fired: Record<string, FiredAlert>
  blockedReason?: string
  blockedAt?: string
  /** This session's cost accrued while a plan window was exhausted. */
  extraSpendUsd: number
  /** The session cost at the last measurement, to compute deltas. */
  lastCostUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-awareness': {
      snapshot: UsageSnapshot | null
      policy: UsagePolicy | null
      tracking: UsageTracking
    }
  }
}

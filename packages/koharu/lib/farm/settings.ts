'use client'

// Agent settings live in the webview's own storage rather than koharu's
// preferences: they are fork-only and would otherwise have to be added to a
// schema upstream owns, which every rebase would then have to carry.
//
// The agent token is NOT here. It goes through koharu_secrets, keyed per
// instance — see farm_set_agent_credentials.

import { defaultAgentSettings, type AgentSettings } from './agent'

const SETTINGS_KEY = 'farm.agent.settings'
const ENABLED_KEY = 'farm.agent.enabled'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A read-only profile is not worth failing a translation run over.
  }
}

export function loadAgentSettings(): AgentSettings {
  // Spread over the defaults so a setting added later does not arrive
  // undefined on a machine that stored the older shape.
  return { ...defaultAgentSettings, ...read<Partial<AgentSettings>>(SETTINGS_KEY, {}) }
}

export function saveAgentSettings(settings: AgentSettings): void {
  write(SETTINGS_KEY, settings)
}

/**
 * Whether the agent should run. The farm instance starts hidden, so this is
 * what makes it pick up where it left off after a restart instead of waiting
 * for someone to press a button nobody can see.
 */
export function loadAgentEnabled(): boolean {
  return read<boolean>(ENABLED_KEY, false)
}

export function saveAgentEnabled(enabled: boolean): void {
  write(ENABLED_KEY, enabled)
}

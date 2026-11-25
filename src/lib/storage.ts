const PREFIX = 'bread-safe:'

/** localStorage wrapper that never throws (private windows, blocked storage, SSR). */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = globalThis.localStorage?.getItem(PREFIX + key)
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try {
      globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
      /* storage unavailable */
    }
  },
  remove(key: string) {
    try {
      globalThis.localStorage?.removeItem(PREFIX + key)
    } catch {
      /* storage unavailable */
    }
  },
}

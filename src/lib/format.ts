// Small formatting helpers shared by every table and detail pane, so a value
// never renders differently in two places.

let LOCALE = 'en-US'

/** Numbers and dates follow the interface language. */
export const setLocale = (l: string): void => {
  LOCALE = l
}

export const getLocale = (): string => LOCALE

export const fmtInt = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString(LOCALE)

export const fmtCompact = (n: number | null | undefined): string => {
  if (n == null) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

export const fmtUsd = (n: number | null | undefined): string =>
  n == null
    ? '—'
    : '$' + n.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const fmtPct = (n: number | null | undefined, digits = 1): string =>
  n == null ? '—' : (n * 100).toFixed(digits) + '%'

export const fmtDur = (sec: number | null | undefined): string => {
  if (sec == null) return '—'
  const zh = LOCALE.startsWith('zh')
  if (sec < 60) return Math.round(sec) + (zh ? ' 秒' : 's')
  if (sec < 3600) {
    return zh
      ? Math.floor(sec / 60) + ' 分 ' + Math.round(sec % 60) + ' 秒'
      : Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's'
  }
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return zh ? h + ' 小时 ' + m + ' 分' : h + 'h ' + m + 'm'
}

export const fmtMs = (ms: number | null | undefined): string => {
  if (ms == null) return '—'
  if (ms < 1000) return Math.round(ms) + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(LOCALE, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export const fmtClock = (sec: number | null | undefined): string => {
  if (sec == null) return '—'
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

/**
 * Path handling.
 *
 * Transcripts come from Windows and POSIX machines alike, and file paths inside
 * them may use either separator. `BACKSLASH` is built from a char code rather
 * than written as a literal so that no layer of tooling has to agree about how
 * many backslashes a regex character class needs.
 */
const BACKSLASH = String.fromCharCode(92)

export const splitPath = (p: string): string[] => p.split(BACKSLASH).join('/').split('/')

export const baseName = (p: string): string => {
  const parts = splitPath(p)
  return parts[parts.length - 1] || p
}

/** Keep the tail of a long path, which is the part that identifies the file. */
export const shortPath = (p: string, keep = 42): string =>
  p.length <= keep ? p : '…' + p.slice(p.length - keep + 1)

export const errorRate = (s: { toolResults: number; toolErrors: number }): number | null =>
  s.toolResults === 0 ? null : s.toolErrors / s.toolResults

export const str = (v: unknown): string =>
  v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)

export const boolish = (v: unknown): boolean => v === true || v === 'true'

export const numish = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
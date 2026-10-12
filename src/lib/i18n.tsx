// Language runtime.
//
// The English copy in the source doubles as the key: a missing entry falls back
// to English, so a half-finished translation can never show a raw key or break
// a screen. Dictionaries live in strings.<lang>.ts as "english=local" lines; a
// pipe in a key registers both spellings, so singular and plural can differ.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { setLocale } from './format'
import { ZH } from './strings.zh'

export type Dict = Record<string, string>

export interface Language {
  id: string
  label: string
}

export const LANGUAGES: Language[] = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
]

const DICTS: Record<string, Dict> = { zh: ZH }

const LANG_KEY = 'tracematter.lang'

/** Map anything the browser or localStorage hands us onto a supported id. */
export function normalizeLang(v: string | null | undefined): string {
  return v && v.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function initialLang(): string {
  try {
    const saved = window.localStorage.getItem(LANG_KEY)
    if (saved) return normalizeLang(saved)
  } catch {
    /* storage may be unavailable; fall through */
  }
  try {
    return normalizeLang(window.navigator.language)
  } catch {
    return 'en'
  }
}

export type Vars = Record<string, string | number>

/** Pick the template for `key` in `lang` and fill in its {placeholders}. */
export function translate(lang: string, key: string, vars?: Vars): string {
  const dict = DICTS[lang]
  const raw = (dict && dict[key]) || key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
    vars[name] === undefined ? m : String(vars[name]),
  )
}

export function localeFor(lang: string): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US'
}

/** Current language for code paths outside React, such as diff builders. */
let CURRENT = initialLang()

export const tGlobal = (key: string, vars?: Vars): string => translate(CURRENT, key, vars)

export interface I18n {
  lang: string
  setLang: (id: string) => void
  t: (key: string, vars?: Vars) => string
}

const I18nCtx = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<string>(() => initialLang())

  const setLang = useCallback((id: string) => {
    const next = normalizeLang(id)
    setLangState(next)
    try {
      window.localStorage.setItem(LANG_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    const locale = localeFor(lang)
    CURRENT = lang
    setLocale(locale)
    document.documentElement.lang = locale
  }, [lang])

  const t = useCallback((key: string, vars?: Vars) => translate(lang, key, vars), [lang])

  const value = useMemo<I18n>(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>
}

export function useI18n(): I18n {
  const c = useContext(I18nCtx)
  if (!c) throw new Error('useI18n must be used inside <I18nProvider>')
  return c
}

/** The translator alone, for components that never switch the language. */
export function useT(): I18n['t'] {
  return useI18n().t
}
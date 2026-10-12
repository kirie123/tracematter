import { useEffect, useMemo, useState } from 'react'
import { Badge, Card, Icon, Spinner } from './ui'
import * as api from '../lib/api'
import { useT } from '../lib/i18n'
import type { AppConfig, GatewayConfig, ProviderPreset } from '../lib/types'

/**
 * The model connection.
 *
 * The order of the controls follows the questions a person actually asks, in
 * the order they ask them: which vendor (chips), what endpoint (base URL),
 * which model (a picker that can ask the server what it serves), and only then
 * the knobs most people never touch (behind Advanced).
 *
 * A preset is a shortcut, never a lock: every field stays editable, and typing
 * an endpoint by hand is a first-class path — that is what the Custom chip is
 * for. Nothing here is required for the viewer to work; it only matters once
 * something needs to call a model.
 */
export function ModelCard({
  draft,
  setDraft,
}: {
  draft: AppConfig
  setDraft: (c: AppConfig) => void
}) {
  const t = useT()
  const gw = draft.gateway
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [probe, setProbe] = useState<{ busy: boolean; ok?: boolean; msg?: string }>({ busy: false })
  const [fetching, setFetching] = useState(false)
  const [listed, setListed] = useState<string[]>([])
  const [listedNote, setListedNote] = useState('')
  const [adv, setAdv] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [headers, setHeaders] = useState('')

  useEffect(() => {
    void api.providerPresets().then(setPresets).catch(() => setPresets([]))
  }, [])

  // The header box is free text while it is being typed — parsing on every
  // keystroke would delete the half-written line under the cursor.
  useEffect(() => {
    setHeaders(gw.extraHeaders.map(([k, v]) => `${k}: ${v}`).join('\n'))
  }, [gw.extraHeaders])

  const setGw = (patch: Partial<GatewayConfig>) => setDraft({ ...draft, gateway: { ...gw, ...patch } })
  const active = presets.find((p) => p.id === gw.preset)

  const options = useMemo(() => {
    const all = [gw.model, ...gw.models, ...listed, ...(active?.models ?? [])]
    return Array.from(new Set(all.filter((m) => m.trim() !== '')))
  }, [gw.model, gw.models, listed, active])

  /** Remembering a model is what makes the picker useful on the third switch. */
  const remember = (id: string) => {
    const m = id.trim()
    if (!m || gw.models[0] === m) return
    setGw({ models: [m, ...gw.models.filter((x) => x !== m)].slice(0, 8) })
  }

  const usePreset = (p: ProviderPreset) => {
    setProbe({ busy: false })
    setListedNote('')
    setGw({ preset: p.id, baseUrl: p.baseUrl || gw.baseUrl, model: p.defaultModel || gw.model })
  }

  const doProbe = async () => {
    setProbe({ busy: true })
    try {
      const [ok, msg] = await api.probeGateway(gw)
      setProbe({ busy: false, ok, msg })
    } catch (e) {
      setProbe({ busy: false, ok: false, msg: api.humanError(e) })
    }
  }

  const doFetch = async () => {
    setFetching(true)
    setListedNote('')
    try {
      const ids = await api.listModels(gw)
      setListed(ids)
      setListedNote(ids.length ? '' : t('the server listed nothing'))
    } catch (e) {
      setListedNote(api.humanError(e))
    }
    setFetching(false)
  }

  const commitHeaders = () => {
    const rows: [string, string][] = []
    for (const line of headers.split('\n')) {
      const at = line.indexOf(':')
      if (at > 0) rows.push([line.slice(0, at).trim(), line.slice(at + 1).trim()])
    }
    const same =
      rows.length === gw.extraHeaders.length &&
      rows.every((r, i) => r[0] === gw.extraHeaders[i][0] && r[1] === gw.extraHeaders[i][1])
    if (!same) setGw({ extraHeaders: rows })
  }

  return (
    <Card
      title={t('Model')}
      sub={t(
        'Which endpoint answers. Any OpenAI-compatible server works: a hosted API, a local one, or your own router.',
      )}
    >
      <div className="field">
        <label>{t('Provider')}</label>
        <div className="row wrap" style={{ gap: 6 }}>
          {presets.map((p) => (
            <button
              key={p.id}
              className={'chip' + (gw.preset === p.id ? ' on' : '')}
              onClick={() => usePreset(p)}
            >
              {t(p.label)}
            </button>
          ))}
        </div>
        {active && <div className="hint">{t(active.note)}</div>}
      </div>

      <div className="field">
        <label>{t('Base URL')}</label>
        <input
          className="input mono"
          placeholder="https://host/v1"
          value={gw.baseUrl}
          onChange={(e) => setGw({ preset: '', baseUrl: e.target.value })}
        />
        <div className="hint">
          {t('Include the version segment. Requests go to baseURL + /chat/completions.')}
        </div>
      </div>

      <div className="field">
        <label>{t('Model')}</label>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input mono"
            list="tm-model-options"
            style={{ flex: 1 }}
            value={gw.model}
            onChange={(e) => setGw({ model: e.target.value })}
            onBlur={(e) => remember(e.target.value)}
          />
          <datalist id="tm-model-options">
            {options.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button className="btn" disabled={fetching} onClick={doFetch} title={t('Ask the server which models it serves')}>
            {fetching ? <Spinner /> : <Icon name="refresh" size={12} />} {t('Fetch models')}
          </button>
        </div>
        {fetching && <div className="hint">{t('Asking the server…')}</div>}
        {listed.length > 0 && (
          <div className="hint">
            <Badge kind="ok">{t('listed')}</Badge> <span className="mono">{listed.length}</span>{' '}
            {t('models')}
          </div>
        )}
        {listedNote && <div className="hint">{listedNote}</div>}
        {gw.models.length > 0 && (
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            <span className="small">{t('Remembered')}</span>
            {gw.models.map((m) => (
              <span key={m} className={'chip' + (gw.model === m ? ' on' : '')}>
                <button className="chip-label mono" onClick={() => { setGw({ model: m }); remember(m) }}>
                  {m}
                </button>
                <button
                  className="chip-x"
                  title={t('Forget this model')}
                  onClick={() => setGw({ models: gw.models.filter((x) => x !== m) })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <label>{t('API key')}</label>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input mono"
            style={{ flex: 1 }}
            type={showKey ? 'text' : 'password'}
            placeholder={t('stored in plain text in the config file')}
            value={gw.apiKey}
            onChange={(e) => setGw({ apiKey: e.target.value })}
          />
          <button className="btn" onClick={() => setShowKey(!showKey)}>
            {t(showKey ? 'Hide' : 'Show')}
          </button>
        </div>
        {active?.keyUrl ? (
          <div className="hint">
            {t('Get a key')} <span className="mono">{active.keyUrl}</span>
          </div>
        ) : active?.local ? (
          <div className="hint">{t('Local servers usually ignore this.')}</div>
        ) : null}
      </div>

      <div className="row" style={{ gap: 10 }}>
        <button className="btn" disabled={probe.busy} onClick={doProbe}>
          {probe.busy ? <Spinner /> : <Icon name="activity" size={13} />} {t('Test connection')}
        </button>
        <button className="btn ghost" onClick={() => setAdv(!adv)}>
          <Icon name="chevron" size={12} /> {t('Advanced')}
        </button>
        {probe.msg && (
          <span className="small">
            <Badge kind={probe.ok ? 'ok' : 'bad'}>{t(probe.ok ? 'reachable' : 'failed')}</Badge>{' '}
            {probe.msg}
          </span>
        )}
      </div>

      {adv && (
        <div style={{ marginTop: 14 }}>
          <div className="grid-4">
            <div className="field">
              <label>{t('Temperature')}</label>
              <input
                className="input"
                type="number"
                step="0.1"
                value={gw.temperature}
                onChange={(e) => setGw({ temperature: +e.target.value })}
              />
              <div className="hint">{t('Labelling wants 0. Ideas want more.')}</div>
            </div>
            <div className="field">
              <label>{t('Max tokens')}</label>
              <input
                className="input"
                type="number"
                value={gw.maxTokens}
                onChange={(e) => setGw({ maxTokens: +e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t('Concurrency')}</label>
              <input
                className="input"
                type="number"
                min="1"
                max="64"
                value={gw.concurrency}
                onChange={(e) => setGw({ concurrency: +e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t('Timeout (s)')}</label>
              <input
                className="input"
                type="number"
                value={gw.timeoutSecs}
                onChange={(e) => setGw({ timeoutSecs: +e.target.value })}
              />
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <label>{t('Retries')}</label>
              <input
                className="input"
                type="number"
                min="0"
                value={gw.maxRetries}
                onChange={(e) => setGw({ maxRetries: +e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t('Extra headers')}</label>
              <textarea
                className="input mono"
                rows={2}
                placeholder={t('One per line: Name: value')}
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                onBlur={commitHeaders}
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
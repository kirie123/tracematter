import { useEffect, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Badge, Card, Icon, Spinner } from '../components/ui'
import * as api from '../lib/api'
import { useT } from '../lib/i18n'
import { useApp } from '../lib/store'
import type { AppConfig, GatewayConfig } from '../lib/types'

export default function Settings() {
  const { config, persistConfig, rescan, toast } = useApp()
  const [draft, setDraft] = useState<AppConfig | null>(config)
  const [probe, setProbe] = useState<{ busy: boolean; ok?: boolean; msg?: string }>({ busy: false })
  const [where, setWhere] = useState('')
  const t = useT()

  useEffect(() => setDraft(config), [config])
  useEffect(() => {
    void api.configLocation().then(setWhere).catch(() => setWhere(''))
  }, [])

  if (!draft) return <Spinner />

  const gw: GatewayConfig = draft.gateway
  const setGw = (patch: Partial<GatewayConfig>) => setDraft({ ...draft, gateway: { ...gw, ...patch } })

  const saveAll = async () => {
    await persistConfig(draft)
    toast(t('saved'), 'ok')
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

  const pickRoot = async () => {
    const p = await openDialog({ directory: true, multiple: false, title: t('Workspace folder') })
    if (typeof p === 'string') setDraft({ ...draft, workspaceRoot: p })
  }

  const pickOut = async () => {
    const p = await openDialog({ directory: true, multiple: false, title: t('Default output folder') })
    if (typeof p === 'string') setDraft({ ...draft, outputDir: p })
  }

  return (
    <div className="page">
      <div style={{ maxWidth: 780 }}>
        <Card title={t('Workspace')} sub={t('Where transcripts are read from, and where results go by default.')}>
          <div className="field">
            <label>{t('Transcript folder')}</label>
            <div className="row">
              <input
                className="input mono grow"
                value={draft.workspaceRoot || ''}
                onChange={(e) => setDraft({ ...draft, workspaceRoot: e.target.value })}
              />
              <button className="btn" onClick={pickRoot}>{t('Browse')}</button>
              <button className="btn" onClick={() => rescan(draft.workspaceRoot || undefined)}>{t('Rescan')}</button>
            </div>
          </div>
          <div className="field">
            <label>{t('Default output folder')}</label>
            <div className="row">
              <input
                className="input mono grow"
                value={draft.outputDir || ''}
                onChange={(e) => setDraft({ ...draft, outputDir: e.target.value })}
              />
              <button className="btn" onClick={pickOut}>{t('Browse')}</button>
            </div>
          </div>
        </Card>

        <div style={{ height: 14 }} />

        <Card
          title={t('Gateway')}
          sub={t('Any OpenAI-compatible endpoint works: a hosted API, a local inference server, or your own router.')}
        >
          <div className="field">
            <label>{t('Base URL')}</label>
            <input
              className="input mono"
              placeholder="https://host/v1"
              value={gw.baseUrl}
              onChange={(e) => setGw({ baseUrl: e.target.value })}
            />
            <div className="hint">{t('Include the version segment. Requests go to baseURL + /chat/completions.')}</div>
          </div>
          <div className="grid-2">
            <div className="field">
              <label>{t('Model')}</label>
              <input className="input mono" value={gw.model} onChange={(e) => setGw({ model: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('API key')}</label>
              <input
                className="input mono"
                type="password"
                placeholder={t('stored in plain text in the config file')}
                value={gw.apiKey}
                onChange={(e) => setGw({ apiKey: e.target.value })}
              />
            </div>
          </div>
          <div className="grid-4">
            <div className="field">
              <label>{t('Temperature')}</label>
              <input className="input" type="number" step="0.1" value={gw.temperature} onChange={(e) => setGw({ temperature: +e.target.value })} />
            </div>
            <div className="field">
              <label>{t('Max tokens')}</label>
              <input className="input" type="number" value={gw.maxTokens} onChange={(e) => setGw({ maxTokens: +e.target.value })} />
              <div className="hint">{t('Reasoning models need room to think before they emit the answer.')}</div>
            </div>
            <div className="field">
              <label>{t('Concurrency')}</label>
              <input className="input" type="number" min="1" max="64" value={gw.concurrency} onChange={(e) => setGw({ concurrency: +e.target.value })} />
            </div>
            <div className="field">
              <label>{t('Timeout (s)')}</label>
              <input className="input" type="number" value={gw.timeoutSecs} onChange={(e) => setGw({ timeoutSecs: +e.target.value })} />
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn" disabled={probe.busy} onClick={doProbe}>
              {probe.busy ? <Spinner /> : <Icon name="activity" size={13} />} {t('Test connection')}
            </button>
            {probe.msg && (
              <span className="small">
                <Badge kind={probe.ok ? 'ok' : 'bad'}>{t(probe.ok ? 'reachable' : 'failed')}</Badge> {probe.msg}
              </span>
            )}
          </div>
        </Card>

        <div style={{ height: 14 }} />

        <Card
          title={t('Digest')}
          sub={t('How much of each turn the annotator gets to see. Head and tail are both kept, because judging a turn from its opening alone systematically mislabels unfinished-looking work.')}
        >
          <div className="grid-4">
            <div className="field">
              <label>{t('User head')}</label>
              <input className="input" type="number" value={draft.digest.maxUserHead} onChange={(e) => setDraft({ ...draft, digest: { ...draft.digest, maxUserHead: +e.target.value } })} />
            </div>
            <div className="field">
              <label>{t('User tail')}</label>
              <input className="input" type="number" value={draft.digest.maxUserTail} onChange={(e) => setDraft({ ...draft, digest: { ...draft.digest, maxUserTail: +e.target.value } })} />
            </div>
            <div className="field">
              <label>{t('Reply head')}</label>
              <input className="input" type="number" value={draft.digest.maxAsstHead} onChange={(e) => setDraft({ ...draft, digest: { ...draft.digest, maxAsstHead: +e.target.value } })} />
            </div>
            <div className="field">
              <label>{t('Reply tail')}</label>
              <input className="input" type="number" value={draft.digest.maxAsstTail} onChange={(e) => setDraft({ ...draft, digest: { ...draft.digest, maxAsstTail: +e.target.value } })} />
            </div>
          </div>
        </Card>

        <div style={{ height: 14 }} />

        <Card title={t('Rubrics')} sub={t('Shipped with the app. Editing them here rewrites the config file.')}>
          {draft.schemas.map((s) => (
            <div key={s.id} style={{ marginBottom: 14 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <input
                  className="input"
                  style={{ maxWidth: 220, fontWeight: 600 }}
                  value={s.name}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      schemas: draft.schemas.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)),
                    })
                  }
                />
                <span className="tiny faint mono">{s.id}</span>
                <div className="grow" />
                <button
                  className={'btn sm' + (draft.activeSchemaId === s.id ? ' primary' : '')}
                  onClick={() => setDraft({ ...draft, activeSchemaId: s.id })}
                >
                  {t(draft.activeSchemaId === s.id ? 'active' : 'make active')}
                </button>
              </div>
              <textarea
                className="textarea"
                rows={3}
                value={s.instructions}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    schemas: draft.schemas.map((x) => (x.id === s.id ? { ...x, instructions: e.target.value } : x)),
                  })
                }
              />
              <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                {s.fields.map((fl) => (
                  <span key={fl.name} className="badge" title={fl.description}>
                    {fl.name}<span className="faint"> :{fl.kind}</span>
                    {fl.options.length > 0 && <span className="faint"> ({fl.options.length})</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </Card>

        <div className="row" style={{ margin: '16px 0 60px', gap: 10 }}>
          <button className="btn primary" onClick={saveAll}><Icon name="check" size={13} /> {t('Save settings')}</button>
          <span className="tiny faint">{where ? t('config file: {p}', { p: where }) : ''}</span>
        </div>
      </div>
    </div>
  )
}


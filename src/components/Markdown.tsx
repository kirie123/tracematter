// Rendering for the markdown subset in lib/md.ts.
//
// The parser emits data and this turns it into React elements, so no markup is
// ever interpreted: an answer that contains <script> shows the tag as text.
// Every block is a plain element with a class from 50-analyst.css, which is why
// the panel can carry model prose without carrying a stylesheet of its own.

import { Fragment, memo, useMemo, useState, type ReactNode } from 'react'
import { parseInline, parseMd, type InlineToken, type MdBlock } from '../lib/md'
import { useT } from '../lib/i18n'
import { useApp } from '../lib/store'
import { Icon } from './ui'

/** Past this size the panel stops laying text out and just shows it. */
const PLAIN_ABOVE = 20000

function inlineNodes(tokens: InlineToken[], key: string): ReactNode[] {
  return tokens.map((tok, i) => {
    const k = key + ':' + i
    switch (tok.t) {
      case 'code':
        return <code key={k} className="md-ic">{tok.v}</code>
      case 'strong':
        return <strong key={k}>{inlineNodes(parseInline(tok.v), k)}</strong>
      case 'em':
        return <em key={k}>{inlineNodes(parseInline(tok.v), k)}</em>
      case 'del':
        return <del key={k}>{tok.v}</del>
      case 'link':
        return (
          <a key={k} href={tok.href} target="_blank" rel="noreferrer noopener">
            {inlineNodes(parseInline(tok.v), k)}
          </a>
        )
      default:
        return <Fragment key={k}>{tok.v}</Fragment>
    }
  })
}

const inline = (src: string, key: string) => inlineNodes(parseInline(src), key)

/** A fence, with the language on the left and a copy button on the right. */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { toast } = useApp()
  const t = useT()
  const [done, setDone] = useState(false)

  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setDone(true)
        window.setTimeout(() => setDone(false), 1400)
      },
      () => toast(t('clipboard blocked by the webview'), 'err'),
    )
  }

  return (
    <figure className="md-code">
      <div className="md-code-bar">
        <span className="md-lang">{lang || t('code')}</span>
        <span className="grow" />
        <button className="md-copy" onClick={copy} title={t('Copy code')} aria-label={t('Copy code')}>
          <Icon name={done ? 'check' : 'copy'} size={11} />
        </button>
      </div>
      <pre className="md-pre">
        <code>{text}</code>
      </pre>
    </figure>
  )
}

function Block({ b, k }: { b: MdBlock; k: string }) {
  switch (b.t) {
    case 'code':
      return <CodeBlock lang={b.lang} text={b.text} />
    case 'h':
      return (
        <h4 className={'md-h lv' + Math.min(4, b.level)}>
          {inline(b.src, k + 'h')}
        </h4>
      )
    case 'hr':
      return <hr className="md-hr" />
    case 'quote':
      return <blockquote className="md-quote">{inline(b.src, k + 'q')}</blockquote>
    case 'list':
      return b.ordered ? (
        <ol className="md-list">
          {b.items.map((it, i) => (
            <li key={i} style={it.depth ? { marginLeft: it.depth * 14 } : undefined}>
              {inline(it.src, k + 'li' + i)}
            </li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {b.items.map((it, i) => (
            <li key={i} style={it.depth ? { marginLeft: it.depth * 14 } : undefined}>
              {inline(it.src, k + 'li' + i)}
            </li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <div className="md-tablewrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i}>{inline(c, k + 'th' + i)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i}>{inline(c, k + 'td' + r + '_' + i)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    default:
      return <p className="md-p">{inline(b.src, k + 'p')}</p>
  }
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => (text.length > PLAIN_ABOVE ? null : parseMd(text)), [text])
  if (!blocks) return <pre className={'md-raw ' + (className ?? '')}>{text}</pre>
  return (
    <div className={'md' + (className ? ' ' + className : '')}>
      {blocks.map((b, i) => (
        <Block key={i} b={b} k={'b' + i} />
      ))}
    </div>
  )
})
// A JSON value as a foldable tree.
//
// Every node knows its RFC 6901 pointer, which is what makes the tree an
// editing surface rather than a read-only dump: the pointer is the anchor an
// edit addresses, and it is the same anchor the table's cells use.

import { useState, type ReactNode } from 'react'
import { Icon } from './ui'

/** Escape one path token for a JSON Pointer (RFC 6901). */
export function ptrEscape(tok: string): string {
  return tok.replace(/~/g, '~0').replace(/\//g, '~1')
}

export function joinPtr(base: string, tok: string | number): string {
  return base + '/' + ptrEscape(String(tok))
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  if (t === 'number') return Number.isInteger(v as number) ? 'int' : 'float'
  return t
}

/** A one-line rendering of a leaf. Strings show their quotes so type is visible. */
export function leafText(v: unknown, max = 200): string {
  let s: string
  if (typeof v === 'string') s = JSON.stringify(v)
  else if (v === undefined) s = 'undefined'
  else s = JSON.stringify(v) ?? String(v)
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function isBranch(v: unknown): boolean {
  return v !== null && typeof v === 'object'
}

interface NodeProps {
  name: string | null
  value: unknown
  pointer: string
  depth: number
  /** Pointers the caller wants expanded from the start. */
  openAt: Set<string>
  selected: string | null
  onSelect: (pointer: string, value: unknown, name: string | null) => void
  onEdit?: (pointer: string, value: unknown) => void
  /** Beyond this depth, a branch starts folded however shallow the pointer is. */
  autoDepth: number
}

function Node({ name, value, pointer, depth, openAt, selected, onSelect, onEdit, autoDepth }: NodeProps) {
  const branch = isBranch(value)
  const [open, setOpen] = useState(() => depth < autoDepth || openAt.has(pointer))

  const label = name === null ? '(root)' : name
  const isSel = selected === pointer

  const entries: [string | number, unknown][] = !branch
    ? []
    : Array.isArray(value)
      ? (value as unknown[]).map((v, i) => [i, v] as [number, unknown])
      : Object.entries(value as Record<string, unknown>)

  const row = (
    <div
      className={'jt-row' + (isSel ? ' on' : '')}
      style={{ paddingLeft: 6 + depth * 13 }}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(pointer, value, name)
        if (branch) setOpen((o) => !o)
      }}
    >
      {branch ? (
        <span className={'jt-caret' + (open ? ' open' : '')}>
          <Icon name="chevron" size={11} />
        </span>
      ) : (
        <span className="jt-caret" />
      )}
      {name !== null && <span className="jt-key">{label}</span>}
      {branch ? (
        <span className="jt-count">
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      ) : (
        <span className={'jt-val t-' + typeName(value)}>{leafText(value)}</span>
      )}
      {onEdit && !branch && (
        <button
          className="jt-edit"
          title="Edit this value"
          onClick={(e) => {
            e.stopPropagation()
            onEdit(pointer, value)
          }}
        >
          <Icon name="pencil" size={11} />
        </button>
      )}
    </div>
  )

  return (
    <>
      {row}
      {branch && open &&
        entries.map(([k, v]) => (
          <Node
            key={String(k)}
            name={String(k)}
            value={v}
            pointer={joinPtr(pointer, k)}
            depth={depth + 1}
            openAt={openAt}
            selected={selected}
            onSelect={onSelect}
            onEdit={onEdit}
            autoDepth={autoDepth}
          />
        ))}
    </>
  )
}

export interface JsonTreeProps {
  value: unknown
  /** Where the value sits inside its document. */
  basePointer?: string
  /** Depth to expand on first render. */
  autoDepth?: number
  /** Array/item indices to expand, so a big array can be aimed rather than scrolled. */
  openAt?: string[]
  selected?: string | null
  onSelect?: (pointer: string, value: unknown, name: string | null) => void
  onEdit?: (pointer: string, value: unknown) => void
  /** Shown when the value is empty, so a blank pane is never silent. */
  empty?: ReactNode
}

export function JsonTree({
  value,
  basePointer = '',
  autoDepth = 2,
  openAt,
  selected = null,
  onSelect,
  onEdit,
  empty,
}: JsonTreeProps) {
  const set = new Set(openAt ?? [])
  if (value === undefined) {
    return <div className="jt-empty">{empty ?? 'nothing to show'}</div>
  }
  return (
    <div className="jt">
      <Node
        name={null}
        value={value}
        pointer={basePointer}
        depth={0}
        openAt={set}
        selected={selected}
        onSelect={onSelect ?? (() => undefined)}
        onEdit={onEdit}
        autoDepth={autoDepth}
      />
    </div>
  )
}

/** A single value with no tree chrome, for an inspector row. */
export function ValueView({ value }: { value: unknown }) {
  if (isBranch(value)) {
    return <JsonTree value={value} autoDepth={1} />
  }
  return <span className={'jt-val t-' + typeName(value)}>{leafText(value, 4000)}</span>
}

// Project-list maths, kept out of the store so the sidebar, the settings page
// and the backend all agree on what "the same folder" means.

import { baseName } from './format'
import type { AppConfig, Project } from './types'

/**
 * Same project when two paths differ only in case or in which separator they
 * use. Mirrors `Project::same_path` in the Rust config module, and it matters
 * for the same reason: Windows hands out both spellings freely, and a folder
 * that got added twice cannot be removed properly.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** A folder's own name: the last path segment. Mirrors `Project::name_for`. */
export function folderName(path: string): string {
  return baseName(path.replace(/[\\/]+$/, ''))
}

export function findIn(list: Project[], path: string): Project | null {
  return list.find((p) => samePath(p.path, path)) ?? null
}

/** The row `workspaceRoot` points at, if the list still holds one. */
export function activeOf(config: AppConfig | null): Project | null {
  const root = config?.workspaceRoot
  if (!root) return null
  return findIn(config.projects ?? [], root)
}

/** A row for a folder that is not in the list yet; a no-op if it already is. */
export function withRow(list: Project[], path: string): Project[] {
  return findIn(list, path) ? list : [...list, { name: folderName(path), path, profile: null }]
}

export function withoutRow(list: Project[], path: string): Project[] {
  return list.filter((p) => !samePath(p.path, path))
}

/** Rename a row. A blank name falls back to the folder's own name. */
export function renamed(list: Project[], path: string, name: string): Project[] {
  return list.map((p) =>
    samePath(p.path, path) ? { ...p, name: name.trim() || folderName(p.path) } : p,
  )
}

/** Pin a reader profile to one row, or unpin it with null. */
export function withProfile(list: Project[], path: string, profile: string | null): Project[] {
  return list.map((p) => (samePath(p.path, path) ? { ...p, profile } : p))
}
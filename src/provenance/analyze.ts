import type { ChangedFile, ProvenanceDetail, ProvenancePackageReport, ProvenanceReport, ProvenanceSignal } from '../types'
import type { ProvenanceClient } from './lookup'
import { addedPackages, lockfileKind, packageIdentity, parseLockfile, type ParsedPackage } from './parse'

const DISPLAY_LIMIT = 40
const LOOKUP_CONCURRENCY = 4

export function emptyProvenance(): ProvenanceReport {
  return {
    enabled: true,
    status: 'pass',
    packages: [],
    lockfiles: [],
    omitted: 0,
    signals: [{ id: 'lockfile_provenance.none' }],
  }
}

export function skippedProvenance(): ProvenanceReport {
  return {
    enabled: false,
    status: 'skipped',
    packages: [],
    lockfiles: [],
    omitted: 0,
    signals: [],
  }
}

export function filesUnavailableProvenance(message: string): ProvenanceReport {
  return {
    enabled: true,
    status: 'pass',
    packages: [],
    lockfiles: [],
    omitted: 0,
    signals: [{ id: 'lockfile_provenance.files_unreadable', message }],
  }
}

export async function analyzeLockfiles(options: {
  files: readonly ChangedFile[]
  read: (path: string, which: 'base' | 'head') => Promise<{ text: string | null; error?: string }>
  lookup: ProvenanceClient
  maxLookups: number
}): Promise<ProvenanceReport> {
  const sources = options.files.flatMap((file) => {
    const kind = lockfileKind(file.filename)
    if (!kind || file.status === 'removed') return []
    return [{ file, kind }]
  })
  if (sources.length === 0) {
    return {
      enabled: true,
      status: 'pass',
      packages: [],
      lockfiles: [],
      omitted: 0,
      signals: [{ id: 'lockfile_provenance.none' }],
    }
  }

  const lockfiles: ProvenanceReport['lockfiles'] = []
  const pending: { lockfile: string; pkg: ParsedPackage }[] = []
  for (const source of sources) {
    const head = await options.read(source.file.filename, 'head')
    if (head.error || head.text == null) {
      const message = head.error ?? 'head copy was not readable'
      lockfiles.push({ path: source.file.filename, added: 0, error: message })
      continue
    }
    const headParsed = parseLockfile(source.kind, head.text)
    if (headParsed.error) {
      lockfiles.push({ path: source.file.filename, added: 0, error: headParsed.error })
      continue
    }
    const basePath = source.file.previousFilename ?? source.file.filename
    const addedFile = (source.file.status === 'added' || source.file.status === 'copied') && !source.file.previousFilename
    let before: ParsedPackage[] = []
    if (!addedFile) {
      const base = await options.read(basePath, 'base')
      if (base.error || base.text == null) {
        const message = base.error ?? 'base copy was missing, so added packages were not compared'
        lockfiles.push({ path: source.file.filename, added: 0, error: message })
        continue
      }
      const baseParsed = parseLockfile(source.kind, base.text)
      if (baseParsed.error) {
        lockfiles.push({ path: source.file.filename, added: 0, error: baseParsed.error })
        continue
      }
      before = baseParsed.packages
    }
    const added = addedPackages(before, headParsed.packages)
    lockfiles.push({ path: source.file.filename, added: added.length })
    for (const pkg of added) pending.push({ lockfile: source.file.filename, pkg })
  }

  pending.sort((a, b) => (
    a.lockfile.localeCompare(b.lockfile)
    || a.pkg.name.localeCompare(b.pkg.name)
    || a.pkg.version.localeCompare(b.pkg.version)
    || packageIdentity(a.pkg).localeCompare(packageIdentity(b.pkg))
  ))

  const cap = Math.max(0, options.maxLookups)
  let budget = cap
  const planned = pending.map((item) => {
    if (!item.pkg.registry) return 'local' as const
    if (budget <= 0) return 'capped' as const
    budget -= 1
    return 'query' as const
  })
  const lookedUp = await mapPool(pending, LOOKUP_CONCURRENCY, async (item, index) => {
    const plan = planned[index]
    if (plan === 'local') {
      return packageRow(item, 'unknown', { code: 'not_registry' })
    }
    if (plan !== 'query') {
      return packageRow(item, 'unknown', { code: 'not_queried' })
    }
    try {
      const hit = await options.lookup.lookup(item.pkg)
      return packageRow(item, hit.state, hit.detail)
    } catch {
      return packageRow(item, 'unknown', { code: 'lookup_failed' })
    }
  })

  const signals: ProvenanceSignal[] = []
  for (const lockfile of lockfiles) {
    if (lockfile.error) signals.push({ id: 'lockfile_provenance.unreadable', lockfile: lockfile.path, message: lockfile.error })
  }
  const readable = lockfiles.filter((lockfile) => !lockfile.error)
  if (readable.length > 0 && readable.every((lockfile) => lockfile.added === 0) && lockfiles.every((lockfile) => !lockfile.error)) {
    signals.push({ id: 'lockfile_provenance.no_additions', lockfiles: readable.map((lockfile) => lockfile.path) })
  }
  const failed = lookedUp.filter((pkg) => pkg.detail.code === 'lookup_failed').length
  if (failed > 0) signals.push({ id: 'lockfile_provenance.lookup_failed', count: failed })
  if (lookedUp.some((pkg) => pkg.detail.code === 'not_queried')) {
    signals.push({ id: 'lockfile_provenance.capped', cap })
  }

  const shown = lookedUp.slice(0, DISPLAY_LIMIT)
  return {
    enabled: true,
    status: 'pass',
    packages: shown,
    lockfiles,
    omitted: Math.max(0, lookedUp.length - shown.length),
    signals,
  }
}

function packageRow(
  item: { lockfile: string; pkg: ParsedPackage },
  state: ProvenancePackageReport['state'],
  detail: ProvenanceDetail,
): ProvenancePackageReport {
  return {
    lockfile: item.lockfile,
    ecosystem: item.pkg.ecosystem,
    name: item.pkg.name,
    version: item.pkg.version,
    state,
    detail,
  }
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Math.max(1, Math.min(limit, items.length || 1))
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item, index)
    }
  }
  if (items.length === 0) return results
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

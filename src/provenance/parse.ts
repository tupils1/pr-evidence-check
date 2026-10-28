import YAML from 'js-yaml'
import { asRecord, asString } from '../text'
import type { Ecosystem } from '../types'

export type LockKind = 'npm' | 'pnpm' | 'yarn' | 'poetry' | 'cargo' | 'go'

export interface ParsedPackage {
  ecosystem: Ecosystem
  name: string
  version: string
  /** When false, the package is not on a public registry we know how to query. */
  registry: boolean
  /** PyPI distribution filename, when the lockfile lists one. */
  filename?: string
}

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SEMVER_PREFIX = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/

const NPM_PUBLIC_HOSTS = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'registry.npmmirror.com',
  'registry.npm.taobao.org',
])

export function lockfileKind(filename: string): LockKind | null {
  const base = filename.split('/').pop() ?? filename
  switch (base) {
    case 'package-lock.json':
      return 'npm'
    case 'pnpm-lock.yaml':
      return 'pnpm'
    case 'yarn.lock':
      return 'yarn'
    case 'poetry.lock':
      return 'poetry'
    case 'Cargo.lock':
      return 'cargo'
    case 'go.sum':
      return 'go'
    default:
      return null
  }
}

export function parseLockfile(kind: LockKind, text: string): { packages: ParsedPackage[]; error?: string } {
  try {
    const packages = dedupe(parseKind(kind, text))
    return { packages }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { packages: [], error: message }
  }
}

export function packageIdentity(pkg: Pick<ParsedPackage, 'ecosystem' | 'name' | 'version'>): string {
  const name = pkg.ecosystem === 'pypi' ? normalizePypiName(pkg.name) : pkg.name
  return `${pkg.ecosystem}\0${name}\0${pkg.version}`
}

export function addedPackages(before: readonly ParsedPackage[], after: readonly ParsedPackage[]): ParsedPackage[] {
  const seen = new Set(before.map(packageIdentity))
  const added: ParsedPackage[] = []
  const emitted = new Set<string>()
  for (const pkg of after) {
    const id = packageIdentity(pkg)
    if (seen.has(id) || emitted.has(id)) continue
    emitted.add(id)
    added.push(pkg)
  }
  return added
}

export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[_.]+/g, '-').replace(/-+/g, '-')
}

function parseKind(kind: LockKind, text: string): ParsedPackage[] {
  switch (kind) {
    case 'npm':
      return parseNpmLock(text)
    case 'pnpm':
      return parsePnpmLock(text)
    case 'yarn':
      return parseYarnLock(text)
    case 'poetry':
      return parsePoetryLock(text)
    case 'cargo':
      return parseCargoLock(text)
    case 'go':
      return parseGoSum(text)
  }
}

function parseNpmLock(text: string): ParsedPackage[] {
  const data = JSON.parse(text) as unknown
  const record = asRecord(data)
  if (!record) throw new Error('package-lock.json is not an object')
  if (record.packages && typeof record.packages === 'object') return parseNpmPackages(record.packages)
  if (record.dependencies && typeof record.dependencies === 'object') return parseNpmDependencies(record.dependencies)
  return []
}

function parseNpmPackages(value: object): ParsedPackage[] {
  const out: ParsedPackage[] = []
  for (const [key, entry] of Object.entries(value)) {
    if (!key) continue
    const record = asRecord(entry)
    if (!record || record.link === true) continue
    const version = asString(record.version)
    if (!version) continue
    const name = asString(record.name) ?? nameFromNodeModules(key)
    if (!name) continue
    out.push(npmPackage(name, version, record.resolved))
  }
  return out
}

function parseNpmDependencies(value: object): ParsedPackage[] {
  const out: ParsedPackage[] = []
  const walk = (node: object): void => {
    for (const [name, entry] of Object.entries(node)) {
      const record = asRecord(entry)
      if (!record) continue
      const version = asString(record.version)
      if (version) out.push(npmPackage(name, version, record.resolved))
      const nested = asRecord(record.dependencies)
      if (nested) walk(nested)
    }
  }
  walk(value)
  return out
}

function npmPackage(name: string, version: string, resolved: unknown): ParsedPackage {
  return {
    ecosystem: 'npm',
    name,
    version,
    registry: npmRegistry(version, resolved),
  }
}

function npmRegistry(version: string, resolved: unknown): boolean {
  if (!SEMVER.test(version)) return false
  if (typeof resolved !== 'string' || resolved.length === 0) return true
  return npmHost(resolved)
}

function npmHost(url: string): boolean {
  if (url.startsWith('file:') || url.startsWith('link:') || url.startsWith('git+') || url.startsWith('github:')) {
    return false
  }
  try {
    const host = new URL(url).host.toLowerCase()
    return NPM_PUBLIC_HOSTS.has(host)
  } catch {
    return false
  }
}

function nameFromNodeModules(key: string): string | null {
  const marker = 'node_modules/'
  const index = key.lastIndexOf(marker)
  if (index < 0) return null
  const rest = key.slice(index + marker.length)
  if (!rest) return null
  if (rest.startsWith('@')) {
    const [scope, name] = rest.split('/')
    if (!scope || !name) return null
    return `${scope}/${name}`
  }
  const name = rest.split('/')[0]
  return name || null
}

function parsePnpmLock(text: string): ParsedPackage[] {
  const data = YAML.load(text)
  const record = asRecord(data)
  if (!record) throw new Error('pnpm-lock.yaml is not a mapping')
  const packages = asRecord(record.packages)
  if (!packages) return []
  const out: ParsedPackage[] = []
  for (const [key, entry] of Object.entries(packages)) {
    const parsed = splitPnpmKey(key)
    if (!parsed) continue
    const resolution = asRecord(asRecord(entry)?.resolution)
    out.push({
      ecosystem: 'npm',
      name: parsed.name,
      version: parsed.version,
      registry: pnpmRegistry(parsed.version, resolution),
    })
  }
  return out
}

export function splitPnpmKey(key: string): { name: string; version: string } | null {
  let raw = key.trim()
  if (!raw) return null
  if (raw.startsWith('/')) raw = raw.slice(1)
  const peer = raw.indexOf('(')
  if (peer >= 0) raw = raw.slice(0, peer)
  const scoped = raw.startsWith('@')
  let name = ''
  let rest = ''
  if (scoped) {
    const slash = raw.indexOf('/')
    if (slash < 0) return null
    const after = raw.slice(slash + 1)
    const at = after.indexOf('@')
    const nested = after.indexOf('/')
    if (at >= 0 && (nested < 0 || at < nested)) {
      name = raw.slice(0, slash + 1 + at)
      rest = after.slice(at + 1)
    } else if (nested >= 0) {
      name = raw.slice(0, slash + 1 + nested)
      rest = after.slice(nested + 1)
    } else {
      return null
    }
  } else {
    const at = raw.indexOf('@')
    const slash = raw.indexOf('/')
    if (at >= 0 && (slash < 0 || at < slash)) {
      name = raw.slice(0, at)
      rest = raw.slice(at + 1)
    } else if (slash >= 0) {
      name = raw.slice(0, slash)
      rest = raw.slice(slash + 1)
    } else {
      return null
    }
  }
  const match = SEMVER_PREFIX.exec(rest)
  if (!name || !match) return null
  return { name, version: match[0] }
}

function pnpmRegistry(version: string, resolution: Record<string, unknown> | undefined): boolean {
  if (!SEMVER.test(version)) return false
  if (!resolution) return true
  const type = asString(resolution.type)
  if (type === 'git' || type === 'directory') return false
  const tarball = asString(resolution.tarball)
  if (!tarball) return true
  return npmHost(tarball)
}

function parseYarnLock(text: string): ParsedPackage[] {
  const out: ParsedPackage[] = []
  let descriptors: string[] = []
  let version = ''
  let resolved = ''
  let resolution = ''
  const flush = (): void => {
    if (descriptors.length === 0) return
    const name = yarnName(descriptors[0] ?? '')
    if (name && version) {
      out.push({
        ecosystem: 'npm',
        name,
        version,
        registry: yarnRegistry(version, resolution, resolved),
      })
    }
    descriptors = []
    version = ''
    resolved = ''
    resolution = ''
  }
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) {
      flush()
      if (line.trim() === '__metadata:' || !line.includes('@')) continue
      const header = line.replace(/:\s*$/, '')
      descriptors = splitYarnDescriptors(header)
      continue
    }
    const versionMatch = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line)
    if (versionMatch?.[1]) version = versionMatch[1]
    const resolvedMatch = /^\s+resolved:?\s+"?([^"\s]+)"?\s*$/.exec(line)
    if (resolvedMatch?.[1]) resolved = resolvedMatch[1]
    const resolutionMatch = /^\s+resolution:?\s+"?([^"\s]+)"?\s*$/.exec(line)
    if (resolutionMatch?.[1]) resolution = resolutionMatch[1]
  }
  flush()
  return out
}

function splitYarnDescriptors(header: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote = false
  for (const char of header) {
    if (char === '"') {
      quote = !quote
      continue
    }
    if (char === ',' && !quote) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function yarnName(descriptor: string): string | null {
  const match = /^(.*)@(?:npm|workspace|patch|portal|file|git|link|exec|github):/.exec(descriptor)
  if (match?.[1]) return match[1]
  const at = descriptor.lastIndexOf('@')
  if (at <= 0) return null
  return descriptor.slice(0, at)
}

function yarnRegistry(version: string, resolution: string, resolved: string): boolean {
  const protocol = /@(npm|workspace|patch|portal|file|git|link|exec|github):/.exec(resolution)?.[1]
  if (protocol) return protocol === 'npm' && SEMVER.test(version)
  if (!SEMVER.test(version)) return false
  if (!resolved) return true
  return npmHost(resolved)
}

function parsePoetryLock(text: string): ParsedPackage[] {
  const chunks = text.split(/\n(?=\[\[package\]\])/)
  const out: ParsedPackage[] = []
  for (const chunk of chunks) {
    if (!chunk.includes('[[package]]')) continue
    const name = /^name\s*=\s*"([^"]+)"/m.exec(chunk)?.[1]
    const version = /^version\s*=\s*"([^"]+)"/m.exec(chunk)?.[1]
    if (!name || !version) continue
    const source = /\[package\.source\][\s\S]*?(?=\n\[\[|\n\[package\.|\s*$)/.exec(chunk)?.[0] ?? ''
    const sourceType = /^type\s*=\s*"([^"]+)"/m.exec(source)?.[1] ?? ''
    const sourceUrl = /^url\s*=\s*"([^"]+)"/m.exec(source)?.[1] ?? ''
    const files = [...chunk.matchAll(/\{\s*file\s*=\s*"([^"]+)"/g)].map((match) => match[1] ?? '').filter(Boolean)
    const filename = files.find((file) => file.endsWith('.tar.gz'))
      ?? files.find((file) => file.endsWith('.whl'))
      ?? files[0]
    out.push({
      ecosystem: 'pypi',
      name,
      version,
      registry: poetryRegistry(sourceType, sourceUrl),
      ...(filename ? { filename } : {}),
    })
  }
  return out
}

function poetryRegistry(sourceType: string, sourceUrl: string): boolean {
  if (sourceType === 'git' || sourceType === 'directory' || sourceType === 'file' || sourceType === 'path') {
    return false
  }
  if (!sourceUrl) return true
  try {
    const host = new URL(sourceUrl).host.toLowerCase()
    return host === 'pypi.org' || host === 'files.pythonhosted.org' || host === 'pypi.python.org'
  } catch {
    return false
  }
}

function parseCargoLock(text: string): ParsedPackage[] {
  const chunks = text.split(/\n(?=\[\[package\]\])/)
  const out: ParsedPackage[] = []
  for (const chunk of chunks) {
    if (!chunk.includes('[[package]]')) continue
    const name = /^name\s*=\s*"([^"]+)"/m.exec(chunk)?.[1]
    const version = /^version\s*=\s*"([^"]+)"/m.exec(chunk)?.[1]
    if (!name || !version) continue
    const source = /^source\s*=\s*"([^"]+)"/m.exec(chunk)?.[1] ?? ''
    out.push({
      ecosystem: 'crates',
      name,
      version,
      registry: cargoRegistry(source),
    })
  }
  return out
}

function cargoRegistry(source: string): boolean {
  if (!source) return false
  if (source.startsWith('git+') || source.startsWith('path+')) return false
  return source.startsWith('registry+https://github.com/rust-lang/crates.io-index')
    || source.includes('index.crates.io')
}

function parseGoSum(text: string): ParsedPackage[] {
  const modules = new Map<string, ParsedPackage>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [name, rawVersion] = trimmed.split(/\s+/)
    if (!name || !rawVersion) continue
    const goMod = rawVersion.endsWith('/go.mod')
    const version = goMod ? rawVersion.slice(0, -'/go.mod'.length) : rawVersion
    if (!version || version.includes('/')) continue
    const id = `${name}\0${version}`
    if (modules.has(id) && goMod) continue
    modules.set(id, { ecosystem: 'go', name, version, registry: true })
  }
  return [...modules.values()]
}

function dedupe(packages: ParsedPackage[]): ParsedPackage[] {
  const byId = new Map<string, ParsedPackage>()
  for (const pkg of packages) {
    const id = packageIdentity(pkg)
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, pkg)
      continue
    }
    if (!existing.registry && pkg.registry) byId.set(id, { ...pkg, filename: pkg.filename ?? existing.filename })
    else if (!existing.filename && pkg.filename) byId.set(id, { ...existing, filename: pkg.filename })
  }
  return [...byId.values()]
}

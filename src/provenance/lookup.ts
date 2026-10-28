import { asRecord, asString } from '../text'
import type { ProvenanceDetail } from '../types'
import type { ParsedPackage } from './parse'
import { normalizePypiName } from './parse'

export interface ProvenanceHit {
  state: 'present' | 'unknown'
  detail: ProvenanceDetail
}

export interface ProvenanceClient {
  lookup(pkg: ParsedPackage): Promise<ProvenanceHit>
}

const USER_AGENT = 'pr-evidence-check'
const DEFAULT_TIMEOUT_MS = 5_000

const PRESENT = (detail: ProvenanceDetail): ProvenanceHit => ({ state: 'present', detail })
const UNKNOWN = (detail: ProvenanceDetail): ProvenanceHit => ({ state: 'unknown', detail })
const NOT_FOUND = UNKNOWN({ code: 'not_found' })
const NO_ATTESTATION = UNKNOWN({ code: 'no_attestation' })
const LOOKUP_FAILED = UNKNOWN({ code: 'lookup_failed' })

export function createRegistryProvenanceClient(options?: {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): ProvenanceClient {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    async lookup(pkg) {
      if (!pkg.registry) return UNKNOWN({ code: 'not_registry' })
      try {
        switch (pkg.ecosystem) {
          case 'npm':
            return await lookupNpm(fetchImpl, timeoutMs, pkg)
          case 'pypi':
            return await lookupPypi(fetchImpl, timeoutMs, pkg)
          case 'crates':
            return await lookupCrates(fetchImpl, timeoutMs, pkg)
          case 'go':
            return await lookupGo(fetchImpl, timeoutMs, pkg)
        }
      } catch {
        return LOOKUP_FAILED
      }
    },
  }
}

async function lookupNpm(fetchImpl: typeof fetch, timeoutMs: number, pkg: ParsedPackage): Promise<ProvenanceHit> {
  const name = pkg.name.startsWith('@')
    ? `@${encodeURIComponent(pkg.name.slice(1))}`
    : encodeURIComponent(pkg.name)
  const response = await requestJson(fetchImpl, `https://registry.npmjs.org/${name}/${encodeURIComponent(pkg.version)}`, timeoutMs, 'application/json')
  if (response.kind === 'fail') return LOOKUP_FAILED
  if (response.status === 404) return NOT_FOUND
  if (response.status !== 200) return LOOKUP_FAILED
  const attestations = asRecord(asRecord(asRecord(response.body)?.dist)?.attestations)
  if (!attestations) return NO_ATTESTATION
  if (asRecord(attestations.provenance)) return PRESENT({ code: 'npm_provenance' })
  if (asString(attestations.url)) return PRESENT({ code: 'npm_attestation' })
  return NO_ATTESTATION
}

async function lookupPypi(fetchImpl: typeof fetch, timeoutMs: number, pkg: ParsedPackage): Promise<ProvenanceHit> {
  const project = encodeURIComponent(normalizePypiName(pkg.name))
  const version = encodeURIComponent(pkg.version)
  let filename = pkg.filename
  if (!filename) {
    const meta = await requestJson(fetchImpl, `https://pypi.org/pypi/${project}/${version}/json`, timeoutMs, 'application/json')
    if (meta.kind === 'fail') return LOOKUP_FAILED
    if (meta.status === 404) return NOT_FOUND
    if (meta.status !== 200) return LOOKUP_FAILED
    filename = pypiFilename(meta.body)
    if (!filename) return NO_ATTESTATION
  }
  const file = encodeURIComponent(filename)
  const provenance = await requestJson(
    fetchImpl,
    `https://pypi.org/integrity/${project}/${version}/${file}/provenance`,
    timeoutMs,
    'application/vnd.pypi.integrity.v1+json, application/json;q=0.9',
  )
  if (provenance.kind === 'fail') return LOOKUP_FAILED
  if (provenance.status === 404) return NO_ATTESTATION
  if (provenance.status !== 200) return LOOKUP_FAILED
  const bundles = asRecord(provenance.body)?.attestation_bundles
  if (Array.isArray(bundles) && bundles.length > 0) return PRESENT({ code: 'pypi_provenance' })
  return NO_ATTESTATION
}

function pypiFilename(body: unknown): string | undefined {
  const urls = asRecord(body)?.urls
  if (!Array.isArray(urls)) return undefined
  const names = urls.flatMap((item) => {
    const name = asString(asRecord(item)?.filename)
    return name ? [name] : []
  })
  return names.find((name) => name.endsWith('.tar.gz')) ?? names.find((name) => name.endsWith('.whl')) ?? names[0]
}

async function lookupCrates(fetchImpl: typeof fetch, timeoutMs: number, pkg: ParsedPackage): Promise<ProvenanceHit> {
  const response = await requestJson(
    fetchImpl,
    `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`,
    timeoutMs,
    'application/json',
  )
  if (response.kind === 'fail') return LOOKUP_FAILED
  if (response.status === 404) return NOT_FOUND
  if (response.status !== 200) return LOOKUP_FAILED
  const repository = cratesRepository(asRecord(asRecord(response.body)?.version)?.trustpub_data)
  if (!repository) return NO_ATTESTATION
  return PRESENT({ code: 'crates_trustpub', repository })
}

function cratesRepository(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) return null
  const sha = asString(record.sha)
  const repository = asString(record.repository) ?? asString(record.project_path)
  if (!sha || !repository) return null
  return repository
}

async function lookupGo(fetchImpl: typeof fetch, timeoutMs: number, pkg: ParsedPackage): Promise<ProvenanceHit> {
  const response = await requestJson(fetchImpl, goInfoUrl(pkg.name, pkg.version), timeoutMs, 'application/json')
  if (response.kind === 'fail') return LOOKUP_FAILED
  if (response.status === 404) return NOT_FOUND
  if (response.status !== 200) return LOOKUP_FAILED
  const origin = asRecord(asRecord(response.body)?.Origin)
  const url = asString(origin?.URL)
  const hash = asString(origin?.Hash)
  if (!url || !hash) return NO_ATTESTATION
  return PRESENT({ code: 'go_origin', url })
}

export function goInfoUrl(moduleName: string, version: string): string {
  const path = moduleName.split('/').filter((part) => part.length > 0).map(escapeGoSegment).join('/')
  return `https://proxy.golang.org/${path}/@v/${escapeGoSegment(version)}.info`
}

function escapeGoSegment(segment: string): string {
  const escaped = segment.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`)
  return encodeURIComponent(escaped)
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  accept: string,
): Promise<{ kind: 'ok'; status: number; body: unknown } | { kind: 'fail' }> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = text
      }
    }
    return { kind: 'ok', status: response.status, body }
  } catch {
    return { kind: 'fail' }
  }
}

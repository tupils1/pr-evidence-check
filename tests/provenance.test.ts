import { describe, expect, it } from 'vitest'
import { skippedClaims } from '../src/claims/verify'
import { defaultConfig } from '../src/config'
import { buildEvidence } from '../src/evidence/select'
import { analyzePacket } from '../src/packet/analyze'
import { analyzeLockfiles, emptyProvenance, skippedProvenance } from '../src/provenance/analyze'
import { createRegistryProvenanceClient } from '../src/provenance/lookup'
import { addedPackages, lockfileKind, packageIdentity, parseLockfile, splitPnpmKey, type ParsedPackage } from '../src/provenance/parse'
import { renderComment } from '../src/render'
import { analyzeScope } from '../src/scope/analyze'
import type { ChangedFile, ProvenanceDetail, ProvenanceReport } from '../src/types'

const NPM_V3 = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/@scope/pkg': { version: '2.0.0', resolved: 'https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz' },
    'apps/web/node_modules/fresh': { version: '1.0.0', name: 'fresh' },
    'node_modules/linked': { version: '1.0.0', link: true },
    'node_modules/local': { version: '1.0.0', resolved: 'file:../local' },
    'node_modules/weird': { version: '1.0.0', resolved: '::::' },
    'node_modules/git-dep': { version: '1.0.0', resolved: 'git+https://github.com/example/git-dep.git' },
    'node_modules/alias': { version: '9.9.9', name: 'real-pkg' },
  },
})

const NPM_V1 = JSON.stringify({
  dependencies: {
    'left-pad': {
      version: '1.3.0',
      resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      dependencies: { nested: { version: '1.0.0' } },
    },
  },
})

const PNPM = [
  "lockfileVersion: '9.0'",
  'packages:',
  '  left-pad@1.3.0:',
  '    resolution: {integrity: sha512-abc}',
  "  '@scope/pkg@2.0.0':",
  '    resolution: {integrity: sha512-def, tarball: https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz}',
  '  fresh@1.0.0(react@18.2.0):',
  '    resolution: {integrity: sha512-ghi}',
  '  gitpkg@1.2.3:',
  '    resolution: {type: git, repo: https://github.com/example/gitpkg, commit: abcdef}',
  '  local@1.0.0:',
  '    resolution: {tarball: file:../local}',
  '  /old@1.0.0:',
  '    resolution: {integrity: sha512-old}',
  '  /@scope/legacy/1.5.0:',
  '    resolution: {integrity: sha512-v5}',
  '  /peer@1.2.3_react@18.2.0:',
  '    resolution: {integrity: sha512-peer}',
].join('\n')

const YARN_CLASSIC = [
  '# yarn lockfile v1',
  '',
  'left-pad@^1.0.0, left-pad@^1.2.0:',
  '  version "1.3.0"',
  '  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#hash"',
  '  integrity sha512-abc',
  '',
  '"@scope/pkg@^2.0.0":',
  '  version "2.0.0"',
  '  resolved "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz#hash"',
  '',
  '"git-dep@^1.0.0":',
  '  version "1.0.0"',
  '  resolved "git+https://github.com/example/git-dep.git#abc"',
].join('\n')

const YARN_BERRY = [
  '__metadata:',
  '  version: 8',
  '',
  '"fresh@npm:^1.0.0":',
  '  version: 1.0.0',
  '  resolution: "fresh@npm:1.0.0"',
  '  checksum: 10c0/abc',
  '  languageName: node',
  '  linkType: hard',
  '',
  '"local@workspace:packages/local":',
  '  version: 0.0.0-use.local',
  '  resolution: "local@workspace:packages/local"',
  '  languageName: unknown',
  '  linkType: soft',
].join('\n')

const POETRY = [
  '[[package]]',
  'name = "Certifi"',
  'version = "2024.8.30"',
  'files = [',
  '    {file = "Certifi-2024.8.30-py3-none-any.whl", hash = "sha256:abc"},',
  '    {file = "Certifi-2024.8.30.tar.gz", hash = "sha256:def"},',
  ']',
  '',
  '[[package]]',
  'name = "localpkg"',
  'version = "0.1.0"',
  '',
  '[package.source]',
  'type = "directory"',
  'url = "vendor/local"',
  '',
  '[[package]]',
  'name = "privatepkg"',
  'version = "1.2.3"',
  '',
  '[package.source]',
  'type = "legacy"',
  'url = "https://example.internal/simple"',
  '',
  '[[package]]',
  'name = "bad-source"',
  'version = "1.0.0"',
  '',
  '[package.source]',
  'type = "legacy"',
  'url = "not a url"',
  '',
  '[[package]]',
  'name = "gitdep"',
  'version = "1.0.0"',
  '',
  '[package.source]',
  'type = "git"',
  'url = "https://github.com/example/gitdep"',
].join('\n')

const CARGO = [
  'version = 3',
  '',
  '[[package]]',
  'name = "anyhow"',
  'version = "1.0.86"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  '',
  '[[package]]',
  'name = "serde"',
  'version = "1.0.210"',
  'source = "sparse+https://index.crates.io/"',
  '',
  '[[package]]',
  'name = "app"',
  'version = "0.1.0"',
  '',
  '[[package]]',
  'name = "other"',
  'version = "0.2.0"',
  'source = "git+https://github.com/example/other?rev=abc"',
].join('\n')

const GO_SUM = [
  'golang.org/x/text v0.21.0 h1:abc',
  'golang.org/x/text v0.21.0/go.mod h1:def',
  'gopkg.in/yaml.v2 v2.4.0+incompatible h1:zzz',
  '',
  'not-a-module',
].join('\n')

function byName(packages: ParsedPackage[], name: string): ParsedPackage {
  const found = packages.find((pkg) => pkg.name === name)
  expect(found, name).toBeTruthy()
  return found as ParsedPackage
}

describe('lockfile parsers', () => {
  it('recognizes the six lockfile names in any directory', () => {
    expect(lockfileKind('package-lock.json')).toBe('npm')
    expect(lockfileKind('apps/web/pnpm-lock.yaml')).toBe('pnpm')
    expect(lockfileKind('yarn.lock')).toBe('yarn')
    expect(lockfileKind('services/api/poetry.lock')).toBe('poetry')
    expect(lockfileKind('Cargo.lock')).toBe('cargo')
    expect(lockfileKind('go.sum')).toBe('go')
    expect(lockfileKind('package.json')).toBeNull()
    expect(lockfileKind('npm-shrinkwrap.json')).toBeNull()
  })

  it('parses npm lockfiles and skips the root, links, and non-registry versions', () => {
    const packages = parseLockfile('npm', NPM_V3).packages
    expect(packages.map((pkg) => pkg.name).sort()).toEqual(['@scope/pkg', 'fresh', 'git-dep', 'left-pad', 'local', 'real-pkg', 'weird'])
    expect(byName(packages, 'left-pad').registry).toBe(true)
    expect(byName(packages, '@scope/pkg').registry).toBe(true)
    expect(byName(packages, 'fresh').registry).toBe(true)
    expect(byName(packages, 'real-pkg').version).toBe('9.9.9')
    expect(byName(packages, 'local').registry).toBe(false)
    expect(byName(packages, 'weird').registry).toBe(false)
    expect(byName(packages, 'git-dep').registry).toBe(false)
    const v1 = parseLockfile('npm', NPM_V1).packages
    expect(v1.map((pkg) => `${pkg.name}@${pkg.version}`).sort()).toEqual(['left-pad@1.3.0', 'nested@1.0.0'])
    expect(byName(v1, 'nested').registry).toBe(true)
    expect(parseLockfile('npm', '{}').packages).toEqual([])
    expect(parseLockfile('npm', '[]').error).toMatch(/not an object/)
    expect(parseLockfile('npm', 'nope').error).toBeTruthy()
  })

  it('parses pnpm package keys, including peers and older lockfile paths', () => {
    const packages = parseLockfile('pnpm', PNPM).packages
    expect(packages.map((pkg) => `${pkg.name}@${pkg.version}`).sort()).toEqual([
      '@scope/legacy@1.5.0',
      '@scope/pkg@2.0.0',
      'fresh@1.0.0',
      'gitpkg@1.2.3',
      'left-pad@1.3.0',
      'local@1.0.0',
      'old@1.0.0',
      'peer@1.2.3',
    ])
    expect(byName(packages, 'gitpkg').registry).toBe(false)
    expect(byName(packages, 'local').registry).toBe(false)
    expect(byName(packages, 'fresh').registry).toBe(true)
    expect(splitPnpmKey('')).toBeNull()
    expect(splitPnpmKey('@scope')).toBeNull()
    expect(splitPnpmKey('foo')).toBeNull()
    expect(splitPnpmKey('foo@not-a-version')).toBeNull()
    expect(parseLockfile('pnpm', 'lockfileVersion: "9.0"\n').packages).toEqual([])
    expect(parseLockfile('pnpm', 'hello').error).toMatch(/not a mapping/)
    expect(parseLockfile('pnpm', ':\n').error).toBeTruthy()
  })

  it('parses classic and berry yarn lockfiles', () => {
    const classic = parseLockfile('yarn', YARN_CLASSIC).packages
    expect(classic.map((pkg) => pkg.name).sort()).toEqual(['@scope/pkg', 'git-dep', 'left-pad'])
    expect(byName(classic, 'left-pad').registry).toBe(true)
    expect(byName(classic, 'git-dep').registry).toBe(false)
    const berry = parseLockfile('yarn', YARN_BERRY).packages
    expect(byName(berry, 'fresh')).toMatchObject({ version: '1.0.0', registry: true })
    expect(byName(berry, 'local').registry).toBe(false)
    expect(parseLockfile('yarn', '').packages).toEqual([])
  })

  it('parses poetry, cargo, and go.sum entries', () => {
    const poetry = parseLockfile('poetry', POETRY).packages
    expect(byName(poetry, 'Certifi')).toMatchObject({
      registry: true,
      filename: 'Certifi-2024.8.30.tar.gz',
      ecosystem: 'pypi',
    })
    expect(byName(poetry, 'localpkg').registry).toBe(false)
    expect(byName(poetry, 'privatepkg').registry).toBe(false)
    expect(byName(poetry, 'bad-source').registry).toBe(false)
    expect(byName(poetry, 'gitdep').registry).toBe(false)
    const cargo = parseLockfile('cargo', CARGO).packages
    expect(byName(cargo, 'anyhow').registry).toBe(true)
    expect(byName(cargo, 'serde').registry).toBe(true)
    expect(byName(cargo, 'app').registry).toBe(false)
    expect(byName(cargo, 'other').registry).toBe(false)
    const mods = parseLockfile('go', GO_SUM).packages
    expect(mods.map((pkg) => `${pkg.name}@${pkg.version}`).sort()).toEqual([
      'golang.org/x/text@v0.21.0',
      'gopkg.in/yaml.v2@v2.4.0+incompatible',
    ])
    expect(parseLockfile('go', '').packages).toEqual([])
    expect(parseLockfile('poetry', '[[package]]\nname = "no-version"\n').packages).toEqual([])
    expect(parseLockfile('cargo', '[[package]]\nname = "no-version"\n').packages).toEqual([])
  })

  it('treats a new version as added and keeps PyPI names case-insensitive', () => {
    const before = parseLockfile('npm', NPM_V1).packages
    const after = parseLockfile('npm', JSON.stringify({
      dependencies: {
        'left-pad': { version: '1.3.0' },
        'left-pad-next': { version: '1.4.0' },
      },
    })).packages
    expect(addedPackages(before, after).map((pkg) => pkg.name)).toEqual(['left-pad-next'])
    const certifi = byName(parseLockfile('poetry', POETRY).packages, 'Certifi')
    expect(packageIdentity(certifi)).toBe(packageIdentity({ ...certifi, name: 'certifi' }))
  })
})

describe('registry provenance lookup', () => {
  function clientFor(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | 'throw') {
    const urls: string[] = []
    const headers: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      urls.push(url)
      const headerBag = init?.headers
      const userAgent = headerBag instanceof Headers
        ? headerBag.get('user-agent')
        : (headerBag as Record<string, string> | undefined)?.['user-agent']
      headers.push(userAgent ?? '')
      const result = await handler(url, init)
      if (result === 'throw') throw new Error('network down')
      return result
    }
    return { urls, headers, client: createRegistryProvenanceClient({ fetchImpl, timeoutMs: 1000 }) }
  }

  function json(status: number, body: unknown): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }

  const npmPkg = (name: string, version = '1.0.0', registry = true): ParsedPackage => ({
    ecosystem: 'npm', name, version, registry,
  })

  it('reads npm provenance and attestation fields, and degrades on misses and network errors', async () => {
    const present = clientFor((url) => {
      expect(url).toBe('https://registry.npmjs.org/@scope%2Fpkg/1.2.3')
      return json(200, { dist: { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/@scope%2fpkg@1.2.3', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } }, signatures: [{ keyid: 'abc' }] } })
    })
    expect(await present.client.lookup(npmPkg('@scope/pkg', '1.2.3'))).toEqual({ state: 'present', detail: { code: 'npm_provenance' } })
    expect(present.headers).toEqual(['pr-evidence-check'])

    const attested = clientFor(() => json(200, { dist: { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/pkg@1.0.0' } } }))
    expect((await attested.client.lookup(npmPkg('pkg'))).detail).toEqual({ code: 'npm_attestation' })

    const signedOnly = clientFor(() => json(200, { dist: { signatures: [{ keyid: 'SHA256:abc', sig: 'x' }] } }))
    expect((await signedOnly.client.lookup(npmPkg('left-pad'))).detail).toEqual({ code: 'no_attestation' })

    const emptyAttestations = clientFor(() => json(200, { dist: { attestations: {} } }))
    expect((await emptyAttestations.client.lookup(npmPkg('pkg'))).detail).toEqual({ code: 'no_attestation' })

    const missing = clientFor(() => json(404, 'Not Found'))
    expect((await missing.client.lookup(npmPkg('missing'))).detail).toEqual({ code: 'not_found' })

    const broken = clientFor(() => json(500, { message: 'nope' }))
    expect((await broken.client.lookup(npmPkg('pkg'))).detail).toEqual({ code: 'lookup_failed' })

    const down = clientFor(() => 'throw')
    expect((await down.client.lookup(npmPkg('pkg'))).detail).toEqual({ code: 'lookup_failed' })

    const local = clientFor(() => { throw new Error('should not fetch') })
    expect((await local.client.lookup(npmPkg('git-dep', '1.0.0', false))).detail).toEqual({ code: 'not_registry' })
    expect(local.urls).toEqual([])
  })

  it('reads PyPI integrity provenance and discovers a filename from the JSON API', async () => {
    const direct = clientFor((url) => {
      expect(url).toBe('https://pypi.org/integrity/certifi/2024.8.30/certifi-2024.8.30.tar.gz/provenance')
      return json(200, { version: 1, attestation_bundles: [{ publisher: { kind: 'GitHub' } }] })
    })
    expect(await direct.client.lookup({
      ecosystem: 'pypi', name: 'Certifi', version: '2024.8.30', registry: true, filename: 'certifi-2024.8.30.tar.gz',
    })).toEqual({ state: 'present', detail: { code: 'pypi_provenance' } })

    const discovered = clientFor((url) => {
      if (url.endsWith('/json')) {
        return json(200, { urls: [{ filename: 'demo-1.0.0-py3-none-any.whl' }, { filename: 'demo-1.0.0.tar.gz' }] })
      }
      expect(url).toBe('https://pypi.org/integrity/demo/1.0.0/demo-1.0.0.tar.gz/provenance')
      return json(404, { message: 'No provenance available' })
    })
    expect((await discovered.client.lookup({ ecosystem: 'pypi', name: 'Demo', version: '1.0.0', registry: true })).detail).toEqual({ code: 'no_attestation' })

    const wheelOnly = clientFor((url) => {
      if (url.endsWith('/json')) return json(200, { urls: [{ filename: 'demo-1.0.0-py3-none-any.whl' }, { packagetype: 'sdist' }] })
      expect(url).toContain('demo-1.0.0-py3-none-any.whl')
      return json(200, { attestation_bundles: [] })
    })
    expect((await wheelOnly.client.lookup({ ecosystem: 'pypi', name: 'demo', version: '1.0.0', registry: true })).detail).toEqual({ code: 'no_attestation' })

    const absent = clientFor(() => json(404, { message: 'Not Found' }))
    expect((await absent.client.lookup({ ecosystem: 'pypi', name: 'nope', version: '1.0.0', registry: true })).detail).toEqual({ code: 'not_found' })

    const noFiles = clientFor(() => json(200, { urls: [] }))
    expect((await noFiles.client.lookup({ ecosystem: 'pypi', name: 'empty', version: '1.0.0', registry: true })).detail).toEqual({ code: 'no_attestation' })
    expect(noFiles.urls).toHaveLength(1)

    const metaDown = clientFor(() => json(503, {}))
    expect((await metaDown.client.lookup({ ecosystem: 'pypi', name: 'demo', version: '1.0.0', registry: true })).detail).toEqual({ code: 'lookup_failed' })

    const integrityDown = clientFor((url) => url.endsWith('/json') ? json(200, { urls: [{ filename: 'demo-1.0.0.tar.gz' }] }) : 'throw')
    expect((await integrityDown.client.lookup({ ecosystem: 'pypi', name: 'demo', version: '1.0.0', registry: true })).detail).toEqual({ code: 'lookup_failed' })
  })

  it('reads crates.io trusted publishing and the Go module origin', async () => {
    const crate = clientFor((url) => {
      expect(url).toBe('https://crates.io/api/v1/crates/anyhow/1.0.86')
      return json(200, { version: { trustpub_data: { provider: 'github', repository: 'octo/repo', run_id: '1', sha: 'abc' } } })
    })
    expect(await crate.client.lookup({ ecosystem: 'crates', name: 'anyhow', version: '1.0.86', registry: true })).toEqual({
      state: 'present',
      detail: { code: 'crates_trustpub', repository: 'octo/repo' },
    })

    const gitlab = clientFor(() => json(200, { version: { trustpub_data: { provider: 'gitlab', project_path: 'group/proj', job_id: '9', sha: 'def' } } }))
    expect((await gitlab.client.lookup({ ecosystem: 'crates', name: 'demo', version: '0.1.0', registry: true })).detail).toEqual({
      code: 'crates_trustpub', repository: 'group/proj',
    })

    const unsigned = clientFor(() => json(200, { version: { trustpub_data: null, checksum: 'abc' } }))
    expect((await unsigned.client.lookup({ ecosystem: 'crates', name: 'serde', version: '1.0.210', registry: true })).detail).toEqual({ code: 'no_attestation' })

    const partial = clientFor(() => json(200, { version: { trustpub_data: { repository: 'octo/repo' } } }))
    expect((await partial.client.lookup({ ecosystem: 'crates', name: 'demo', version: '0.1.0', registry: true })).detail).toEqual({ code: 'no_attestation' })

    const missingCrate = clientFor(() => json(404, { errors: [{ detail: 'not found' }] }))
    expect((await missingCrate.client.lookup({ ecosystem: 'crates', name: 'nope', version: '0.0.1', registry: true })).detail).toEqual({ code: 'not_found' })

    const crateDown = clientFor(() => 'throw')
    expect((await crateDown.client.lookup({ ecosystem: 'crates', name: 'demo', version: '0.1.0', registry: true })).detail).toEqual({ code: 'lookup_failed' })

    const golang = clientFor((url) => {
      expect(url).toBe('https://proxy.golang.org/github.com/!azure/go-autorest/@v/v0.11.0.info')
      return json(200, { Version: 'v0.11.0', Origin: { VCS: 'git', URL: 'https://github.com/Azure/go-autorest', Hash: 'abc', Ref: 'refs/tags/v0.11.0' } })
    })
    expect(await golang.client.lookup({ ecosystem: 'go', name: 'github.com/Azure/go-autorest', version: 'v0.11.0', registry: true })).toEqual({
      state: 'present',
      detail: { code: 'go_origin', url: 'https://github.com/Azure/go-autorest' },
    })

    const incompatible = clientFor((url) => {
      expect(url).toBe('https://proxy.golang.org/gopkg.in/yaml.v2/@v/v2.4.0%2Bincompatible.info')
      return json(200, { Version: 'v2.4.0+incompatible' })
    })
    expect((await incompatible.client.lookup({ ecosystem: 'go', name: 'gopkg.in/yaml.v2', version: 'v2.4.0+incompatible', registry: true })).detail).toEqual({ code: 'no_attestation' })

    const originOnly = clientFor(() => json(200, { Origin: { URL: 'https://go.googlesource.com/text' } }))
    expect((await originOnly.client.lookup({ ecosystem: 'go', name: 'golang.org/x/text', version: 'v0.21.0', registry: true })).detail).toEqual({ code: 'no_attestation' })

    const missingMod = clientFor(() => json(404, 'not found'))
    expect((await missingMod.client.lookup({ ecosystem: 'go', name: 'golang.org/x/text', version: 'v0.0.0', registry: true })).detail).toEqual({ code: 'not_found' })

    const goDown = clientFor(() => json(429, { message: 'slow down' }))
    expect((await goDown.client.lookup({ ecosystem: 'go', name: 'golang.org/x/text', version: 'v0.21.0', registry: true })).detail).toEqual({ code: 'lookup_failed' })
  })

  it('marks the package unknown when the registry does not answer before the timeout', async () => {
    const client = createRegistryProvenanceClient({
      timeoutMs: 20,
      fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      }),
    })
    expect((await client.lookup(npmPkg('slow'))).detail).toEqual({ code: 'lookup_failed' })
  })
})

describe('lockfile provenance report', () => {
  function file(filename: string, extra: Partial<ChangedFile> = {}): ChangedFile {
    return { filename, status: 'modified', additions: 10, deletions: 1, ...extra }
  }

  it('diffs a modified lockfile, ignores removals, and does not query packages that were already there', async () => {
    const reads: string[] = []
    const report = await analyzeLockfiles({
      files: [
        file('package-lock.json'),
        file('old/package-lock.json', { status: 'removed' }),
        file('README.md'),
      ],
      maxLookups: 30,
      read: async (path, which) => {
        reads.push(`${which}:${path}`)
        const specs = which === 'base' ? ['left-pad@1.3.0'] : ['left-pad@1.3.0', 'fresh@2.0.0']
        return { text: lock(specs) }
      },
      lookup: { lookup: async (pkg) => ({ state: pkg.name === 'fresh' ? 'present' : 'unknown', detail: { code: pkg.name === 'fresh' ? 'npm_provenance' : 'no_attestation' } }) },
    })
    expect(report.status).toBe('pass')
    expect(report.packages).toEqual([{
      lockfile: 'package-lock.json',
      ecosystem: 'npm',
      name: 'fresh',
      version: '2.0.0',
      state: 'present',
      detail: { code: 'npm_provenance' },
    }])
    expect(reads).toEqual(['head:package-lock.json', 'base:package-lock.json'])
    expect(report.signals).toEqual([])
  })

  it('treats an added lockfile as all new and a renamed lockfile as a diff against the old path', async () => {
    const reads: string[] = []
    const added = await analyzeLockfiles({
      files: [file('go.sum', { status: 'added', previousFilename: undefined })],
      maxLookups: 5,
      read: async (path, which) => {
        reads.push(`${which}:${path}`)
        return { text: 'golang.org/x/text v0.21.0 h1:abc\n' }
      },
      lookup: { lookup: async () => ({ state: 'present', detail: { code: 'go_origin', url: 'https://go.googlesource.com/text' } }) },
    })
    expect(reads).toEqual(['head:go.sum'])
    expect(added.packages[0]).toMatchObject({ name: 'golang.org/x/text', state: 'present' })

    const renamed = await analyzeLockfiles({
      files: [file('apps/web/yarn.lock', { status: 'renamed', previousFilename: 'yarn.lock' })],
      maxLookups: 5,
      read: async (_path, which) => ({
        text: which === 'base' ? YARN_CLASSIC : `${YARN_CLASSIC}\n\n"fresh@^1.0.0":\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/fresh/-/fresh-1.0.0.tgz#hash"\n`,
      }),
      lookup: { lookup: async () => ({ state: 'unknown', detail: { code: 'no_attestation' } }) },
    })
    expect(renamed.packages.map((pkg) => pkg.name)).toEqual(['fresh'])
    expect(renamed.lockfiles[0]?.path).toBe('apps/web/yarn.lock')
  })

  it('stays a passing report when the base copy, the head copy, or the parser fails', async () => {
    const baseMissing = await analyzeLockfiles({
      files: [file('Cargo.lock')],
      maxLookups: 5,
      read: async (_path, which) => which === 'head' ? { text: CARGO } : { text: null },
      lookup: { lookup: async () => { throw new Error('should not be called') } },
    })
    expect(baseMissing.status).toBe('pass')
    expect(baseMissing.packages).toEqual([])
    expect(baseMissing.signals[0]).toMatchObject({ id: 'lockfile_provenance.unreadable', message: expect.stringContaining('base copy') })

    const headError = await analyzeLockfiles({
      files: [file('poetry.lock')],
      maxLookups: 5,
      read: async () => ({ text: null, error: 'GitHub API 403' }),
      lookup: { lookup: async () => { throw new Error('should not be called') } },
    })
    expect(headError.signals[0]).toMatchObject({ id: 'lockfile_provenance.unreadable', message: 'GitHub API 403' })

    const invalid = await analyzeLockfiles({
      files: [file('package-lock.json', { status: 'added' })],
      maxLookups: 5,
      read: async () => ({ text: '{' }),
      lookup: { lookup: async () => { throw new Error('should not be called') } },
    })
    expect(invalid.signals[0]?.id).toBe('lockfile_provenance.unreadable')
    expect(invalid.packages).toEqual([])
  })

  it('caps registry lookups, keeps non-registry packages, and omits rows past the comment limit', async () => {
    const names = Array.from({ length: 41 }, (_value, index) => `pkg${String(index).padStart(2, '0')}@1.0.0`)
    names.push('local-git@1.0.0')
    const queried: string[] = []
    const report = await analyzeLockfiles({
      files: [file('pnpm-lock.yaml', { status: 'added' })],
      maxLookups: 2,
      read: async () => ({ text: pnpmOf([...names]) }),
      lookup: {
        lookup: async (pkg) => {
          queried.push(pkg.name)
          if (pkg.name === 'pkg00') throw new Error('timeout')
          return { state: 'unknown', detail: { code: 'no_attestation' } }
        },
      },
    })
    expect(queried).toEqual(['pkg00', 'pkg01'])
    expect(report.packages).toHaveLength(40)
    expect(report.omitted).toBe(2)
    expect(report.packages.find((pkg) => pkg.name === 'pkg00')?.detail).toEqual({ code: 'lookup_failed' })
    expect(report.packages.find((pkg) => pkg.name === 'local-git')?.detail).toEqual({ code: 'not_registry' })
    expect(report.signals.map((signal) => signal.id)).toEqual(['lockfile_provenance.lookup_failed', 'lockfile_provenance.capped'])
    expect(report.status).toBe('pass')
  })

  it('reports no additions and no lockfile changes without a warn or error status', async () => {
    const same = await analyzeLockfiles({
      files: [file('Cargo.lock'), file('go.sum', { status: 'copied', previousFilename: 'vendor/go.sum' })],
      maxLookups: 0,
      read: async (path) => ({ text: path.endsWith('go.sum') ? GO_SUM : CARGO }),
      lookup: { lookup: async () => { throw new Error('should not be called') } },
    })
    expect(same.signals.map((signal) => signal.id)).toEqual(['lockfile_provenance.no_additions'])
    expect(same.status).toBe('pass')

    const none = await analyzeLockfiles({
      files: [file('src/app.ts')],
      maxLookups: 30,
      read: async () => { throw new Error('should not be called') },
      lookup: { lookup: async () => { throw new Error('should not be called') } },
    })
    expect(none.signals).toEqual([{ id: 'lockfile_provenance.none' }])
    expect(skippedProvenance().status).toBe('skipped')
    expect(emptyProvenance().signals[0]?.id).toBe('lockfile_provenance.none')
  })

  it('does not call a lockfile with zero additions unchanged when another lockfile could not be read', async () => {
    const report = await analyzeLockfiles({
      files: [file('package-lock.json'), file('yarn.lock')],
      maxLookups: 1,
      read: async (path, which) => {
        if (path === 'yarn.lock') return { text: null, error: 'missing' }
        return { text: lock(which === 'base' ? ['left-pad@1.3.0'] : ['left-pad@1.3.0']) }
      },
      lookup: { lookup: async () => { throw new Error('should not be called') } },
    })
    expect(report.signals.map((signal) => signal.id)).toEqual(['lockfile_provenance.unreadable'])
  })
})

describe('provenance comment', () => {
  const details: ProvenanceDetail[] = [
    { code: 'npm_provenance' },
    { code: 'npm_attestation' },
    { code: 'pypi_provenance' },
    { code: 'crates_trustpub', repository: 'octo/repo' },
    { code: 'go_origin', url: 'https://go.googlesource.com/text' },
    { code: 'no_attestation' },
    { code: 'not_found' },
    { code: 'lookup_failed' },
    { code: 'not_queried' },
    { code: 'not_registry' },
  ]

  function comment(provenance: ProvenanceReport, language: 'en' | 'zh' = 'en'): string {
    const config = defaultConfig()
    return renderComment({
      language,
      failOn: 'warning',
      headSha: 'a'.repeat(40),
      generatedAt: '2026-10-27T00:00:00.000Z',
      scope: analyzeScope({ prRepo: 'acme/app', config: config.scope, issues: [], files: [] }),
      evidence: buildEvidence({ sha: 'a'.repeat(40), items: [], config: config.testEvidence, consideredJobs: 0, consideredChecks: 0 }),
      packet: analyzePacket('', config.reviewPacket),
      claims: skippedClaims(),
      provenance,
    }, 'acme/app')
  }

  it('renders present and unknown rows in English and Chinese without affecting the status word', () => {
    const provenance: ProvenanceReport = {
      enabled: true,
      status: 'pass',
      omitted: 3,
      lockfiles: [{ path: 'package-lock.json', added: details.length }],
      signals: [
        { id: 'lockfile_provenance.lookup_failed', count: 1 },
        { id: 'lockfile_provenance.capped', cap: 30 },
      ],
      packages: details.map((detail, index) => ({
        lockfile: index % 2 === 0 ? 'package-lock.json' : 'Cargo.lock',
        ecosystem: 'npm',
        name: index === 4 ? '@scope/pkg' : `pkg-${index}`,
        version: '1.0.0',
        state: detail.code === 'npm_provenance' || detail.code === 'pypi_provenance' || detail.code === 'crates_trustpub' || detail.code === 'go_origin' || detail.code === 'npm_attestation' ? 'present' : 'unknown',
        detail,
      })),
    }
    const english = comment(provenance)
    expect(english).toContain('lockfile-provenance=pass')
    expect(english).toContain('### Lockfile provenance')
    expect(english).toContain('fail-on')
    expect(english).toContain('present · npm registry provenance')
    expect(english).toContain('present · npm registry sigstore attestation')
    expect(english).toContain('present · PyPI integrity provenance')
    expect(english).toContain('crates.io trusted publisher')
    expect(english).toContain('module proxy origin')
    expect(english).toContain('unknown · no provenance attestation')
    expect(english).toContain('version was not found on the public registry')
    expect(english).toContain('registry lookup failed')
    expect(english).toContain('lookup cap was reached')
    expect(english).toContain('not a package from these public registries')
    expect(english).toContain('3 more were omitted')
    expect(english).toContain('@\u200bscope/pkg@\u200b1.0.0')
    expect(english).toContain('Lockfile provenance')

    const chinese = comment(provenance, 'zh')
    expect(chinese).toContain('### 锁文件来源证明')
    expect(chinese).toContain('有来源证明 · npm registry 的 provenance')
    expect(chinese).toContain('unknown · 仓库响应里没有来源证明')
    expect(chinese).toContain('另有 3 个未列出')
    expect(chinese).toContain('达到查询上限')

    const single = comment({
      ...provenance,
      omitted: 0,
      packages: [],
      signals: [{ id: 'lockfile_provenance.lookup_failed', count: 1 }],
    })
    expect(single).toContain('1 registry lookup failed')
    const plural = comment({
      ...provenance,
      omitted: 0,
      packages: [],
      signals: [{ id: 'lockfile_provenance.lookup_failed', count: 2 }],
    })
    expect(plural).toContain('2 registry lookups failed')
  })

  it('renders the empty, skipped, and unreadable states', () => {
    expect(comment(emptyProvenance())).toContain('None of those lockfiles changed.')
    expect(comment(skippedProvenance())).toContain('lockfile-provenance=skipped')
    expect(comment(skippedProvenance(), 'zh')).toContain('已在配置中关闭')
    const unread = comment({
      enabled: true,
      status: 'pass',
      packages: [],
      omitted: 0,
      lockfiles: [{ path: 'poetry.lock', added: 0, error: 'base copy was missing' }],
      signals: [
        { id: 'lockfile_provenance.unreadable', lockfile: 'poetry.lock', message: 'base copy was missing' },
        { id: 'lockfile_provenance.no_additions', lockfiles: ['Cargo.lock'] },
        { id: 'lockfile_provenance.files_unreadable', message: 'GitHub API 500' },
      ],
    })
    expect(unread).toContain('Could not read `poetry.lock`')
    expect(unread).toContain('every package version was already present')
    expect(unread).toContain('file list could not be read')
    const zh = comment({
      enabled: true,
      status: 'pass',
      packages: [],
      omitted: 0,
      lockfiles: [],
      signals: [
        { id: 'lockfile_provenance.none' },
        { id: 'lockfile_provenance.no_additions', lockfiles: ['go.sum'] },
        { id: 'lockfile_provenance.unreadable', lockfile: 'go.sum', message: 'head copy was not readable' },
        { id: 'lockfile_provenance.files_unreadable', message: 'nope' },
        { id: 'lockfile_provenance.lookup_failed', count: 2 },
        { id: 'lockfile_provenance.capped', cap: 0 },
      ],
    }, 'zh')
    expect(zh).toContain('没有改这些锁文件')
    expect(zh).toContain('没有新增的包版本')
    expect(zh).toContain('读不到 `go.sum`')
    expect(zh).toContain('读不到 PR 文件列表')
    expect(zh).toContain('2 个包在查询公共仓库时失败')
    expect(zh).toContain('在 0 个包后停止')
  })
})

function lock(specs: string[]): string {
  const packages: Record<string, { version: string; resolved?: string }> = {}
  for (const spec of specs) {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    const entry: { version: string; resolved?: string } = { version }
    if (name === 'local-git') entry.resolved = 'git+https://github.com/example/local-git.git'
    packages[`node_modules/${name}`] = entry
  }
  return JSON.stringify({ lockfileVersion: 3, packages })
}

function pnpmOf(specs: string[]): string {
  const lines = ["lockfileVersion: '9.0'", 'packages:']
  for (const spec of specs) {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    lines.push(`  ${name}@${version}:`)
    if (name === 'local-git') lines.push('    resolution: {tarball: file:../local-git}')
    else lines.push('    resolution: {integrity: sha512-abc}')
  }
  return lines.join('\n')
}

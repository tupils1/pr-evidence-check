import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { GitHubHttpError } from '../src/errors'
import { createGitHubClient, type GitHubTransport } from '../src/github/client'
import { downloadJobLog, logsToText } from '../src/github/logs'

function transport(
  impl: GitHubTransport['request'],
  graphql?: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
): GitHubTransport {
  return {
    request: impl,
    graphql: (graphql as GitHubTransport['graphql'] | undefined) ?? (async () => {
      throw new Error('graphql failed')
    }),
  }
}

describe('logs', () => {
  it('unzips Actions logs and leaves plain text alone', () => {
    const zipped = zipSync({
      'job/2_test.txt': strToU8('noise\nTests:       2 passed, 2 total'),
      'job/1_setup.txt': strToU8('setup'),
    })
    const text = logsToText(zipped)
    expect(text).toContain('1_setup.txt')
    expect(text.indexOf('1_setup.txt')).toBeLessThan(text.indexOf('2_test.txt'))
    expect(text).toContain('2 passed')
    expect(logsToText('plain log')).toBe('plain log')
    const binary = String.fromCharCode(...zipped)
    expect(logsToText(binary)).toContain('2 passed')
  })

  it('follows a successful download and refuses oversized or forbidden logs without echoing the body', async () => {
    const zipped = zipSync({ 'a.txt': strToU8(`${'x'.repeat(200)}Tests:       1 passed, 1 total`) })
    const ok = await downloadJobLog({
      fetchImpl: async () => new Response(zipped, { status: 200 }),
      token: 't',
      owner: 'acme',
      repo: 'app',
      jobId: 9,
      maxChars: 40,
    })
    expect(ok.text).toContain('1 passed')
    expect(ok.text?.endsWith('1 total')).toBe(true)
    expect(ok.text?.length ?? 0).toBeLessThanOrEqual(40)

    const denied = await downloadJobLog({
      fetchImpl: async () => new Response('SECRET_TOKEN=abc', { status: 403 }),
      token: 't',
      owner: 'acme',
      repo: 'app',
      jobId: 9,
      maxChars: 100,
    })
    expect(denied.error).toBe('logs not readable with this token (403)')
    expect(denied.error).not.toContain('SECRET_TOKEN')

    const huge = await downloadJobLog({
      fetchImpl: async () => new Response(new Uint8Array(20), { status: 200 }),
      token: 't',
      owner: 'acme',
      repo: 'app',
      jobId: 9,
      maxChars: 100,
      maxArchiveBytes: 8,
    })
    expect(huge.error).toMatch(/larger than 8/)

    const broken = await downloadJobLog({
      fetchImpl: async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]), { status: 200 }),
      token: 't',
      owner: 'acme',
      repo: 'app',
      jobId: 9,
      maxChars: 100,
    })
    expect(broken.error).toBe('could not read the log archive')
  })
})

describe('github client', () => {
  it('maps pull requests, base config, files, checks, jobs, and comments', async () => {
    const calls: string[] = []
    const client = createGitHubClient({
      owner: 'acme',
      repo: 'app',
      token: 't',
      fetchImpl: async () => new Response('Tests:       1 passed, 1 total', { status: 200 }),
      transport: transport(async (route, params) => {
        calls.push(`${route} page=${String(params.page ?? '')}`)
        if (route.startsWith('GET /repos/{owner}/{repo}/pulls/{pull_number}')) {
          if (route.endsWith('/files')) {
            const page = Number(params.page ?? 1)
            if (page === 1) {
              return { status: 200, data: Array.from({ length: 100 }, (_, index) => ({ filename: `f${index}.ts`, status: 'modified', additions: 1, deletions: 0 })) }
            }
            return { status: 200, data: [{ filename: 'last.ts', status: 'renamed', previous_filename: 'old.ts', additions: 2, deletions: 3, patch: '+x' }] }
          }
          return {
            status: 200,
            data: {
              title: 'T',
              body: 'B',
              user: { login: 'dependabot[bot]', type: 'Bot' },
              labels: [{ name: 'dependencies' }, { name: '' }, { foo: 1 }, 'docs'],
              head: { sha: 'h'.repeat(40) },
              base: { sha: 'b'.repeat(40), ref: 'main' },
            },
          }
        }
        if (route.includes('/contents/')) {
          return { status: 200, data: { encoding: 'base64', content: Buffer.from('language: zh\n').toString('base64') } }
        }
        if (route.includes('/commits/')) {
          return { status: 200, data: { check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success', html_url: 'https://example.test/check', output: { summary: 'Tests: 1 passed, 1 total' } }] } }
        }
        if (route.endsWith('/actions/runs')) {
          return { status: 200, data: { workflow_runs: [{ id: 5, name: 'CI' }] } }
        }
        if (route.includes('/jobs')) {
          return { status: 200, data: { jobs: [{ id: 9, name: 'unit', status: 'completed', conclusion: 'success', html_url: 'https://example.test/job' }] } }
        }
        if (route.includes('/issues/{issue_number}') && route.startsWith('GET')) {
          return { status: 200, data: [{ id: 3, body: '<!-- pr-evidence-check -->\nold' }] }
        }
        if (route.startsWith('POST')) return { status: 201, data: { id: 8, html_url: 'https://example.test/comment/8' } }
        if (route.startsWith('PATCH')) return { status: 200, data: { id: 3, html_url: 'https://example.test/comment/3' } }
        return { status: 500, data: { message: 'nope' } }
      }, async () => ({
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: [
                { number: 12, title: 'Session', body: 'session', url: 'https://github.com/acme/app/issues/12', repository: { nameWithOwner: 'acme/app' } },
                null,
              ],
            },
          },
        },
      })),
    })

    const pr = await client.getPullRequest(7)
    expect(pr.baseSha).toBe('b'.repeat(40))
    expect(pr.authorLogin).toBe('dependabot[bot]')
    expect(pr.authorType).toBe('Bot')
    expect(pr.labels).toEqual(['dependencies', 'docs'])
    expect((await client.getRepoFile('.github/pr-evidence.yml', pr.baseSha)).text).toContain('language: zh')
    const files = await client.listFiles(7)
    expect(files).toHaveLength(101)
    expect(files[100]?.previousFilename).toBe('old.ts')
    expect((await client.listClosingIssues(7)).issues.map((item) => item.number)).toEqual([12])
    expect((await client.listCheckRuns(pr.headSha))[0]?.summary).toContain('passed')
    expect((await client.listWorkflowJobs(pr.headSha))[0]?.workflowName).toBe('CI')
    expect((await client.getJobLog(9, 1000)).text).toContain('1 passed')
    expect(await client.listComments(7)).toHaveLength(1)
    expect((await client.createComment(7, 'hi')).url).toContain('comment/8')
    expect((await client.updateComment(3, 'hi')).id).toBe(3)
    expect(calls.some((call) => call.includes('page=2'))).toBe(true)
    const commits = await client.listPullCommits(7)
    expect(commits).toEqual([])
  })

  it('turns missing config and missing issues into empty results, and HTTP errors into thrown status', async () => {
    const client = createGitHubClient({
      owner: 'acme',
      repo: 'app',
      transport: transport(async (route) => {
        if (route.includes('/contents/')) return { status: 404, data: { message: 'Not Found' } }
        if (route.includes('/issues/')) return { status: 404, data: {} }
        if (route.includes('/pulls/')) return { status: 403, data: { message: 'Resource not accessible' } }
        return { status: 403, data: { message: 'no' } }
      }),
    })
    expect(await client.getRepoFile('.github/pr-evidence.yml', 'abc')).toEqual({ text: null })
    expect(await client.getIssue('acme/app', 4)).toBeNull()
    await expect(client.getPullRequest(1)).rejects.toBeInstanceOf(GitHubHttpError)
    const broken = createGitHubClient({
      owner: 'acme',
      repo: 'app',
      transport: transport(async () => ({ status: 200, data: {} })),
    })
    const commits = createGitHubClient({
      owner: 'acme',
      repo: 'app',
      transport: transport(async (route) => {
        if (route.endsWith('/commits')) {
          return { status: 200, data: [{ sha: 'abc1234fff', commit: { message: 'lint clean' } }, { foo: 1 }] }
        }
        return { status: 404, data: {} }
      }),
    })
    expect(await commits.listPullCommits(7)).toEqual([{ sha: 'abc1234fff', message: 'lint clean' }])
    expect((await broken.listClosingIssues(1)).error).toMatch(/graphql failed/)
    expect(await broken.getJobLog(1, 10)).toEqual({ text: null, error: 'log download is not configured' })
  })
})

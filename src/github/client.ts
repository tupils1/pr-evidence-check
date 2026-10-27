import { getOctokit } from '@actions/github'
import { GitHubHttpError } from '../errors'
import { asNumber, asRecord, asString } from '../text'
import type { ChangedFile, CheckRunInfo, LinkedIssue, WorkflowJobInfo } from '../types'
import { downloadJobLog } from './logs'

export interface GitHubTransport {
  request(route: string, params: Record<string, unknown>): Promise<{ status: number; data: unknown }>
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>
}

export interface PullRequestInfo {
  number: number
  title: string
  body: string
  headSha: string
  baseSha: string
  baseRef: string
  authorLogin: string
  authorType: string
  labels: string[]
}

export interface GitHubClient {
  getPullRequest(number: number): Promise<PullRequestInfo>
  getRepoFile(path: string, ref: string): Promise<{ text: string | null; error?: string }>
  listFiles(number: number): Promise<ChangedFile[]>
  listClosingIssues(number: number): Promise<{ issues: LinkedIssue[]; error?: string }>
  getIssue(repo: string, number: number): Promise<LinkedIssue | null>
  listCheckRuns(sha: string): Promise<CheckRunInfo[]>
  listWorkflowJobs(sha: string): Promise<WorkflowJobInfo[]>
  getJobLog(jobId: number, maxChars: number): Promise<{ text: string | null; error?: string }>
  listPullCommits(number: number): Promise<{ sha: string; message: string }[]>
  listComments(number: number): Promise<{ id: number; body: string }[]>
  createComment(number: number, body: string): Promise<{ id: number; url: string }>
  updateComment(id: number, body: string): Promise<{ id: number; url: string }>
}

const CLOSING_ISSUES = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 50) {
          nodes {
            number
            title
            body
            url
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`

export function createGitHubClient(options: {
  transport: GitHubTransport
  owner: string
  repo: string
  fetchImpl?: typeof fetch
  token?: string
}): GitHubClient {
  const { transport, owner, repo } = options
  return {
    async getPullRequest(number) {
      const data = await expectOk(transport, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number: number,
      })
      const record = asRecord(data)
      const head = asRecord(record?.head)
      const base = asRecord(record?.base)
      const headSha = asString(head?.sha)
      const baseSha = asString(base?.sha)
      if (!record || !headSha || !baseSha) {
        throw new GitHubHttpError(200, 'Pull request response was missing head or base SHA.')
      }
      const user = asRecord(record.user)
      return {
        number,
        title: asString(record.title) ?? '',
        body: typeof record.body === 'string' ? record.body : '',
        headSha,
        baseSha,
        baseRef: asString(base?.ref) ?? '',
        authorLogin: asString(user?.login) ?? '',
        authorType: asString(user?.type) ?? '',
        labels: readLabels(record.labels),
      }
    },

    async getRepoFile(path, ref) {
      const clean = path.replace(/^\/+/, '')
      const response = await transport.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: clean,
        ref,
      })
      if (response.status === 404) return { text: null }
      if (response.status < 200 || response.status >= 300) {
        return { text: null, error: httpMessage(response.status, response.data) }
      }
      const record = asRecord(response.data)
      const content = asString(record?.content)
      if (!content || record?.encoding !== 'base64') {
        return { text: null, error: 'config response did not include base64 file content' }
      }
      return { text: Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8') }
    },

    async listFiles(number) {
      const rows = await paginate(transport, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
        owner,
        repo,
        pull_number: number,
      }, (data) => (Array.isArray(data) ? data : []), 300)
      return rows.map(toChangedFile)
    },

    async listClosingIssues(number) {
      try {
        const data = await transport.graphql<{
          repository?: {
            pullRequest?: {
              closingIssuesReferences?: { nodes?: unknown[] }
            } | null
          } | null
        }>(CLOSING_ISSUES, { owner, name: repo, number })
        const nodes = data.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []
        const issues = nodes.map(toGraphqlIssue).filter((issue): issue is LinkedIssue => issue != null)
        return { issues }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { issues: [], error: message }
      }
    },

    async getIssue(issueRepo, number) {
      const [issueOwner, issueName] = splitRepo(issueRepo, owner, repo)
      const response = await transport.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: issueOwner,
        repo: issueName,
        issue_number: number,
      })
      if (response.status === 404) return null
      if (response.status < 200 || response.status >= 300) {
        throw new GitHubHttpError(response.status, httpMessage(response.status, response.data))
      }
      return toRestIssue(response.data, `${issueOwner}/${issueName}`, 'closing_keyword')
    },

    async listCheckRuns(sha) {
      const rows = await paginate(transport, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        owner,
        repo,
        ref: sha,
      }, (data) => {
        const record = asRecord(data)
        return Array.isArray(record?.check_runs) ? record.check_runs : []
      }, 300)
      return rows.map(toCheckRun)
    },

    async listWorkflowJobs(sha) {
      const runs = await paginate(transport, 'GET /repos/{owner}/{repo}/actions/runs', {
        owner,
        repo,
        head_sha: sha,
      }, (data) => {
        const record = asRecord(data)
        return Array.isArray(record?.workflow_runs) ? record.workflow_runs : []
      }, 30)
      const jobs: WorkflowJobInfo[] = []
      for (const run of runs) {
        const record = asRecord(run)
        const runId = asNumber(record?.id)
        if (!runId) continue
        const workflowName = asString(record?.name) ?? ''
        const rows = await paginate(transport, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
          owner,
          repo,
          run_id: runId,
        }, (data) => {
          const body = asRecord(data)
          return Array.isArray(body?.jobs) ? body.jobs : []
        }, 100)
        for (const row of rows) {
          const job = toWorkflowJob(row, workflowName, runId)
          if (job) jobs.push(job)
          if (jobs.length >= 200) return jobs
        }
      }
      return jobs
    },

    async getJobLog(jobId, maxChars) {
      if (!options.token || !options.fetchImpl) {
        return { text: null, error: 'log download is not configured' }
      }
      return downloadJobLog({
        fetchImpl: options.fetchImpl,
        token: options.token,
        owner,
        repo,
        jobId,
        maxChars,
      })
    },

    async listPullCommits(number) {
      const rows = await paginate(transport, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
        owner,
        repo,
        pull_number: number,
      }, (data) => (Array.isArray(data) ? data : []), 100)
      return rows.flatMap((row) => {
        const record = asRecord(row)
        const commit = asRecord(record?.commit)
        const sha = asString(record?.sha)
        if (!sha) return []
        return [{ sha, message: asString(commit?.message) ?? '' }]
      })
    },

    async listComments(number) {
      const rows = await paginate(transport, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo,
        issue_number: number,
      }, (data) => (Array.isArray(data) ? data : []), 400)
      return rows.flatMap((row) => {
        const record = asRecord(row)
        const id = asNumber(record?.id)
        if (!id) return []
        return [{ id, body: typeof record?.body === 'string' ? record.body : '' }]
      })
    },

    async createComment(number, body) {
      const data = await expectOk(transport, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo,
        issue_number: number,
        body,
      })
      return commentRef(data)
    },

    async updateComment(id, body) {
      const data = await expectOk(transport, 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner,
        repo,
        comment_id: id,
        body,
      })
      return commentRef(data)
    },
  }
}

export function transportFromToken(token: string): GitHubTransport {
  const octokit = getOctokit(token)
  return {
    async request(route, params) {
      try {
        const response = await octokit.request(route, params)
        return { status: response.status, data: response.data }
      } catch (error) {
        const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0
        if (status > 0) return { status, data: { message: error instanceof Error ? error.message : String(error) } }
        throw error
      }
    },
    async graphql(query, variables) {
      return octokit.graphql(query, variables)
    },
  }
}

async function expectOk(transport: GitHubTransport, route: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await transport.request(route, params)
  if (response.status < 200 || response.status >= 300) {
    throw new GitHubHttpError(response.status, httpMessage(response.status, response.data))
  }
  return response.data
}

async function paginate(
  transport: GitHubTransport,
  route: string,
  params: Record<string, unknown>,
  pick: (data: unknown) => unknown[],
  cap: number,
): Promise<unknown[]> {
  const out: unknown[] = []
  for (let page = 1; page <= 10 && out.length < cap; page += 1) {
    const response = await transport.request(route, { ...params, per_page: 100, page })
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubHttpError(response.status, httpMessage(response.status, response.data))
    }
    const batch = pick(response.data)
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out.slice(0, cap)
}

function toChangedFile(value: unknown): ChangedFile {
  const record = asRecord(value)
  return {
    filename: asString(record?.filename) ?? '',
    ...(asString(record?.previous_filename) ? { previousFilename: asString(record?.previous_filename) } : {}),
    status: asString(record?.status) ?? 'modified',
    additions: asNumber(record?.additions) ?? 0,
    deletions: asNumber(record?.deletions) ?? 0,
    ...(typeof record?.patch === 'string' ? { patch: record.patch } : {}),
  }
}

function toCheckRun(value: unknown): CheckRunInfo {
  const record = asRecord(value)
  const output = asRecord(record?.output)
  const summary = asString(output?.summary)
  return {
    name: asString(record?.name) ?? '',
    status: asString(record?.status) ?? 'completed',
    conclusion: typeof record?.conclusion === 'string' ? record.conclusion : null,
    ...(asString(record?.html_url) ? { htmlUrl: asString(record?.html_url) } : {}),
    ...(summary ? { summary } : {}),
  }
}

function toWorkflowJob(value: unknown, workflowName: string, runId: number): WorkflowJobInfo | undefined {
  const record = asRecord(value)
  const id = asNumber(record?.id)
  if (!id) return undefined
  return {
    id,
    name: asString(record?.name) ?? '',
    workflowName,
    status: asString(record?.status) ?? 'completed',
    conclusion: typeof record?.conclusion === 'string' ? record.conclusion : null,
    ...(asString(record?.html_url) ? { htmlUrl: asString(record?.html_url) } : {}),
    runId,
  }
}

function toGraphqlIssue(value: unknown): LinkedIssue | undefined {
  const record = asRecord(value)
  const repository = asRecord(record?.repository)
  const repo = asString(repository?.nameWithOwner)
  const number = asNumber(record?.number)
  if (!record || !repo || !number) return undefined
  return {
    repo,
    number,
    title: asString(record.title) ?? '',
    body: typeof record.body === 'string' ? record.body : '',
    url: asString(record.url) ?? `https://github.com/${repo}/issues/${number}`,
    source: 'api',
  }
}

function toRestIssue(value: unknown, repo: string, source: LinkedIssue['source']): LinkedIssue {
  const record = asRecord(value)
  const number = asNumber(record?.number) ?? 0
  return {
    repo,
    number,
    title: asString(record?.title) ?? '',
    body: typeof record?.body === 'string' ? record.body : '',
    url: asString(record?.html_url) ?? `https://github.com/${repo}/issues/${number}`,
    source,
  }
}

function commentRef(value: unknown): { id: number; url: string } {
  const record = asRecord(value)
  return {
    id: asNumber(record?.id) ?? 0,
    url: asString(record?.html_url) ?? '',
  }
}

function readLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) names.push(item.trim())
      continue
    }
    const name = asString(asRecord(item)?.name)
    if (name) names.push(name)
  }
  return names
}

function splitRepo(repo: string, fallbackOwner: string, fallbackName: string): [string, string] {
  const [owner, name] = repo.split('/')
  if (owner && name) return [owner, name]
  return [fallbackOwner, fallbackName]
}

function httpMessage(status: number, data: unknown): string {
  const record = asRecord(data)
  const message = asString(record?.message)
  return message ? `GitHub API ${status}: ${message}` : `GitHub API ${status}`
}

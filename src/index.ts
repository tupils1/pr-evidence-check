import * as core from '@actions/core'
import * as github from '@actions/github'
import { ActionFailure } from './errors'
import { createGitHubClient, transportFromToken } from './github/client'
import { run } from './run'

async function main(): Promise<void> {
  try {
    const token = core.getInput('token')
    await run({
      io: {
        info: (message) => core.info(message),
        warning: (message) => core.warning(message),
        error: (message) => core.error(message),
        setOutput: (name, value) => core.setOutput(name, value),
        writeSummary: async (markdown) => {
          core.summary.emptyBuffer()
          await core.summary.addRaw(markdown).write()
        },
      },
      input: {
        token,
        configPath: core.getInput('config-path'),
        failOn: core.getInput('fail-on'),
        commentLanguage: core.getInput('comment-language'),
        eventName: github.context.eventName,
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        payload: github.context.payload as Record<string, unknown>,
      },
      createClient: (clientToken, owner, repo) => createGitHubClient({
        transport: transportFromToken(clientToken),
        owner,
        repo,
        token: clientToken,
        fetchImpl: fetch,
      }),
    })
  } catch (error) {
    if (error instanceof ActionFailure) {
      core.setFailed(error.message)
      return
    }
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

void main()

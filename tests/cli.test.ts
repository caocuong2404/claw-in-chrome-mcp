import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  launchReconnectAfterInstall,
  resolveInstallReconnectBindingOverride,
} from '../src/cli.ts'

test('resolveInstallReconnectBindingOverride only binds reconnect target when a single browser is selected', () => {
  assert.equal(resolveInstallReconnectBindingOverride(), null)
  assert.equal(
    resolveInstallReconnectBindingOverride(['chrome', 'edge']),
    null,
  )
  assert.deepEqual(resolveInstallReconnectBindingOverride(['chrome']), {
    browser: 'chrome',
  })
})

test('launchReconnectAfterInstall forwards the explicit single-browser target to reconnect', async () => {
  const calls: Array<Record<string, unknown>> = []

  const launched = await launchReconnectAfterInstall({
    browsers: ['chrome'],
    launchReconnectImpl: async options => {
      calls.push(options ?? {})
      return true
    },
  })

  assert.equal(launched, true)
  assert.deepEqual(calls, [
    {
      configuredBindingOverride: {
        browser: 'chrome',
      },
    },
  ])
})

test('launchReconnectAfterInstall leaves reconnect unbound when install targets multiple browsers', async () => {
  const calls: Array<Record<string, unknown>> = []

  const launched = await launchReconnectAfterInstall({
    browsers: ['chrome', 'edge'],
    launchReconnectImpl: async options => {
      calls.push(options ?? {})
      return true
    },
  })

  assert.equal(launched, true)
  assert.deepEqual(calls, [
    {
      configuredBindingOverride: null,
    },
  ])
})

test('serve keeps the stdio process alive while stdin stays open', async t => {
  const tsxCliPath = fileURLToPath(
    new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url),
  )
  const child = spawn(
    process.execPath,
    [
      tsxCliPath,
      'src/cli.ts',
      'serve',
      '--auto-launch-browser',
      'false',
      '--log-level',
      'silent',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        CIC_MCP_AUTO_LAUNCH_BROWSER: 'false',
        CIC_MCP_LOG_LEVEL: 'silent',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  let exitCode: number | null = null
  child.on('exit', code => {
    exitCode = code
  })

  t.after(async () => {
    if (exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
  })

  await delay(300)
  assert.equal(exitCode, null)

  child.stdin.end()
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
})

test('cli still runs when launched through a junction-style entry path', async t => {
  if (process.platform !== 'win32') {
    return
  }

  const projectRoot = fileURLToPath(new URL('..', import.meta.url))
  const tsxCliPath = fileURLToPath(
    new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url),
  )
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-cli-'))
  const junctionPath = join(tempRoot, 'linked-project')
  await symlink(projectRoot, junctionPath, 'junction')

  const child = spawn(
    process.execPath,
    [tsxCliPath, join(junctionPath, 'src', 'cli.ts'), '--version'],
    {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
  })

  t.after(() => {
    if (!child.killed && child.exitCode === null) {
      child.kill()
    }
  })

  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
  assert.equal(stdout.trim(), '0.1.0')
  assert.equal(stderr, '')
})

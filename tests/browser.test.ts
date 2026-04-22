import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CHROME_EXTENSION_RECONNECT_URL,
  DEFAULT_EXTENSION_IDS,
  findExtensionInstallations,
  launchClawInChromeReconnect,
  type BrowserPath,
} from '../src/browser.js'

test('findExtensionInstallations detects the concrete browser profile', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-browser-'))
  const browserPath: BrowserPath = {
    browser: 'chrome',
    path: join(tempRoot, 'Chrome', 'User Data'),
  }

  await mkdir(
    join(
      browserPath.path,
      'Profile 20',
      'Extensions',
      DEFAULT_EXTENSION_IDS[0]!,
      '1.0.0',
    ),
    { recursive: true },
  )

  const installations = await findExtensionInstallations([browserPath])

  assert.equal(installations.length, 1)
  assert.equal(installations[0]?.browser, 'chrome')
  assert.equal(installations[0]?.profile, 'Profile 20')
})

test('launchClawInChromeReconnect prefers the installed extension profile', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-launch-'))
  const browserPath: BrowserPath = {
    browser: 'chrome',
    path: join(tempRoot, 'Chrome', 'User Data'),
  }

  await mkdir(
    join(
      browserPath.path,
      'Profile 20',
      'Extensions',
      DEFAULT_EXTENSION_IDS[0]!,
      '1.0.0',
    ),
    { recursive: true },
  )

  let spawned:
    | {
        file: string
        args: string[]
      }
    | undefined
  let fallbackCalled = false

  const launched = await launchClawInChromeReconnect({
    browserPathsOverride: [browserPath],
    fallbackOpenUrl: async () => {
      fallbackCalled = true
      return false
    },
    resolveExecutablePath: async () => '/fake/browser',
    resolveWindowsExecutablePath: async () => 'C:\\fake\\browser.exe',
    spawnDetachedImpl: async (file, args) => {
      spawned = { file, args }
      return true
    },
  })

  assert.equal(launched, true)
  assert.equal(fallbackCalled, false)
  assert.ok(spawned)
  assert.ok(spawned.args.includes(CHROME_EXTENSION_RECONNECT_URL))
  assert.ok(
    spawned.args.some(arg => arg.includes('--profile-directory=Profile 20')),
  )
})

test('launchClawInChromeReconnect falls back to the generic browser opener', async () => {
  let fallbackUrl: string | undefined
  let spawnCalled = false

  const launched = await launchClawInChromeReconnect({
    browserPathsOverride: [],
    fallbackOpenUrl: async url => {
      fallbackUrl = url
      return true
    },
    spawnDetachedImpl: async () => {
      spawnCalled = true
      return false
    },
  })

  assert.equal(launched, true)
  assert.equal(spawnCalled, false)
  assert.equal(fallbackUrl, CHROME_EXTENSION_RECONNECT_URL)
})

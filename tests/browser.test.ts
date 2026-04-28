import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CHROME_EXTENSION_RECONNECT_URL,
  DEFAULT_EXTENSION_IDS,
  findExtensionInstallations,
  getAllSocketPaths,
  launchClawInChromeReconnect,
  removeRuntimeSocketRegistration,
  rememberRuntimeBrowserBinding,
  writeRuntimeSocketRegistration,
  type BrowserPath,
} from '../src/browser.js'

const EXTENSION_ID = DEFAULT_EXTENSION_IDS[0]!

test('findExtensionInstallations detects the concrete packaged browser profile', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-browser-'))
  const browserPath = createBrowserPath(tempRoot)

  await createPackagedInstallation(browserPath, 'Profile 20', '1.0.0')

  const installations = await findExtensionInstallations([browserPath])

  assert.equal(installations.length, 1)
  assert.equal(installations[0]?.browser, 'chrome')
  assert.equal(installations[0]?.profile, 'Profile 20')
  assert.equal(installations[0]?.installType, 'packaged')
})

test('findExtensionInstallations detects unpacked extensions via Secure Preferences', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-browser-'))
  const browserPath = createBrowserPath(tempRoot)
  const unpackedPath = join(tempRoot, 'plugin-source')

  await createUnpackedInstallation(browserPath, 'Default', unpackedPath, '2.0.0')

  const installations = await findExtensionInstallations([browserPath])

  assert.equal(installations.length, 1)
  assert.equal(installations[0]?.profile, 'Default')
  assert.equal(installations[0]?.installType, 'unpacked')
  assert.equal(installations[0]?.extensionPath, unpackedPath)
  assert.equal(installations[0]?.extensionVersion, '2.0.0')
})

test('findExtensionInstallations ignores empty packaged residues and broken unpacked paths', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-browser-'))
  const browserPath = createBrowserPath(tempRoot)
  const unpackedPath = join(tempRoot, 'plugin-source')

  await createUnpackedInstallation(browserPath, 'Default', unpackedPath, '2.0.0')
  await createBrokenUnpackedRegistration(
    browserPath,
    'Profile 20',
    join(tempRoot, 'missing-plugin-source'),
  )
  await mkdir(
    join(browserPath.path, 'Profile 20', 'Extensions', EXTENSION_ID),
    { recursive: true },
  )

  const installations = await findExtensionInstallations([browserPath])

  assert.equal(installations.length, 1)
  assert.equal(installations[0]?.profile, 'Default')
  assert.equal(installations[0]?.installType, 'unpacked')
})

test('launchClawInChromeReconnect prefers the installed extension profile', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-launch-'))
  const browserPath = createBrowserPath(tempRoot)

  await createPackagedInstallation(browserPath, 'Profile 20', '1.0.0')

  const spawned = await launchAndCaptureProfile(browserPath)

  assertSpawnedWithProfile(spawned, 'Profile 20')
  assert.ok(spawned.args.includes(CHROME_EXTENSION_RECONNECT_URL))
})

test('launchClawInChromeReconnect prefers the persisted runtime binding over scan order', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-launch-'))
  const browserPath = createBrowserPath(tempRoot)
  const bindingStatePath = join(tempRoot, 'browser-binding.json')

  await createPackagedInstallation(browserPath, 'Default', '1.0.0')
  await createPackagedInstallation(browserPath, 'Profile 20', '2.0.0')

  const remembered = await rememberRuntimeBrowserBinding(
    {
      browser: 'chrome',
      extensionId: EXTENSION_ID,
      extensionVersion: '2.0.0',
    },
    {
      browserPathsOverride: [browserPath],
      bindingStatePathOverride: bindingStatePath,
    },
  )

  assert.equal(remembered?.profile, 'Profile 20')

  const spawned = await launchAndCaptureProfile(browserPath, {
    bindingStatePathOverride: bindingStatePath,
  })

  assertSpawnedWithProfile(spawned, 'Profile 20')
})

test('launchClawInChromeReconnect prefers the explicit configured binding override', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-launch-'))
  const browserPath = createBrowserPath(tempRoot)

  await createPackagedInstallation(browserPath, 'Default', '1.0.0')
  await createPackagedInstallation(browserPath, 'Profile 20', '1.0.0')

  const spawned = await launchAndCaptureProfile(browserPath, {
    configuredBindingOverride: {
      browser: 'chrome',
      profile: 'Profile 20',
    },
  })

  assertSpawnedWithProfile(spawned, 'Profile 20')
})

test('rememberRuntimeBrowserBinding does not guess between equally matching packaged profiles', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-binding-'))
  const browserPath = createBrowserPath(tempRoot)

  await createPackagedInstallation(browserPath, 'Default', '1.0.0')
  await createPackagedInstallation(browserPath, 'Profile 20', '1.0.0')

  const remembered = await rememberRuntimeBrowserBinding(
    {
      browser: 'chrome',
      extensionId: EXTENSION_ID,
      extensionVersion: '1.0.0',
    },
    {
      browserPathsOverride: [browserPath],
      bindingStatePathOverride: join(tempRoot, 'browser-binding.json'),
    },
  )

  assert.equal(remembered, null)
})

test('rememberRuntimeBrowserBinding respects an explicit profile binding override', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-binding-'))
  const browserPath = createBrowserPath(tempRoot)
  const bindingStatePath = join(tempRoot, 'browser-binding.json')

  await createPackagedInstallation(browserPath, 'Default', '1.0.0')
  await createPackagedInstallation(browserPath, 'Profile 20', '1.0.0')

  const remembered = await rememberRuntimeBrowserBinding(
    {
      browser: 'chrome',
      extensionId: EXTENSION_ID,
      extensionVersion: '1.0.0',
    },
    {
      browserPathsOverride: [browserPath],
      bindingStatePathOverride: bindingStatePath,
      configuredBindingOverride: {
        browser: 'chrome',
        profile: 'Profile 20',
      },
    },
  )

  assert.equal(remembered?.profile, 'Profile 20')

  const spawned = await launchAndCaptureProfile(browserPath, {
    bindingStatePathOverride: bindingStatePath,
  })

  assertSpawnedWithProfile(spawned, 'Profile 20')
})

test('launchClawInChromeReconnect keeps the same packaged profile after an extension auto-update', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-launch-'))
  const browserPath = createBrowserPath(tempRoot)
  const bindingStatePath = join(tempRoot, 'browser-binding.json')

  const oldVersionPath = await createPackagedInstallation(browserPath, 'Profile 20', '2.0.0')
  await createPackagedInstallation(browserPath, 'Default', '1.0.0')

  const remembered = await rememberRuntimeBrowserBinding(
    {
      browser: 'chrome',
      extensionId: EXTENSION_ID,
      extensionVersion: '2.0.0',
    },
    {
      browserPathsOverride: [browserPath],
      bindingStatePathOverride: bindingStatePath,
      configuredBindingOverride: {
        browser: 'chrome',
        profile: 'Profile 20',
      },
    },
  )

  assert.equal(remembered?.profile, 'Profile 20')

  await removePath(oldVersionPath)
  await createPackagedInstallation(browserPath, 'Profile 20', '2.0.1')

  const spawned = await launchAndCaptureProfile(browserPath, {
    bindingStatePathOverride: bindingStatePath,
  })

  assertSpawnedWithProfile(spawned, 'Profile 20')
})

test('launchClawInChromeReconnect falls back instead of launching a different browser than the explicit override', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-launch-'))
  const chromePath = createBrowserPath(tempRoot)
  const edgePath: BrowserPath = {
    browser: 'edge',
    path: join(tempRoot, 'Edge', 'User Data'),
  }
  let fallbackUrl: string | undefined
  let spawnCalled = false

  await createPackagedInstallation(edgePath, 'Default', '1.0.0')

  const launched = await launchClawInChromeReconnect({
    browserPathsOverride: [chromePath, edgePath],
    configuredBindingOverride: {
      browser: 'chrome',
    },
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

test('getAllSocketPaths discovers per-instance runtime sockets on windows', async () => {
  if (process.platform !== 'win32') {
    return
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-sockets-'))
  const socketRegistryDir = join(tempRoot, 'runtime-sockets')
  const socketA = '\\\\.\\pipe\\claw-in-chrome-mcp-browser-bridge-test-a'
  const socketB = '\\\\.\\pipe\\claw-in-chrome-mcp-browser-bridge-test-b'

  await writeRuntimeSocketRegistration(socketA, {
    socketRegistryDir,
    pid: process.pid,
    runtimeBinding: { browser: 'chrome' },
  })
  await writeRuntimeSocketRegistration(socketB, {
    socketRegistryDir,
    pid: process.pid + 1_000_000,
    runtimeBinding: { browser: 'chrome' },
  })

  const socketPaths = getAllSocketPaths({ socketRegistryDir })

  assert.ok(socketPaths.includes(socketA))
  assert.ok(!socketPaths.includes(socketB))
  assert.ok(
    socketPaths.some(path =>
      path.startsWith('\\\\.\\pipe\\claw-in-chrome-mcp-browser-bridge-'),
    ),
  )

  await removeRuntimeSocketRegistration({
    socketRegistryDir,
    pid: process.pid,
  })
})

function createBrowserPath(tempRoot: string): BrowserPath {
  return {
    browser: 'chrome',
    path: join(tempRoot, 'Chrome', 'User Data'),
  }
}

async function createPackagedInstallation(
  browserPath: BrowserPath,
  profile: string,
  version: string,
): Promise<string> {
  const extensionVersionPath = join(
    browserPath.path,
    profile,
    'Extensions',
    EXTENSION_ID,
    version,
  )
  await mkdir(extensionVersionPath, { recursive: true })
  await writeManifest(join(extensionVersionPath, 'manifest.json'), version)
  return extensionVersionPath
}

async function createUnpackedInstallation(
  browserPath: BrowserPath,
  profile: string,
  unpackedPath: string,
  version: string,
): Promise<void> {
  await mkdir(unpackedPath, { recursive: true })
  await writeManifest(join(unpackedPath, 'manifest.json'), version)
  await writeExtensionSettings(browserPath, profile, {
    path: unpackedPath,
  })
}

async function createBrokenUnpackedRegistration(
  browserPath: BrowserPath,
  profile: string,
  unpackedPath: string,
): Promise<void> {
  await writeExtensionSettings(browserPath, profile, {
    path: unpackedPath,
  })
}

async function writeExtensionSettings(
  browserPath: BrowserPath,
  profile: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const profilePath = join(browserPath.path, profile)
  await mkdir(profilePath, { recursive: true })
  await writeFile(
    join(profilePath, 'Secure Preferences'),
    JSON.stringify(
      {
        extensions: {
          settings: {
            [EXTENSION_ID]: settings,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function writeManifest(path: string, version: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'Claw in Chrome',
        version,
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function removePath(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(path, { recursive: true, force: true })
}

async function launchAndCaptureProfile(
  browserPath: BrowserPath,
  options: {
    bindingStatePathOverride?: string
    configuredBindingOverride?: {
      browser?: 'chrome'
      profile?: string
    } | null
  } = {},
): Promise<{ file: string; args: string[] }> {
  let spawned:
    | {
        file: string
        args: string[]
      }
    | undefined
  let fallbackCalled = false

  const launched = await launchClawInChromeReconnect({
    browserPathsOverride: [browserPath],
    bindingStatePathOverride: options.bindingStatePathOverride,
    configuredBindingOverride: options.configuredBindingOverride,
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
  return spawned
}

function assertSpawnedWithProfile(
  spawned: { file: string; args: string[] },
  profile: string,
): void {
  assert.ok(
    spawned.args.some(arg => arg.includes(`--profile-directory=${profile}`)),
  )
}

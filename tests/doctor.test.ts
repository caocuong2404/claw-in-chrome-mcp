import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_EXTENSION_IDS,
  NATIVE_HOST_MANIFEST_NAME,
  type BrowserPath,
} from '../src/browser.js'
import { collectDoctorReport } from '../src/doctor.js'
import { buildNativeHostManifest } from '../src/nativeHostInstall.js'

test('doctor reports healthy overridden environment', async () => {
  const tempRoot = await import('node:fs/promises').then(fs =>
    fs.mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-doctor-')),
  )
  const browserPath: BrowserPath = {
    browser: 'chrome',
    path: join(tempRoot, 'Chrome', 'User Data'),
  }
  const extensionPath = join(
    browserPath.path,
    'Default',
    'Extensions',
    DEFAULT_EXTENSION_IDS[0]!,
    '1.0.0',
  )
  const extensionManifestPath = join(extensionPath, 'manifest.json')
  const wrapperPath = join(tempRoot, 'bin', process.platform === 'win32' ? 'chrome-native-host.bat' : 'chrome-native-host')
  const manifestPath = join(tempRoot, 'manifest', NATIVE_HOST_MANIFEST_NAME)
  const socketPath = join(tempRoot, 'socket')

  await mkdir(extensionPath, { recursive: true })
  await mkdir(join(tempRoot, 'bin'), { recursive: true })
  await mkdir(join(tempRoot, 'manifest'), { recursive: true })
  await writeExtensionManifest(extensionManifestPath, '1.0.0')
  await writeFile(wrapperPath, 'echo host', 'utf8')
  await writeFile(manifestPath, buildNativeHostManifest(wrapperPath), 'utf8')

  const report = await collectDoctorReport({
    browserPathsOverride: [browserPath],
    wrapperPathOverride: wrapperPath,
    manifestPathsOverride: [manifestPath],
    socketPathsOverride: [socketPath],
    socketPath,
    socketTester: async path => path === socketPath,
    registryKeysOverride: [],
  })

  assert.equal(report.extension.installed, true)
  assert.equal(report.nativeHost.wrapperExists, true)
  assert.equal(report.nativeHost.manifestPaths[0]?.exists, true)
  assert.deepEqual(report.socket.connectablePaths, [socketPath])
  assert.deepEqual(report.suggestions, [])
})

test('doctor only checks the extension browser on windows by default', async () => {
  if (process.platform !== 'win32') {
    return
  }

  const tempRoot = await import('node:fs/promises').then(fs =>
    fs.mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-doctor-')),
  )
  const chromePath: BrowserPath = {
    browser: 'chrome',
    path: join(tempRoot, 'Chrome', 'User Data'),
  }
  const edgePath: BrowserPath = {
    browser: 'edge',
    path: join(tempRoot, 'Edge', 'User Data'),
  }
  const extensionPath = join(
    chromePath.path,
    'Default',
    'Extensions',
    DEFAULT_EXTENSION_IDS[0]!,
    '1.0.0',
  )
  const extensionManifestPath = join(extensionPath, 'manifest.json')
  const wrapperPath = join(
    tempRoot,
    'bin',
    'chrome-native-host.bat',
  )
  const manifestPath = join(tempRoot, 'manifest', NATIVE_HOST_MANIFEST_NAME)

  await mkdir(extensionPath, { recursive: true })
  await mkdir(edgePath.path, { recursive: true })
  await mkdir(join(tempRoot, 'bin'), { recursive: true })
  await mkdir(join(tempRoot, 'manifest'), { recursive: true })
  await writeExtensionManifest(extensionManifestPath, '1.0.0')
  await writeFile(wrapperPath, 'echo host', 'utf8')
  await writeFile(manifestPath, buildNativeHostManifest(wrapperPath), 'utf8')

  const report = await collectDoctorReport({
    browserPathsOverride: [chromePath, edgePath],
    wrapperPathOverride: wrapperPath,
    manifestPathsOverride: [manifestPath],
    socketPathsOverride: [],
    registryChecker: async fullKey => fullKey.includes('Google\\Chrome'),
  })

  assert.equal(report.extension.browser, 'chrome')
  assert.deepEqual(report.nativeHost.registryEntries, [
    {
      key:
        'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.anthropic.claude_code_browser_extension',
      exists: true,
    },
  ])
})

async function writeExtensionManifest(path: string, version: string): Promise<void> {
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

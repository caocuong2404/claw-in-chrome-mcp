import { stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'

import {
  CHROME_EXTENSION_URL,
  NATIVE_HOST_IDENTIFIER,
  NATIVE_HOST_MANIFEST_NAME,
  type BrowserPath,
  type ChromiumBrowser,
  type SocketOptions,
  detectAvailableBrowser,
  detectExtensionInstallation,
  getAllBrowserDataPaths,
  getAllNativeMessagingHostsDirs,
  getAllSocketPaths,
  getAllWindowsRegistryKeys,
  getSocketDiscoveryPattern,
} from './browser.js'
import {
  getDefaultWrapperDir,
  getNativeHostManifestRoot,
} from './nativeHostInstall.js'
import { execFileNoThrow, getPlatform, isFsInaccessible, jsonStringify } from './shared.js'

export type DoctorOptions = SocketOptions & {
  browsers?: ChromiumBrowser[]
  browserPathsOverride?: BrowserPath[]
  manifestPathsOverride?: string[]
  registryKeysOverride?: Array<{ browser: ChromiumBrowser; key: string }>
  wrapperPathOverride?: string
  socketPathsOverride?: string[]
  socketTester?: (path: string) => Promise<boolean>
  registryChecker?: (fullKey: string) => Promise<boolean>
}

export type DoctorReport = {
  platform: string
  preferredBrowser: ChromiumBrowser | null
  installedBrowsers: BrowserPath[]
  extension: {
    installed: boolean
    browser: ChromiumBrowser | null
    checkedPaths: BrowserPath[]
  }
  nativeHost: {
    wrapperPath: string
    wrapperExists: boolean
    manifestPaths: Array<{ path: string; exists: boolean }>
    registryEntries: Array<{ key: string; exists: boolean }>
  }
  socket: {
    expectedPath: string
    discoveredPaths: string[]
    connectablePaths: string[]
  }
  suggestions: string[]
}

export async function collectDoctorReport(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const browserPaths =
    options.browserPathsOverride ?? getAllBrowserDataPaths(options.browsers)
  const installedBrowsers = (
    await Promise.all(
      browserPaths.map(async browserPath => ({
        browserPath,
        exists: await pathExists(browserPath.path),
      })),
    )
  )
    .filter(item => item.exists)
    .map(item => item.browserPath)

  const extension = await detectExtensionInstallation(browserPaths)
  const preferredBrowser = await detectAvailableBrowser()
  const targetedBrowsers =
    options.browsers && options.browsers.length > 0
      ? options.browsers
      : extension.browser
        ? [extension.browser]
        : installedBrowsers.map(item => item.browser)

  const wrapperPath =
    options.wrapperPathOverride ??
    join(
      getDefaultWrapperDir(),
      getPlatform() === 'windows' ? 'chrome-native-host.bat' : 'chrome-native-host',
    )

  const manifestPaths = options.manifestPathsOverride
    ? options.manifestPathsOverride
    : getPlatform() === 'windows'
      ? [join(getNativeHostManifestRoot(), NATIVE_HOST_MANIFEST_NAME)]
      : getAllNativeMessagingHostsDirs(
          targetedBrowsers.length > 0 ? targetedBrowsers : undefined,
        ).map(item =>
          join(item.path, NATIVE_HOST_MANIFEST_NAME),
        )

  const manifestStatuses = await Promise.all(
    manifestPaths.map(async path => ({
      path,
      exists: await pathExists(path),
    })),
  )

  const registryKeys =
    getPlatform() === 'windows'
      ? options.registryKeysOverride ??
        getAllWindowsRegistryKeys(
          targetedBrowsers.length > 0 ? targetedBrowsers : undefined,
        )
      : []

  const registryChecker =
    options.registryChecker ?? (async (fullKey: string) => queryWindowsRegistry(fullKey))
  const registryEntries = await Promise.all(
    registryKeys.map(async item => ({
      key: `${item.key}\\${NATIVE_HOST_IDENTIFIER}`,
      exists: await registryChecker(`${item.key}\\${NATIVE_HOST_IDENTIFIER}`),
    })),
  )

  const socketPaths =
    options.socketPathsOverride ?? getAllSocketPaths(options)
  const socketTester = options.socketTester ?? testSocketConnectivity
  const connectablePaths: string[] = []
  for (const socketPath of socketPaths) {
    if (await socketTester(socketPath)) {
      connectablePaths.push(socketPath)
    }
  }

  const suggestions = buildSuggestions({
    installedBrowsers,
    extensionInstalled: extension.isInstalled,
    wrapperExists: await pathExists(wrapperPath),
    manifestStatuses,
    registryEntries,
    connectablePaths,
  })

  return {
    platform: getPlatform(),
    preferredBrowser,
    installedBrowsers,
    extension: {
      installed: extension.isInstalled,
      browser: extension.browser,
      checkedPaths: browserPaths,
    },
    nativeHost: {
      wrapperPath,
      wrapperExists: await pathExists(wrapperPath),
      manifestPaths: manifestStatuses,
      registryEntries,
    },
    socket: {
      expectedPath: getSocketDiscoveryPattern(options),
      discoveredPaths: socketPaths,
      connectablePaths,
    },
    suggestions,
  }
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  lines.push(`Platform: ${report.platform}`)
  lines.push(`Preferred browser: ${report.preferredBrowser ?? 'none'}`)
  lines.push(
    `Installed browsers: ${report.installedBrowsers.length > 0 ? report.installedBrowsers.map(item => item.browser).join(', ') : 'none'}`,
  )
  lines.push(
    `Extension installed: ${report.extension.installed ? `yes (${report.extension.browser ?? 'unknown browser'})` : 'no'}`,
  )
  lines.push(`Native host wrapper: ${report.nativeHost.wrapperExists ? 'present' : 'missing'} -> ${report.nativeHost.wrapperPath}`)
  lines.push(
    `Manifest files: ${
      report.nativeHost.manifestPaths.length > 0
        ? report.nativeHost.manifestPaths
            .map(item => `${item.exists ? 'present' : 'missing'}:${item.path}`)
            .join(' | ')
        : 'none'
    }`,
  )
  if (report.nativeHost.registryEntries.length > 0) {
    lines.push(
      `Registry entries: ${report.nativeHost.registryEntries
        .map(item => `${item.exists ? 'present' : 'missing'}:${item.key}`)
        .join(' | ')}`,
    )
  }
  lines.push(
    `Connectable sockets: ${
      report.socket.connectablePaths.length > 0
        ? report.socket.connectablePaths.join(', ')
        : 'none'
    }`,
  )

  if (report.suggestions.length > 0) {
    lines.push('')
    lines.push('Next steps:')
    for (const suggestion of report.suggestions) {
      lines.push(`- ${suggestion}`)
    }
  }

  return lines.join('\n')
}

export function reportToJson(report: DoctorReport): string {
  return jsonStringify(report, 2)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isFsInaccessible(error)) {
      return false
    }
    throw error
  }
}

async function testSocketConnectivity(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 750)

    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })

    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function queryWindowsRegistry(fullKey: string): Promise<boolean> {
  if (getPlatform() !== 'windows') {
    return false
  }

  const result = await execFileNoThrow('reg', ['query', fullKey, '/ve'])
  return result.code === 0
}

function buildSuggestions(input: {
  installedBrowsers: BrowserPath[]
  extensionInstalled: boolean
  wrapperExists: boolean
  manifestStatuses: Array<{ path: string; exists: boolean }>
  registryEntries: Array<{ key: string; exists: boolean }>
  connectablePaths: string[]
}): string[] {
  const suggestions: string[] = []

  if (input.installedBrowsers.length === 0) {
    suggestions.push('安装受支持的 Chromium 浏览器，例如 Chrome、Edge 或 Brave。')
  }
  if (!input.extensionInstalled) {
    suggestions.push(`安装 Claw in Chrome 扩展：${CHROME_EXTENSION_URL}`)
  }
  if (!input.wrapperExists || input.manifestStatuses.some(item => !item.exists)) {
    suggestions.push('重新运行 `claw-in-chrome-mcp install-native-host` 以修复 native host 安装。')
  }
  if (input.registryEntries.some(item => !item.exists)) {
    suggestions.push('Windows 注册表缺失 native host 项，重新运行安装命令后重启浏览器。')
  }
  if (input.connectablePaths.length === 0) {
    suggestions.push('重启浏览器并确认扩展已启用，然后重新连接 AI IDE。')
  }

  return suggestions
}

import { spawn } from 'node:child_process'
import { readdirSync, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir, platform, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { execFileNoThrow, getPlatform, isFsInaccessible, which } from './shared.js'

export const CHROME_EXTENSION_URL = 'https://github.com/S-Trespassing/claw-in-chrome'
export const CHROME_EXTENSION_RECONNECT_URL = 'https://clau.de/chrome/reconnect'
export const DEFAULT_EXTENSION_IDS = ['fcoeoabgfenejglbffodgkkbkcdhcgfn']
// 与扩展侧保持兼容的 native host 标识。若修改这里，也必须同步修改扩展端配置。
export const NATIVE_HOST_IDENTIFIER = 'com.anthropic.claude_code_browser_extension'
export const NATIVE_HOST_MANIFEST_NAME = `${NATIVE_HOST_IDENTIFIER}.json`

export type ChromiumBrowser =
  | 'chrome'
  | 'brave'
  | 'arc'
  | 'chromium'
  | 'edge'
  | 'vivaldi'
  | 'opera'

export type BrowserPath = {
  browser: ChromiumBrowser
  path: string
}

export type ExtensionInstallation = {
  browser: ChromiumBrowser
  browserPath: string
  extensionId: string
  extensionPath: string
  profile: string
}

export type SocketOptions = {
  socketPath?: string
  socketDir?: string
}

type BrowserConfig = {
  name: string
  macos: { appName: string; dataPath: string[]; nativeMessagingPath: string[] }
  linux: { binaries: string[]; dataPath: string[]; nativeMessagingPath: string[] }
  windows: { dataPath: string[]; registryKey: string; useRoaming?: boolean }
}

const SOCKET_PREFIX = 'claw-in-chrome-mcp-browser-bridge'

export const BROWSER_DETECTION_ORDER: ChromiumBrowser[] = [
  'chrome',
  'brave',
  'arc',
  'edge',
  'chromium',
  'vivaldi',
  'opera',
]

export const CHROMIUM_BROWSERS: Record<ChromiumBrowser, BrowserConfig> = {
  chrome: {
    name: 'Google Chrome',
    macos: {
      appName: 'Google Chrome',
      dataPath: ['Library', 'Application Support', 'Google', 'Chrome'],
      nativeMessagingPath: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'],
    },
    linux: {
      binaries: ['google-chrome', 'google-chrome-stable'],
      dataPath: ['.config', 'google-chrome'],
      nativeMessagingPath: ['.config', 'google-chrome', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Google', 'Chrome', 'User Data'],
      registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    },
  },
  brave: {
    name: 'Brave',
    macos: {
      appName: 'Brave Browser',
      dataPath: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
      nativeMessagingPath: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'],
    },
    linux: {
      binaries: ['brave-browser', 'brave'],
      dataPath: ['.config', 'BraveSoftware', 'Brave-Browser'],
      nativeMessagingPath: ['.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['BraveSoftware', 'Brave-Browser', 'User Data'],
      registryKey: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    },
  },
  arc: {
    name: 'Arc',
    macos: {
      appName: 'Arc',
      dataPath: ['Library', 'Application Support', 'Arc', 'User Data'],
      nativeMessagingPath: ['Library', 'Application Support', 'Arc', 'User Data', 'NativeMessagingHosts'],
    },
    linux: {
      binaries: [],
      dataPath: [],
      nativeMessagingPath: [],
    },
    windows: {
      dataPath: ['Arc', 'User Data'],
      registryKey: 'HKCU\\Software\\ArcBrowser\\Arc\\NativeMessagingHosts',
    },
  },
  chromium: {
    name: 'Chromium',
    macos: {
      appName: 'Chromium',
      dataPath: ['Library', 'Application Support', 'Chromium'],
      nativeMessagingPath: ['Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'],
    },
    linux: {
      binaries: ['chromium', 'chromium-browser'],
      dataPath: ['.config', 'chromium'],
      nativeMessagingPath: ['.config', 'chromium', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Chromium', 'User Data'],
      registryKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
    },
  },
  edge: {
    name: 'Microsoft Edge',
    macos: {
      appName: 'Microsoft Edge',
      dataPath: ['Library', 'Application Support', 'Microsoft Edge'],
      nativeMessagingPath: ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'],
    },
    linux: {
      binaries: ['microsoft-edge', 'microsoft-edge-stable'],
      dataPath: ['.config', 'microsoft-edge'],
      nativeMessagingPath: ['.config', 'microsoft-edge', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Microsoft', 'Edge', 'User Data'],
      registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    },
  },
  vivaldi: {
    name: 'Vivaldi',
    macos: {
      appName: 'Vivaldi',
      dataPath: ['Library', 'Application Support', 'Vivaldi'],
      nativeMessagingPath: ['Library', 'Application Support', 'Vivaldi', 'NativeMessagingHosts'],
    },
    linux: {
      binaries: ['vivaldi', 'vivaldi-stable'],
      dataPath: ['.config', 'vivaldi'],
      nativeMessagingPath: ['.config', 'vivaldi', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Vivaldi', 'User Data'],
      registryKey: 'HKCU\\Software\\Vivaldi\\NativeMessagingHosts',
    },
  },
  opera: {
    name: 'Opera',
    macos: {
      appName: 'Opera',
      dataPath: ['Library', 'Application Support', 'com.operasoftware.Opera'],
      nativeMessagingPath: ['Library', 'Application Support', 'com.operasoftware.Opera', 'NativeMessagingHosts'],
    },
    linux: {
      binaries: ['opera'],
      dataPath: ['.config', 'opera'],
      nativeMessagingPath: ['.config', 'opera', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Opera Software', 'Opera Stable'],
      registryKey: 'HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts',
      useRoaming: true,
    },
  },
}

export function getExtensionIds(): string[] {
  const override = process.env.CLAW_IN_CHROME_EXTENSION_IDS
  if (!override) {
    return DEFAULT_EXTENSION_IDS
  }

  const ids = override
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)

  return ids.length > 0 ? ids : DEFAULT_EXTENSION_IDS
}

export function getAllBrowserDataPaths(browsers?: ChromiumBrowser[]): BrowserPath[] {
  const currentPlatform = getPlatform()
  const home = homedir()
  const paths: BrowserPath[] = []
  const filter = browsers ? new Set(browsers) : null

  for (const browserId of BROWSER_DETECTION_ORDER) {
    if (filter && !filter.has(browserId)) {
      continue
    }

    const config = CHROMIUM_BROWSERS[browserId]
    let dataPath: string[] | undefined

    switch (currentPlatform) {
      case 'macos':
        dataPath = config.macos.dataPath
        break
      case 'linux':
      case 'wsl':
        dataPath = config.linux.dataPath
        break
      case 'windows': {
        const appDataBase = config.windows.useRoaming
          ? join(home, 'AppData', 'Roaming')
          : join(home, 'AppData', 'Local')
        paths.push({
          browser: browserId,
          path: join(appDataBase, ...config.windows.dataPath),
        })
        continue
      }
    }

    if (dataPath && dataPath.length > 0) {
      paths.push({ browser: browserId, path: join(home, ...dataPath) })
    }
  }

  return paths
}

export function getAllNativeMessagingHostsDirs(
  browsers?: ChromiumBrowser[],
): Array<{ browser: ChromiumBrowser; path: string }> {
  const currentPlatform = getPlatform()
  const home = homedir()
  const paths: Array<{ browser: ChromiumBrowser; path: string }> = []
  const filter = browsers ? new Set(browsers) : null

  for (const browserId of BROWSER_DETECTION_ORDER) {
    if (filter && !filter.has(browserId)) {
      continue
    }

    const config = CHROMIUM_BROWSERS[browserId]
    switch (currentPlatform) {
      case 'macos':
        if (config.macos.nativeMessagingPath.length > 0) {
          paths.push({ browser: browserId, path: join(home, ...config.macos.nativeMessagingPath) })
        }
        break
      case 'linux':
      case 'wsl':
        if (config.linux.nativeMessagingPath.length > 0) {
          paths.push({ browser: browserId, path: join(home, ...config.linux.nativeMessagingPath) })
        }
        break
      case 'windows':
        break
    }
  }

  return paths
}

export function getAllWindowsRegistryKeys(
  browsers?: ChromiumBrowser[],
): Array<{ browser: ChromiumBrowser; key: string }> {
  const filter = browsers ? new Set(browsers) : null
  const keys: Array<{ browser: ChromiumBrowser; key: string }> = []
  for (const browserId of BROWSER_DETECTION_ORDER) {
    if (filter && !filter.has(browserId)) {
      continue
    }

    keys.push({ browser: browserId, key: CHROMIUM_BROWSERS[browserId].windows.registryKey })
  }
  return keys
}

export async function detectExtensionInstallation(
  browserPaths: BrowserPath[],
  log?: (message: string) => void,
): Promise<{ isInstalled: boolean; browser: ChromiumBrowser | null }> {
  const installations = await findExtensionInstallations(browserPaths, log)
  if (installations.length === 0) {
    return { isInstalled: false, browser: null }
  }

  return {
    isInstalled: true,
    browser: installations[0]?.browser ?? null,
  }
}

export async function findExtensionInstallations(
  browserPaths: BrowserPath[],
  log?: (message: string) => void,
): Promise<ExtensionInstallation[]> {
  if (browserPaths.length === 0) {
    log?.('[Claw in Chrome MCP] No browser paths to check')
    return []
  }

  const installations: ExtensionInstallation[] = []
  const extensionIds = getExtensionIds()
  for (const { browser, path: browserBasePath } of browserPaths) {
    let browserProfileEntries: Dirent[] = []
    try {
      browserProfileEntries = await readdir(browserBasePath, { withFileTypes: true })
    } catch (error) {
      if (isFsInaccessible(error)) {
        continue
      }
      throw error
    }

    const profileDirs = sortProfileDirectories(
      browserProfileEntries
      .filter(entry => entry.isDirectory())
      .filter(entry => entry.name === 'Default' || entry.name.startsWith('Profile '))
      .map(entry => entry.name)
    )

    for (const profile of profileDirs) {
      for (const extensionId of extensionIds) {
        const extensionPath = join(browserBasePath, profile, 'Extensions', extensionId)
        try {
          await readdir(extensionPath)
          log?.(`[Claw in Chrome MCP] Extension ${extensionId} found in ${browser} ${profile}`)
          installations.push({
            browser,
            browserPath: browserBasePath,
            extensionId,
            extensionPath,
            profile,
          })
        } catch {
          // 继续检查其他 profile。
        }
      }
    }
  }

  return installations
}

export async function detectAvailableBrowser(
  log?: (message: string) => void,
): Promise<ChromiumBrowser | null> {
  const currentPlatform = getPlatform()

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]
    switch (currentPlatform) {
      case 'macos': {
        const appPath = `/Applications/${config.macos.appName}.app`
        try {
          const stats = await stat(appPath)
          if (stats.isDirectory()) {
            log?.(`[Claw in Chrome MCP] Detected browser: ${config.name}`)
            return browserId
          }
        } catch (error) {
          if (!isFsInaccessible(error)) {
            throw error
          }
        }
        break
      }
      case 'linux':
      case 'wsl': {
        for (const binary of config.linux.binaries) {
          if (await which(binary)) {
            log?.(`[Claw in Chrome MCP] Detected browser: ${config.name}`)
            return browserId
          }
        }
        break
      }
      case 'windows': {
        const home = homedir()
        const appDataBase = config.windows.useRoaming
          ? join(home, 'AppData', 'Roaming')
          : join(home, 'AppData', 'Local')
        const dataPath = join(appDataBase, ...config.windows.dataPath)
        try {
          const stats = await stat(dataPath)
          if (stats.isDirectory()) {
            log?.(`[Claw in Chrome MCP] Detected browser: ${config.name}`)
            return browserId
          }
        } catch (error) {
          if (!isFsInaccessible(error)) {
            throw error
          }
        }
        break
      }
    }
  }

  return null
}

export async function openInChrome(url: string): Promise<boolean> {
  const browser = await detectAvailableBrowser()
  if (!browser) {
    return false
  }

  const config = CHROMIUM_BROWSERS[browser]
  switch (getPlatform()) {
    case 'macos': {
      const { code } = await execFileNoThrow('open', ['-a', config.macos.appName, url])
      return code === 0
    }
    case 'windows': {
      const { code } = await execFileNoThrow('rundll32', ['url.dll,FileProtocolHandler', url])
      return code === 0
    }
    case 'linux':
    case 'wsl': {
      for (const binary of config.linux.binaries) {
        const { code } = await execFileNoThrow(binary, [url])
        if (code === 0) {
          return true
        }
      }
      return false
    }
    default:
      return false
  }
}

export async function launchClawInChromeReconnect(options: {
  browserPathsOverride?: BrowserPath[]
  fallbackOpenUrl?: (url: string) => Promise<boolean>
  resolveExecutablePath?: (browser: ChromiumBrowser) => Promise<string | null>
  resolveWindowsExecutablePath?: (browser: ChromiumBrowser) => Promise<string | null>
  spawnDetachedImpl?: (file: string, args: string[]) => Promise<boolean>
  url?: string
} = {}): Promise<boolean> {
  const url = options.url ?? CHROME_EXTENSION_RECONNECT_URL
  const browserPaths = options.browserPathsOverride ?? getAllBrowserDataPaths()
  const installations = await findExtensionInstallations(browserPaths)
  const spawnDetachedImpl = options.spawnDetachedImpl ?? spawnDetachedCommand
  const fallbackOpenUrl = options.fallbackOpenUrl ?? openInChrome

  const target = installations[0]
  if (!target) {
    return fallbackOpenUrl(url)
  }

  const launchCommand = await buildLaunchCommand(target, url, {
    resolveExecutablePath: options.resolveExecutablePath,
    resolveWindowsExecutablePath: options.resolveWindowsExecutablePath,
  })
  if (!launchCommand) {
    return fallbackOpenUrl(url)
  }

  return spawnDetachedImpl(launchCommand.file, launchCommand.args)
}

export function getSocketDir(options: SocketOptions = {}): string {
  return options.socketDir ?? `/tmp/${SOCKET_PREFIX}-${getUsername()}`
}

export function getSocketName(options: SocketOptions = {}): string {
  if (options.socketPath && platform() === 'win32') {
    return options.socketPath.replace(/^\\\\\.\\pipe\\/, '')
  }
  return `${SOCKET_PREFIX}-${getUsername()}`
}

export function getSecureSocketPath(options: SocketOptions = {}): string {
  if (options.socketPath) {
    return options.socketPath
  }
  if (platform() === 'win32') {
    return `\\\\.\\pipe\\${getSocketName(options)}`
  }
  return join(getSocketDir(options), `${process.pid}.sock`)
}

export function getAllSocketPaths(options: SocketOptions = {}): string[] {
  if (options.socketPath) {
    return [options.socketPath]
  }

  if (platform() === 'win32') {
    return [`\\\\.\\pipe\\${getSocketName(options)}`]
  }

  const paths: string[] = []
  const socketDir = getSocketDir(options)
  try {
    const files = readdirSync(socketDir)
    for (const file of files) {
      if (file.endsWith('.sock')) {
        paths.push(join(socketDir, file))
      }
    }
  } catch {
    // 目录不存在时直接返回 fallback。
  }

  const legacyName = `claude-mcp-browser-bridge-${getUsername()}`
  const legacyTmpdir = join(tmpdir(), legacyName)
  const legacyTmp = `/tmp/${legacyName}`
  if (!paths.includes(legacyTmpdir)) {
    paths.push(legacyTmpdir)
  }
  if (legacyTmpdir !== legacyTmp && !paths.includes(legacyTmp)) {
    paths.push(legacyTmp)
  }
  return paths
}

function getUsername(): string {
  try {
    return userInfo().username || 'default'
  } catch {
    return process.env.USER || process.env.USERNAME || 'default'
  }
}

function sortProfileDirectories(profileDirs: string[]): string[] {
  return [...profileDirs].sort((left, right) => {
    if (left === right) {
      return 0
    }
    if (left === 'Default') {
      return -1
    }
    if (right === 'Default') {
      return 1
    }

    const leftMatch = /^Profile (\d+)$/.exec(left)
    const rightMatch = /^Profile (\d+)$/.exec(right)
    if (leftMatch && rightMatch) {
      return Number(leftMatch[1]) - Number(rightMatch[1])
    }

    return left.localeCompare(right)
  })
}

async function buildLaunchCommand(
  installation: ExtensionInstallation,
  url: string,
  options: {
    resolveExecutablePath?: (browser: ChromiumBrowser) => Promise<string | null>
    resolveWindowsExecutablePath?: (browser: ChromiumBrowser) => Promise<string | null>
  } = {},
): Promise<{ file: string; args: string[] } | null> {
  const profileArg = `--profile-directory=${installation.profile}`
  const args = [profileArg, '--new-window', url]

  switch (getPlatform()) {
    case 'macos':
      return {
        file: 'open',
        args: ['-a', CHROMIUM_BROWSERS[installation.browser].macos.appName, url, '--args', profileArg, '--new-window'],
      }
    case 'linux':
    case 'wsl': {
      const binary =
        (await options.resolveExecutablePath?.(installation.browser)) ??
        (await resolveLinuxBrowserBinary(installation.browser))
      if (!binary) {
        return null
      }
      return { file: binary, args }
    }
    case 'windows': {
      const executable =
        (await options.resolveExecutablePath?.(installation.browser)) ??
        (await options.resolveWindowsExecutablePath?.(installation.browser)) ??
        (await resolveWindowsBrowserExecutablePath(installation.browser))
      if (!executable) {
        return null
      }
      return { file: executable, args }
    }
    default:
      return null
  }
}

async function resolveLinuxBrowserBinary(
  browser: ChromiumBrowser,
): Promise<string | null> {
  for (const binary of CHROMIUM_BROWSERS[browser].linux.binaries) {
    const resolved = await which(binary)
    if (resolved) {
      return resolved
    }
  }
  return null
}

async function resolveWindowsBrowserExecutablePath(
  browser: ChromiumBrowser,
): Promise<string | null> {
  const candidates = getWindowsBrowserExecutableCandidates(browser)
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  const executableName = getWindowsBrowserExecutableName(browser)
  if (executableName) {
    const result = await execFileNoThrow('where', [executableName])
    if (result.code === 0) {
      const resolved = result.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean)
      if (resolved) {
        return resolved
      }
    }
  }

  return null
}

function getWindowsBrowserExecutableCandidates(
  browser: ChromiumBrowser,
): string[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 =
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')

  switch (browser) {
    case 'chrome':
      return [
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    case 'edge':
      return [
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    case 'brave':
      return [
        join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ]
    case 'chromium':
      return [
        join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
        join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
      ]
    case 'vivaldi':
      return [
        join(localAppData, 'Vivaldi', 'Application', 'vivaldi.exe'),
        join(programFiles, 'Vivaldi', 'Application', 'vivaldi.exe'),
        join(programFilesX86, 'Vivaldi', 'Application', 'vivaldi.exe'),
      ]
    case 'opera':
      return [
        join(localAppData, 'Programs', 'Opera', 'opera.exe'),
        join(localAppData, 'Programs', 'Opera GX', 'opera.exe'),
        join(programFiles, 'Opera', 'launcher.exe'),
        join(programFilesX86, 'Opera', 'launcher.exe'),
      ]
    case 'arc':
      return [join(localAppData, 'Programs', 'Arc', 'Arc.exe')]
  }
}

function getWindowsBrowserExecutableName(browser: ChromiumBrowser): string | null {
  switch (browser) {
    case 'chrome':
      return 'chrome.exe'
    case 'edge':
      return 'msedge.exe'
    case 'brave':
      return 'brave.exe'
    case 'chromium':
      return 'chromium.exe'
    case 'vivaldi':
      return 'vivaldi.exe'
    case 'opera':
      return 'opera.exe'
    case 'arc':
      return 'arc.exe'
    default:
      return null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile() || stats.isDirectory()
  } catch (error) {
    if (isFsInaccessible(error)) {
      return false
    }
    throw error
  }
}

function spawnDetachedCommand(file: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(file, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })

    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

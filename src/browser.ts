import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

import { execFileNoThrow, getPlatform, isFsInaccessible, which } from './shared.js'

export const CHROME_EXTENSION_URL = 'https://github.com/S-Trespassing/claw-in-chrome'
export const CHROME_EXTENSION_RECONNECT_URL = 'https://clau.de/chrome/reconnect'
export const DEFAULT_EXTENSION_IDS = ['fcoeoabgfenejglbffodgkkbkcdhcgfn']
export const BROWSER_BINDING_HELLO_TYPE = 'binding_hello'
export const BROWSER_BINDING_NOTIFICATION_METHOD = 'claw.binding'
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
  installType: 'unpacked' | 'packaged'
  sourcePath?: string
  extensionVersion?: string
}

export type SocketOptions = {
  socketPath?: string
  socketDir?: string
  socketRegistryDir?: string
}

export type RuntimeBrowserBinding = {
  protocolVersion?: number
  browser?: string
  extensionId?: string
  extensionVersion?: string
  hostName?: string
  instanceId?: string
}

export type RuntimeSocketRegistration = {
  version: 1
  pid: number
  socketPath: string
  runtimeBinding?: RuntimeBrowserBinding
  updatedAt: string
}

type BrowserConfig = {
  name: string
  macos: { appName: string; dataPath: string[]; nativeMessagingPath: string[] }
  linux: { binaries: string[]; dataPath: string[]; nativeMessagingPath: string[] }
  windows: { dataPath: string[]; registryKey: string; useRoaming?: boolean }
}

type ReconnectBindingOverride = {
  browser?: ChromiumBrowser
  profile?: string
} | null

type PersistedBrowserBindingState = {
  version: 1
  lastRuntimeBinding?: PersistedExtensionInstallation
}

type PersistedExtensionInstallation = {
  browser: ChromiumBrowser
  browserPath: string
  extensionId: string
  extensionPath: string
  profile: string
  installType: 'unpacked' | 'packaged'
  sourcePath?: string
  extensionVersion?: string
  updatedAt: string
  runtime?: RuntimeBrowserBinding
}

const SOCKET_PREFIX = 'claw-in-chrome-mcp-browser-bridge'
const SOCKET_REGISTRATION_VERSION = 1

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
      const profilePath = join(browserBasePath, profile)
      for (const extensionId of extensionIds) {
        const extensionSettings = await readProfileExtensionSettings(
          profilePath,
          extensionId,
        )

        const unpackedInstallation =
          await resolveUnpackedExtensionInstallation({
            browser,
            browserBasePath,
            extensionId,
            profile,
            extensionSettings,
          })
        if (unpackedInstallation) {
          log?.(
            `[Claw in Chrome MCP] Extension ${extensionId} found in ${browser} ${profile} (unpacked)`,
          )
          installations.push(unpackedInstallation)
          continue
        }

        const packagedInstallation =
          await resolvePackagedExtensionInstallation({
            browser,
            browserBasePath,
            extensionId,
            profile,
          })
        if (packagedInstallation) {
          log?.(
            `[Claw in Chrome MCP] Extension ${extensionId} found in ${browser} ${profile} (packaged)`,
          )
          installations.push(packagedInstallation)
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
  bindingStatePathOverride?: string
  configuredBindingOverride?: ReconnectBindingOverride
  fallbackOpenUrl?: (url: string) => Promise<boolean>
  resolveExecutablePath?: (browser: ChromiumBrowser) => Promise<string | null>
  resolveWindowsExecutablePath?: (browser: ChromiumBrowser) => Promise<string | null>
  spawnDetachedImpl?: (file: string, args: string[]) => Promise<boolean>
  url?: string
} = {}): Promise<boolean> {
  const url = options.url ?? CHROME_EXTENSION_RECONNECT_URL
  const browserPaths = options.browserPathsOverride ?? getAllBrowserDataPaths()
  const target = await resolveReconnectInstallation(browserPaths, {
    bindingStatePathOverride: options.bindingStatePathOverride,
    configuredBindingOverride: options.configuredBindingOverride,
  })
  const spawnDetachedImpl = options.spawnDetachedImpl ?? spawnDetachedCommand
  const fallbackOpenUrl = options.fallbackOpenUrl ?? openInChrome

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

export async function rememberRuntimeBrowserBinding(
  runtimeBinding: RuntimeBrowserBinding,
  options: {
    browserPathsOverride?: BrowserPath[]
    bindingStatePathOverride?: string
    configuredBindingOverride?: ReconnectBindingOverride
    log?: (message: string) => void
  } = {},
): Promise<ExtensionInstallation | null> {
  const extensionId =
    normalizeNonEmptyString(runtimeBinding.extensionId) ?? DEFAULT_EXTENSION_IDS[0]
  if (!extensionId) {
    return null
  }

  const preferredBrowser = normalizeBrowserId(runtimeBinding.browser)
  const browserPaths =
    options.browserPathsOverride ??
    getAllBrowserDataPaths(preferredBrowser ? [preferredBrowser] : undefined)
  const installations = await findExtensionInstallations(browserPaths, options.log)
  const candidates = installations.filter(
    installation => installation.extensionId === extensionId,
  )
  if (candidates.length === 0) {
    return null
  }

  const configuredTarget = resolveConfiguredReconnectTarget(
    options.configuredBindingOverride,
  )
  const configuredCandidates = configuredTarget
    ? candidates.filter(installation =>
        matchesConfiguredReconnectTarget(installation, configuredTarget),
      )
    : candidates
  if (configuredTarget && configuredCandidates.length === 0) {
    return null
  }

  const existingBindingState = await readPersistedBrowserBindingState(
    options.bindingStatePathOverride,
  )
  const persistedInstallation = existingBindingState?.lastRuntimeBinding
  const runtimeInstanceId = normalizeNonEmptyString(runtimeBinding.instanceId)
  if (
    runtimeInstanceId &&
    runtimeInstanceId ===
      normalizeNonEmptyString(persistedInstallation?.runtime?.instanceId)
  ) {
    const persistedMatch = configuredCandidates.find(installation =>
      persistedInstallation
        ? matchesPersistedExtensionInstallation(installation, persistedInstallation)
        : false,
    )
    if (persistedMatch) {
      await writePersistedBrowserBindingState(
        {
          version: 1,
          lastRuntimeBinding: serializePersistedExtensionInstallation(
            persistedMatch,
            runtimeBinding,
          ),
        },
        options.bindingStatePathOverride,
      )

      return persistedMatch
    }
  }

  const preferredVersion = normalizeNonEmptyString(runtimeBinding.extensionVersion)
  let selectedCandidates: ExtensionInstallation[] = []
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of configuredCandidates) {
    let score = 0
    if (preferredBrowser && candidate.browser === preferredBrowser) {
      score += 100
    }
    if (preferredVersion && candidate.extensionVersion === preferredVersion) {
      score += 50
    }
    if (candidate.installType === 'unpacked') {
      score += 20
    }
    if (score > bestScore) {
      bestScore = score
      selectedCandidates = [candidate]
      continue
    }
    if (score === bestScore) {
      selectedCandidates.push(candidate)
    }
  }

  const selected =
    selectedCandidates.length === 1 ? selectedCandidates[0] ?? null : null
  if (!selected) {
    return null
  }

  await writePersistedBrowserBindingState(
    {
      version: 1,
      lastRuntimeBinding: serializePersistedExtensionInstallation(
        selected,
        runtimeBinding,
      ),
    },
    options.bindingStatePathOverride,
  )

  return selected
}

export function getSocketDir(options: SocketOptions = {}): string {
  return options.socketDir ?? `/tmp/${SOCKET_PREFIX}-${getUsername()}`
}

export function getSocketRegistryDir(options: SocketOptions = {}): string {
  if (options.socketRegistryDir) {
    return options.socketRegistryDir
  }

  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'claw-in-chrome-mcp', 'runtime-sockets')
}

export function getSocketName(options: SocketOptions = {}): string {
  if (options.socketPath && platform() === 'win32') {
    return options.socketPath.replace(/^\\\\\.\\pipe\\/, '')
  }
  if (platform() === 'win32') {
    return `${SOCKET_PREFIX}-${getUsername()}-${process.pid}`
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

export function getSocketDiscoveryPattern(options: SocketOptions = {}): string {
  if (options.socketPath) {
    return options.socketPath
  }

  if (platform() === 'win32') {
    return `\\\\.\\pipe\\${SOCKET_PREFIX}-${getUsername()}-*`
  }

  return join(getSocketDir(options), '*.sock')
}

export function getAllSocketPaths(options: SocketOptions = {}): string[] {
  if (options.socketPath) {
    return [options.socketPath]
  }

  if (platform() === 'win32') {
    const runtimePaths = readRuntimeSocketRegistrations(options).map(
      registration => registration.socketPath,
    )
    const legacyPath = `\\\\.\\pipe\\${SOCKET_PREFIX}-${getUsername()}`
    if (!runtimePaths.includes(legacyPath)) {
      runtimePaths.push(legacyPath)
    }
    return runtimePaths
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

export async function writeRuntimeSocketRegistration(
  socketPath: string,
  options: SocketOptions & {
    pid?: number
    runtimeBinding?: RuntimeBrowserBinding | null
  } = {},
): Promise<void> {
  if (platform() !== 'win32') {
    return
  }

  const pid = options.pid ?? process.pid
  const registryDir = getSocketRegistryDir(options)
  const registration: RuntimeSocketRegistration = {
    version: SOCKET_REGISTRATION_VERSION,
    pid,
    socketPath,
    updatedAt: new Date().toISOString(),
  }
  const runtimeBinding = options.runtimeBinding ?? undefined
  if (runtimeBinding) {
    registration.runtimeBinding = runtimeBinding
  }

  await mkdir(registryDir, { recursive: true })
  await writeFile(
    join(registryDir, `${pid}.json`),
    JSON.stringify(registration, null, 2),
    'utf8',
  )
}

export async function removeRuntimeSocketRegistration(
  options: SocketOptions & { pid?: number } = {},
): Promise<void> {
  if (platform() !== 'win32') {
    return
  }

  const pid = options.pid ?? process.pid
  const registryDir = getSocketRegistryDir(options)
  await rm(join(registryDir, `${pid}.json`), { force: true })
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

function readRuntimeSocketRegistrations(
  options: SocketOptions = {},
): RuntimeSocketRegistration[] {
  if (platform() !== 'win32') {
    return []
  }

  const registryDir = getSocketRegistryDir(options)
  let entries: string[] = []
  try {
    entries = readdirSync(registryDir)
  } catch {
    return []
  }

  const registrations: RuntimeSocketRegistration[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }

    try {
      const raw = JSON.parse(
        readFileSync(join(registryDir, entry), 'utf8'),
      ) as Partial<RuntimeSocketRegistration>
      const registration = normalizeRuntimeSocketRegistration(raw)
      if (!registration) {
        continue
      }
      if (!isProcessAlive(registration.pid)) {
        continue
      }
      registrations.push(registration)
    } catch {
      // 忽略损坏/半写入的注册文件，避免 discovery 被单个坏文件拖死。
    }
  }

  registrations.sort((left, right) => left.pid - right.pid)
  return registrations
}

function normalizeRuntimeSocketRegistration(
  value: Partial<RuntimeSocketRegistration> | null | undefined,
): RuntimeSocketRegistration | null {
  if (!value || value.version !== SOCKET_REGISTRATION_VERSION) {
    return null
  }

  if (
    typeof value.pid !== 'number' ||
    !Number.isFinite(value.pid) ||
    value.pid <= 0
  ) {
    return null
  }

  if (typeof value.socketPath !== 'string' || value.socketPath.trim().length === 0) {
    return null
  }

  return {
    version: SOCKET_REGISTRATION_VERSION,
    pid: value.pid,
    socketPath: value.socketPath,
    runtimeBinding: value.runtimeBinding,
    updatedAt:
      typeof value.updatedAt === 'string' && value.updatedAt.trim().length > 0
        ? value.updatedAt
        : new Date(0).toISOString(),
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function resolveReconnectInstallation(
  browserPaths: BrowserPath[],
  options: {
    bindingStatePathOverride?: string
    configuredBindingOverride?: ReconnectBindingOverride
  } = {},
): Promise<ExtensionInstallation | null> {
  const installations = await findExtensionInstallations(browserPaths)
  if (installations.length === 0) {
    return null
  }

  const persistedBindingState = await readPersistedBrowserBindingState(
    options.bindingStatePathOverride,
  )
  const persistedInstallation = persistedBindingState?.lastRuntimeBinding

  const configuredTarget = resolveConfiguredReconnectTarget(
    options.configuredBindingOverride,
  )
  if (configuredTarget) {
    const matchedInstallation = findInstallationByConfiguredTarget(
      installations,
      configuredTarget,
    )
    if (matchedInstallation) {
      return matchedInstallation
    }
    return null
  }

  if (persistedInstallation) {
    const cachedInstallation = installations.find(installation =>
      matchesPersistedExtensionInstallation(installation, persistedInstallation),
    )
    if (cachedInstallation) {
      return cachedInstallation
    }
  }

  return installations[0] ?? null
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

type ResolveUnpackedExtensionInstallationInput = {
  browser: ChromiumBrowser
  browserBasePath: string
  extensionId: string
  profile: string
  extensionSettings: Record<string, unknown> | null
}

type ResolvePackagedExtensionInstallationInput = {
  browser: ChromiumBrowser
  browserBasePath: string
  extensionId: string
  profile: string
}

async function resolveUnpackedExtensionInstallation(
  input: ResolveUnpackedExtensionInstallationInput,
): Promise<ExtensionInstallation | null> {
  const unpackedPath = normalizeNonEmptyString(input.extensionSettings?.path)
  if (!unpackedPath) {
    return null
  }

  const manifestPath = join(unpackedPath, 'manifest.json')
  if (!(await pathExists(manifestPath))) {
    return null
  }

  const manifest =
    await readJsonFile<{ version?: string }>(manifestPath)

  return {
    browser: input.browser,
    browserPath: input.browserBasePath,
    extensionId: input.extensionId,
    extensionPath: unpackedPath,
    profile: input.profile,
    installType: 'unpacked',
    sourcePath: unpackedPath,
    extensionVersion: normalizeNonEmptyString(manifest?.version) ?? undefined,
  }
}

async function resolvePackagedExtensionInstallation(
  input: ResolvePackagedExtensionInstallationInput,
): Promise<ExtensionInstallation | null> {
  const extensionRoot = join(
    input.browserBasePath,
    input.profile,
    'Extensions',
    input.extensionId,
  )
  let versionEntries: Dirent[] = []
  try {
    versionEntries = await readdir(extensionRoot, { withFileTypes: true })
  } catch {
    return null
  }

  const validVersionDirs: Array<{ path: string; version: string }> = []
  for (const entry of versionEntries) {
    if (!entry.isDirectory()) {
      continue
    }
    const versionPath = join(extensionRoot, entry.name)
    const manifestPath = join(versionPath, 'manifest.json')
    if (!(await pathExists(manifestPath))) {
      continue
    }

    const manifest =
      await readJsonFile<{ version?: string }>(manifestPath)
    validVersionDirs.push({
      path: versionPath,
      version: normalizeNonEmptyString(manifest?.version) ?? entry.name,
    })
  }

  if (validVersionDirs.length === 0) {
    return null
  }

  validVersionDirs.sort((left, right) =>
    right.version.localeCompare(left.version, undefined, { numeric: true }),
  )

  const selectedVersionDir = validVersionDirs[0]!
  return {
    browser: input.browser,
    browserPath: input.browserBasePath,
    extensionId: input.extensionId,
    extensionPath: selectedVersionDir.path,
    profile: input.profile,
    installType: 'packaged',
    sourcePath: selectedVersionDir.path,
    extensionVersion: selectedVersionDir.version,
  }
}

async function readProfileExtensionSettings(
  profilePath: string,
  extensionId: string,
): Promise<Record<string, unknown> | null> {
  for (const fileName of ['Secure Preferences', 'Preferences']) {
    const data = await readJsonFile<Record<string, unknown>>(
      join(profilePath, fileName),
    )
    const settings = data?.extensions
    if (!settings || typeof settings !== 'object') {
      continue
    }
    const extensionSettings =
      (settings as { settings?: Record<string, unknown> }).settings?.[extensionId]
    if (extensionSettings && typeof extensionSettings === 'object') {
      return extensionSettings as Record<string, unknown>
    }
  }
  return null
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf8')
    return JSON.parse(content) as T
  } catch (error) {
    if (isFsInaccessible(error)) {
      return null
    }
    return null
  }
}

function resolveConfiguredReconnectTarget(
  override?: ReconnectBindingOverride,
): ReconnectBindingOverride {
  if (override !== undefined) {
    return override
  }

  const browser = normalizeBrowserId(process.env.CIC_MCP_BIND_BROWSER)
  const profile = normalizeNonEmptyString(process.env.CIC_MCP_BIND_PROFILE)
  if (!browser && !profile) {
    return null
  }

  return {
    browser: browser ?? undefined,
    profile: profile ?? undefined,
  }
}

function getBrowserBindingStatePath(bindingStatePathOverride?: string): string {
  if (bindingStatePathOverride) {
    return bindingStatePathOverride
  }

  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'claw-in-chrome-mcp', 'browser-binding.json')
}

async function readPersistedBrowserBindingState(
  bindingStatePathOverride?: string,
): Promise<PersistedBrowserBindingState | null> {
  const statePath = getBrowserBindingStatePath(bindingStatePathOverride)
  const state = await readJsonFile<PersistedBrowserBindingState>(statePath)
  if (!state || state.version !== 1) {
    return null
  }
  return state
}

async function writePersistedBrowserBindingState(
  state: PersistedBrowserBindingState,
  bindingStatePathOverride?: string,
): Promise<void> {
  const statePath = getBrowserBindingStatePath(bindingStatePathOverride)
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
}

function serializePersistedExtensionInstallation(
  installation: ExtensionInstallation,
  runtime?: RuntimeBrowserBinding,
): PersistedExtensionInstallation {
  return {
    browser: installation.browser,
    browserPath: installation.browserPath,
    extensionId: installation.extensionId,
    extensionPath: installation.extensionPath,
    profile: installation.profile,
    installType: installation.installType,
    sourcePath: installation.sourcePath,
    extensionVersion: installation.extensionVersion,
    updatedAt: new Date().toISOString(),
    runtime,
  }
}

function matchesPersistedExtensionInstallation(
  installation: ExtensionInstallation,
  persisted: PersistedExtensionInstallation,
): boolean {
  if (installation.browser !== persisted.browser) {
    return false
  }
  if (installation.profile !== persisted.profile) {
    return false
  }
  if (installation.extensionId !== persisted.extensionId) {
    return false
  }
  if (installation.installType !== persisted.installType) {
    return false
  }
  if (installation.installType === 'packaged') {
    return true
  }
  if (persisted.sourcePath) {
    return pathsEqual(installation.sourcePath, persisted.sourcePath)
  }
  return true
}

function findInstallationByConfiguredTarget(
  installations: ExtensionInstallation[],
  configuredTarget: ReconnectBindingOverride,
): ExtensionInstallation | undefined {
  if (!configuredTarget) {
    return undefined
  }

  return installations.find(installation =>
    matchesConfiguredReconnectTarget(installation, configuredTarget),
  )
}

function matchesConfiguredReconnectTarget(
  installation: ExtensionInstallation,
  configuredTarget: ReconnectBindingOverride,
): boolean {
  if (!configuredTarget) {
    return true
  }

  if (
    configuredTarget.browser &&
    installation.browser !== configuredTarget.browser
  ) {
    return false
  }
  if (
    configuredTarget.profile &&
    installation.profile !== configuredTarget.profile
  ) {
    return false
  }
  return true
}

function pathsEqual(left?: string, right?: string): boolean {
  if (!left || !right) {
    return false
  }

  if (platform() === 'win32') {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

function normalizeBrowserId(value: unknown): ChromiumBrowser | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return BROWSER_DETECTION_ORDER.includes(normalized as ChromiumBrowser)
    ? (normalized as ChromiumBrowser)
    : null
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
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

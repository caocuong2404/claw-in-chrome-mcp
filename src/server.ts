import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import {
  CHROME_EXTENSION_URL,
  launchClawInChromeReconnect,
  type SocketOptions,
  getAllSocketPaths,
  getSecureSocketPath,
} from './browser.js'
import { collectDoctorReport, type DoctorReport } from './doctor.js'
import {
  createClawInChromeMcpServer,
  type ClawInChromeContext,
} from './core/index.js'
import { createLogger, parseBooleanValue } from './shared.js'

export type ServeOptions = SocketOptions & {
  clientTypeId?: string
  logLevel?: string
  autoLaunchBrowser?: boolean
  collectDoctorReportImpl?: typeof collectDoctorReport
  launchReconnectImpl?: typeof launchClawInChromeReconnect
}

type ChromeContextOverrides = {
  autoLaunchBrowser?: boolean
  logger?: ClawInChromeContext['logger']
  triggerReconnectLaunch?: (reason: string) => void
}

type StartupAutoLaunchDependencies = {
  autoLaunchBrowser?: boolean
  logger: ClawInChromeContext['logger']
  collectDoctorReportImpl?: typeof collectDoctorReport
  triggerReconnectLaunch: (reason: string) => void
}

const AUTO_LAUNCH_COOLDOWN_MS = 10_000

export function resolveAutoLaunchBrowser(value?: boolean): boolean {
  if (value !== undefined) {
    return value
  }

  return parseBooleanValue(process.env.CIC_MCP_AUTO_LAUNCH_BROWSER) ?? true
}

export function shouldAutoLaunchBrowser(report: DoctorReport): boolean {
  const nativeHostReady =
    report.nativeHost.wrapperExists &&
    report.nativeHost.manifestPaths.length > 0 &&
    report.nativeHost.manifestPaths.every(item => item.exists) &&
    report.nativeHost.registryEntries.every(item => item.exists)

  return (
    report.extension.installed &&
    nativeHostReady &&
    report.socket.connectablePaths.length === 0
  )
}

export function createReconnectLaunchController(options: {
  autoLaunchBrowser: boolean
  logger: ClawInChromeContext['logger']
  cooldownMs?: number
  launchReconnectImpl?: typeof launchClawInChromeReconnect
}): (reason: string) => void {
  const cooldownMs = options.cooldownMs ?? AUTO_LAUNCH_COOLDOWN_MS
  let inFlight: Promise<boolean> | null = null
  let lastLaunchAt = 0

  return reason => {
    if (!options.autoLaunchBrowser) {
      return
    }

    const now = Date.now()
    if (inFlight) {
      options.logger.debug(
        '[server] reconnect launch already in progress, skip duplicate trigger (%s)',
        reason,
      )
      return
    }
    if (now - lastLaunchAt < cooldownMs) {
      options.logger.debug(
        '[server] reconnect launch cooldown active, skip trigger (%s)',
        reason,
      )
      return
    }

    lastLaunchAt = now
    const launchReconnectImpl =
      options.launchReconnectImpl ?? launchClawInChromeReconnect
    inFlight = launchReconnectImpl()
      .then(launched => {
        if (launched) {
          options.logger.info(
            '[server] launched Claw in Chrome reconnect flow (%s)',
            reason,
          )
        } else {
          options.logger.debug(
            '[server] reconnect launch returned false (%s)',
            reason,
          )
        }
        return launched
      })
      .catch(error => {
        options.logger.warn(
          '[server] failed to launch Claw in Chrome reconnect flow (%s): %s',
          reason,
          error instanceof Error ? error.message : String(error),
        )
        return false
      })
      .finally(() => {
        inFlight = null
      })
  }
}

export function createChromeContext(
  options: ServeOptions = {},
  overrides: ChromeContextOverrides = {},
): ClawInChromeContext {
  const logger = overrides.logger ?? createLogger(options.logLevel)
  const autoLaunchBrowser =
    overrides.autoLaunchBrowser ?? resolveAutoLaunchBrowser(options.autoLaunchBrowser)
  const triggerReconnectLaunch =
    overrides.triggerReconnectLaunch ??
    createReconnectLaunchController({
      autoLaunchBrowser,
      logger,
      launchReconnectImpl: options.launchReconnectImpl,
    })
  const disconnectedMessage =
    `Browser extension is not connected. Install the Claw in Chrome extension (${CHROME_EXTENSION_URL}), ` +
    'run `claw-in-chrome-mcp install-native-host`, then restart the browser and try again.' +
    (autoLaunchBrowser
      ? ' Claw in Chrome MCP will also try to open the reconnect page in the background. Wait a few seconds and retry.'
      : '')

  return {
    serverName: 'Claw in Chrome',
    logger,
    socketPath: getSecureSocketPath(options),
    getSocketPaths: () => getAllSocketPaths(options),
    clientTypeId: options.clientTypeId ?? 'ai-ide',
    onToolCallDisconnected: () => {
      if (autoLaunchBrowser) {
        triggerReconnectLaunch('tool-call-disconnected')
      }
      return disconnectedMessage
    },
  }
}

export async function maybeAutoLaunchBrowserOnStartup(
  options: ServeOptions,
  dependencies: StartupAutoLaunchDependencies,
): Promise<boolean> {
  const autoLaunchBrowser =
    dependencies.autoLaunchBrowser ?? resolveAutoLaunchBrowser(options.autoLaunchBrowser)
  if (!autoLaunchBrowser) {
    return false
  }

  const collectDoctorReportImpl =
    dependencies.collectDoctorReportImpl ?? collectDoctorReport

  try {
    const report = await collectDoctorReportImpl({
      socketPath: options.socketPath,
      socketDir: options.socketDir,
    })

    if (!shouldAutoLaunchBrowser(report)) {
      dependencies.logger.debug(
        '[server] startup auto-launch skipped because doctor report is not actionable',
      )
      return false
    }

    dependencies.triggerReconnectLaunch('startup')
    return true
  } catch (error) {
    dependencies.logger.warn(
      '[server] startup auto-launch check failed: %s',
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}

export async function runStdioServer(options: ServeOptions = {}): Promise<void> {
  const logger = createLogger(options.logLevel)
  const autoLaunchBrowser = resolveAutoLaunchBrowser(options.autoLaunchBrowser)
  const triggerReconnectLaunch = createReconnectLaunchController({
    autoLaunchBrowser,
    logger,
    launchReconnectImpl: options.launchReconnectImpl,
  })
  const context = createChromeContext(options, {
    autoLaunchBrowser,
    logger,
    triggerReconnectLaunch,
  })
  const server = createClawInChromeMcpServer(context)
  const transport = new StdioServerTransport()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) {
      return
    }
    exiting = true
    process.exit(0)
  }

  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())
  // 让 stdio 服务在客户端首条消息到达前也保持存活，避免 Windows / Electron
  // 在 stdin 仍然打开但尚未进入 flowing 模式时让进程过早退出。
  process.stdin.resume()

  context.logger.info('[server] starting stdio MCP server')
  void maybeAutoLaunchBrowserOnStartup(options, {
    autoLaunchBrowser,
    logger: context.logger,
    collectDoctorReportImpl: options.collectDoctorReportImpl,
    triggerReconnectLaunch,
  })
  await server.connect(transport)
  context.logger.info('[server] stdio MCP server ready')
}

#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import {
  launchClawInChromeReconnect,
  type ChromiumBrowser,
} from './browser.js'
import { collectDoctorReport, renderDoctorReport, reportToJson } from './doctor.js'
import { runChromeNativeHost } from './nativeHost.js'
import { installNativeHost } from './nativeHostInstall.js'
import { resolveAutoLaunchBrowser, runStdioServer } from './server.js'
import { parseBooleanValue } from './shared.js'

const VERSION = readPackageVersion()
const BROWSERS = new Set<ChromiumBrowser>([
  'chrome',
  'brave',
  'arc',
  'chromium',
  'edge',
  'vivaldi',
  'opera',
])

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    return packageJson.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    await runStdioServer()
    return
  }

  const first = argv[0]
  if (first === '--help' || first === '-h') {
    printHelp()
    return
  }
  if (first === '--version' || first === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  const hasExplicitCommand = !first.startsWith('-')
  const command = hasExplicitCommand ? first : 'serve'
  const subArgs = hasExplicitCommand ? argv.slice(1) : argv

  switch (command) {
    case 'serve': {
      const parsed = parseServeOptions(subArgs)
      await runStdioServer(parsed)
      return
    }
    case 'chrome-native-host': {
      const parsed = parseRuntimeOptions(subArgs)
      await runChromeNativeHost(parsed)
      return
    }
    case 'install-native-host': {
      const parsed = parseCommandArgs(subArgs, {
        'socket-path': { type: 'string' },
        'socket-dir': { type: 'string' },
        'log-level': { type: 'string' },
        'auto-launch-browser': { type: 'string' },
        browser: { type: 'string', multiple: true },
      })
      const cliEntryPath = fileURLToPath(import.meta.url)
      const result = await installNativeHost({
        cliEntryPath,
        socketPath: getStringValue(parsed['socket-path']),
        socketDir: getStringValue(parsed['socket-dir']),
        logLevel: getStringValue(parsed['log-level']),
        browsers: parseBrowsers(parsed.browser),
      })
      process.stdout.write(`Wrapper: ${result.wrapperPath}\n`)
      for (const manifestPath of result.manifestPaths) {
        process.stdout.write(`Manifest: ${manifestPath}\n`)
      }
      if (result.registryEntries.length > 0) {
        for (const entry of result.registryEntries) {
          process.stdout.write(`Registry: ${entry}\n`)
        }
      }
      if (
        resolveAutoLaunchBrowser(
          getBooleanValue(parsed['auto-launch-browser'], '--auto-launch-browser'),
        )
      ) {
        const launched = await launchClawInChromeReconnect()
        process.stdout.write(
          `Reconnect: ${
            launched
              ? 'launched browser profile'
              : 'unable to launch browser automatically'
          }\n`,
        )
      }
      return
    }
    case 'doctor': {
      const parsed = parseCommandArgs(subArgs, {
        'socket-path': { type: 'string' },
        'socket-dir': { type: 'string' },
        browser: { type: 'string', multiple: true },
        json: { type: 'boolean' },
      })
      const report = await collectDoctorReport({
        socketPath: getStringValue(parsed['socket-path']),
        socketDir: getStringValue(parsed['socket-dir']),
        browsers: parseBrowsers(parsed.browser),
      })
      process.stdout.write(
        `${parsed.json ? reportToJson(report) : renderDoctorReport(report)}\n`,
      )
      return
    }
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

function parseRuntimeOptions(args: string[]): {
  socketPath?: string
  socketDir?: string
  logLevel?: string
} {
  const parsed = parseCommandArgs(args, {
    'socket-path': { type: 'string' },
    'socket-dir': { type: 'string' },
    'log-level': { type: 'string' },
  })

  return {
    socketPath: getStringValue(parsed['socket-path']),
    socketDir: getStringValue(parsed['socket-dir']),
    logLevel: getStringValue(parsed['log-level']),
  }
}

function parseServeOptions(args: string[]): {
  socketPath?: string
  socketDir?: string
  logLevel?: string
  autoLaunchBrowser?: boolean
} {
  const parsed = parseCommandArgs(args, {
    'socket-path': { type: 'string' },
    'socket-dir': { type: 'string' },
    'log-level': { type: 'string' },
    'auto-launch-browser': { type: 'string' },
  })

  return {
    socketPath: getStringValue(parsed['socket-path']),
    socketDir: getStringValue(parsed['socket-dir']),
    logLevel: getStringValue(parsed['log-level']),
    autoLaunchBrowser: getBooleanValue(
      parsed['auto-launch-browser'],
      '--auto-launch-browser',
    ),
  }
}

function parseCommandArgs<
  T extends Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>,
>(args: string[], options: T): Record<string, string | boolean | string[] | undefined> {
  return parseArgs({
    args,
    options,
    allowPositionals: false,
  }).values as unknown as Record<string, string | boolean | string[] | undefined>
}

function parseBrowsers(values: string | string[] | boolean | undefined): ChromiumBrowser[] | undefined {
  if (!values || typeof values === 'boolean') {
    return undefined
  }

  const browsers = (Array.isArray(values) ? values : [values]).map(value =>
    value.toLowerCase(),
  )
  for (const browser of browsers) {
    if (!BROWSERS.has(browser as ChromiumBrowser)) {
      throw new Error(`Unsupported browser: ${browser}`)
    }
  }
  return browsers as ChromiumBrowser[]
}

function getStringValue(
  value: string | boolean | string[] | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getBooleanValue(
  value: string | boolean | string[] | undefined,
  optionName: string,
): boolean | undefined {
  const stringValue = getStringValue(value)
  if (stringValue === undefined) {
    return undefined
  }

  const parsed = parseBooleanValue(stringValue)
  if (parsed === undefined) {
    throw new Error(
      `Invalid value for ${optionName}: ${stringValue}. Use true/false, 1/0, yes/no, or on/off.`,
    )
  }

  return parsed
}

function printHelp(): void {
  process.stdout.write(
    [
      'claw-in-chrome-mcp',
      '',
      'Commands:',
      '  serve                Start stdio MCP server (default)',
      '  install-native-host  Install the Chromium native messaging host',
      '  doctor               Diagnose browser / extension / manifest / socket status',
      '  chrome-native-host   Internal native host entrypoint',
      '',
      'Shared options:',
      '  --socket-path <path>',
      '  --socket-dir <dir>',
      '  --log-level <level>',
      '  --auto-launch-browser <true|false>   serve/install only',
      '',
      'Doctor / install options:',
      '  --browser <name>     Repeatable. chrome | edge | brave | chromium | arc | vivaldi | opera',
      '  --json               doctor only',
      '',
      'Global:',
      '  -h, --help',
      '  -v, --version',
      '',
    ].join('\n'),
  )
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})

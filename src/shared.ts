import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { release } from 'node:os'
import { format } from 'node:util'

import type { Logger as CoreLogger } from './core/types.js'

const execFileAsync = promisify(execFile)

export type RuntimePlatform = 'windows' | 'macos' | 'linux' | 'wsl'
export type LogLevelName = 'silent' | 'error' | 'warn' | 'info' | 'debug'
export type ExecResult = { code: number; stdout: string; stderr: string }

const LOG_LEVEL_WEIGHT: Record<LogLevelName, number> = {
  silent: 100,
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
}

export function getPlatform(): RuntimePlatform {
  if (process.platform === 'win32') {
    return 'windows'
  }
  if (process.platform === 'darwin') {
    return 'macos'
  }

  const osRelease = release().toLowerCase()
  if (osRelease.includes('microsoft') || process.env.WSL_DISTRO_NAME) {
    return 'wsl'
  }
  return 'linux'
}

export function isFsInaccessible(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM'
}

export function jsonParse<T>(input: string): T {
  return JSON.parse(input) as T
}

export function jsonStringify(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space)
}

export async function execFileNoThrow(file: string, args: string[] = []): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
    })
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: number | string
    }
    return {
      code: typeof execError.code === 'number' ? execError.code : 1,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message,
    }
  }
}

export async function which(binary: string): Promise<string | null> {
  const command = process.platform === 'win32' ? 'where' : 'which'
  const result = await execFileNoThrow(command, [binary])
  if (result.code !== 0) {
    return null
  }

  return (
    result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) ?? null
  )
}

function normalizeLevel(level: string | undefined): LogLevelName {
  switch ((level ?? '').toLowerCase()) {
    case 'silent':
      return 'silent'
    case 'error':
      return 'error'
    case 'warn':
    case 'warning':
      return 'warn'
    case 'debug':
    case 'trace':
      return 'debug'
    default:
      return 'info'
  }
}

export function parseLogLevel(level: string | undefined): LogLevelName {
  return normalizeLevel(level)
}

export function parseBooleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return undefined
  }
}

export function createLogger(level?: string): CoreLogger {
  const activeLevel = normalizeLevel(level ?? process.env.CIC_MCP_LOG_LEVEL)

  const write = (
    messageLevel: Exclude<LogLevelName, 'silent'>,
    message: string,
    args: unknown[],
  ): void => {
    if (LOG_LEVEL_WEIGHT[messageLevel] < LOG_LEVEL_WEIGHT[activeLevel]) {
      return
    }

    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [claw-in-chrome-mcp] [${messageLevel}] ${format(message, ...args)}`
    process.stderr.write(`${line}\n`)
  }

  return {
    silly(message: string, ...args: unknown[]) {
      write('debug', message, args)
    },
    debug(message: string, ...args: unknown[]) {
      write('debug', message, args)
    },
    info(message: string, ...args: unknown[]) {
      write('info', message, args)
    },
    warn(message: string, ...args: unknown[]) {
      write('warn', message, args)
    },
    error(message: string, ...args: unknown[]) {
      write('error', message, args)
    },
  }
}

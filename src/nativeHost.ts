import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { platform } from 'node:os'
import { join } from 'node:path'

import {
  BROWSER_BINDING_HELLO_TYPE,
  BROWSER_BINDING_NOTIFICATION_METHOD,
  removeRuntimeSocketRegistration,
  type RuntimeBrowserBinding,
  type SocketOptions,
  getSecureSocketPath,
  getSocketDir,
  writeRuntimeSocketRegistration,
} from './browser.js'
import { createLogger, jsonParse, jsonStringify } from './shared.js'
import type { Logger } from './core/types.js'

const MAX_MESSAGE_SIZE = 1024 * 1024

async function readPackageVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    return packageJson.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

type ToolRequest = {
  method: string
  params?: unknown
}

type NotificationPayload = {
  method: string
  params?: Record<string, unknown>
}

type McpClient = {
  id: number
  socket: Socket
  buffer: Buffer
}

export type NativeHostOptions = SocketOptions & {
  logger?: Logger
}

export function sendChromeMessage(message: string): void {
  const jsonBytes = Buffer.from(message, 'utf-8')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32LE(jsonBytes.length, 0)
  process.stdout.write(lengthBuffer)
  process.stdout.write(jsonBytes)
}

export async function runChromeNativeHost(
  options: NativeHostOptions = {},
): Promise<void> {
  const logger = options.logger ?? createLogger(options.socketPath ? 'debug' : undefined)
  const host = new ChromeNativeHost(options, logger)
  const reader = new ChromeMessageReader()

  logger.info('[native-host] starting')
  await host.start()

  while (true) {
    const message = await reader.read()
    if (message === null) {
      break
    }
    await host.handleMessage(message)
  }

  await host.stop()
}

export class ChromeNativeHost {
  private readonly clients = new Map<number, McpClient>()
  private readonly logger: Logger
  private readonly options: SocketOptions
  private nextClientId = 1
  private runtimeBinding: RuntimeBrowserBinding | null = null
  private server: Server | null = null
  private running = false
  private socketPath: string | null = null

  constructor(options: SocketOptions, logger: Logger) {
    this.options = options
    this.logger = logger
  }

  async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.socketPath = getSecureSocketPath(this.options)
    if (platform() !== 'win32') {
      const socketDir = getSocketDir(this.options)
      try {
        const dirStats = await stat(socketDir)
        if (!dirStats.isDirectory()) {
          await unlink(socketDir)
        }
      } catch {
        // 忽略不存在场景。
      }

      await mkdir(socketDir, { recursive: true, mode: 0o700 })
      await chmod(socketDir, 0o700).catch(() => undefined)

      try {
        const files = await readdir(socketDir)
        for (const file of files) {
          if (!file.endsWith('.sock')) {
            continue
          }

          const pid = Number.parseInt(file.replace('.sock', ''), 10)
          if (Number.isNaN(pid)) {
            continue
          }

          try {
            process.kill(pid, 0)
          } catch {
            await unlink(join(socketDir, file)).catch(() => undefined)
          }
        }
      } catch {
        // 忽略扫描失败。
      }
    }

    this.server = createServer(socket => this.handleMcpClient(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath!, () => {
        this.running = true
        resolve()
      })
      this.server!.on('error', reject)
    })

    if (platform() !== 'win32') {
      await chmod(this.socketPath!, 0o600).catch(() => undefined)
    }

    await this.persistRuntimeSocketRegistration()
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    for (const client of this.clients.values()) {
      client.socket.destroy()
    }
    this.clients.clear()

    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }

    if (platform() !== 'win32' && this.socketPath) {
      await unlink(this.socketPath).catch(() => undefined)
      try {
        const socketDir = getSocketDir(this.options)
        const remaining = await readdir(socketDir)
        if (remaining.length === 0) {
          await rmdir(socketDir)
        }
      } catch {
        // 忽略清理失败。
      }
    }

    await removeRuntimeSocketRegistration(this.options).catch(() => undefined)

    this.running = false
  }

  async handleMessage(messageJson: string): Promise<void> {
    let message: unknown
    try {
      message = jsonParse(messageJson)
    } catch (error) {
      this.logger.error('[native-host] invalid JSON from Chrome: %s', (error as Error).message)
      sendChromeMessage(
        jsonStringify({
          type: 'error',
          error: 'Invalid message format',
        }),
      )
      return
    }

    if (!isChromeMessage(message)) {
      sendChromeMessage(
        jsonStringify({
          type: 'error',
          error: 'Invalid message format',
        }),
      )
      return
    }

    switch (message.type) {
      case BROWSER_BINDING_HELLO_TYPE: {
        // 把浏览器实例上报的绑定元数据缓存下来；后到达的 MCP 客户端也要能拿到。
        this.runtimeBinding = sanitizeRuntimeBrowserBinding(message)
        await this.persistRuntimeSocketRegistration()
        this.broadcastMcpNotification(
          BROWSER_BINDING_NOTIFICATION_METHOD,
          this.runtimeBinding,
        )
        break
      }
      case 'ping':
        sendChromeMessage(
          jsonStringify({
            type: 'pong',
            timestamp: Date.now(),
          }),
        )
        break
      case 'get_status':
        sendChromeMessage(
          jsonStringify({
            type: 'status_response',
            native_host_version: await readPackageVersion(),
          }),
        )
        break
      case 'tool_response':
      case 'notification': {
        const { type: _ignored, ...payload } = message
        this.broadcastSocketPayload(payload)
        break
      }
      default:
        sendChromeMessage(
          jsonStringify({
            type: 'error',
            error: `Unknown message type: ${message.type}`,
          }),
        )
    }
  }

  private handleMcpClient(socket: Socket): void {
    const clientId = this.nextClientId++
    const client: McpClient = {
      id: clientId,
      socket,
      buffer: Buffer.alloc(0),
    }

    this.clients.set(clientId, client)
    sendChromeMessage(jsonStringify({ type: 'mcp_connected' }))
    this.sendCurrentBindingToClient(client)

    socket.on('data', (data: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, data])
      while (client.buffer.length >= 4) {
        const length = client.buffer.readUInt32LE(0)
        if (length === 0 || length > MAX_MESSAGE_SIZE) {
          socket.destroy()
          return
        }

        if (client.buffer.length < 4 + length) {
          break
        }

        const messageBytes = client.buffer.subarray(4, 4 + length)
        client.buffer = client.buffer.subarray(4 + length)
        try {
          const request = jsonParse<ToolRequest>(messageBytes.toString('utf-8'))
          sendChromeMessage(
            jsonStringify({
              type: 'tool_request',
              method: request.method,
              params: request.params,
            }),
          )
        } catch (error) {
          this.logger.error('[native-host] failed to parse MCP request: %s', (error as Error).message)
        }
      }
    })

    socket.on('close', () => {
      this.clients.delete(clientId)
      sendChromeMessage(jsonStringify({ type: 'mcp_disconnected' }))
    })

    socket.on('error', error => {
      this.logger.error('[native-host] MCP client error: %s', error.message)
    })
  }

  private sendCurrentBindingToClient(client: McpClient): void {
    if (!this.runtimeBinding) {
      return
    }

    this.sendSocketPayload(client, {
      method: BROWSER_BINDING_NOTIFICATION_METHOD,
      params: this.runtimeBinding as Record<string, unknown>,
    })
  }

  private broadcastMcpNotification(
    method: string,
    params?: RuntimeBrowserBinding,
  ): void {
    this.broadcastSocketPayload({
      method,
      params: params as Record<string, unknown> | undefined,
    })
  }

  private broadcastSocketPayload(payload: NotificationPayload | Record<string, unknown>): void {
    const framed = frameSocketPayload(payload)
    for (const client of this.clients.values()) {
      client.socket.write(framed)
    }
  }

  private sendSocketPayload(
    client: McpClient,
    payload: NotificationPayload | Record<string, unknown>,
  ): void {
    client.socket.write(frameSocketPayload(payload))
  }

  private async persistRuntimeSocketRegistration(): Promise<void> {
    if (!this.socketPath) {
      return
    }

    await writeRuntimeSocketRegistration(this.socketPath, {
      ...this.options,
      runtimeBinding: this.runtimeBinding,
    })
  }
}

class ChromeMessageReader {
  private buffer = Buffer.alloc(0)
  private pendingResolve: ((value: string | null) => void) | null = null
  private closed = false

  constructor() {
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.tryProcessMessage()
    })

    const close = () => {
      this.closed = true
      if (this.pendingResolve) {
        this.pendingResolve(null)
        this.pendingResolve = null
      }
    }

    process.stdin.on('end', close)
    process.stdin.on('error', close)
  }

  async read(): Promise<string | null> {
    if (this.closed) {
      return null
    }

    if (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length > 0 && length <= MAX_MESSAGE_SIZE && this.buffer.length >= 4 + length) {
        const bytes = this.buffer.subarray(4, 4 + length)
        this.buffer = this.buffer.subarray(4 + length)
        return bytes.toString('utf-8')
      }
    }

    return new Promise(resolve => {
      this.pendingResolve = resolve
      this.tryProcessMessage()
    })
  }

  private tryProcessMessage(): void {
    if (!this.pendingResolve || this.buffer.length < 4) {
      return
    }

    const length = this.buffer.readUInt32LE(0)
    if (length === 0 || length > MAX_MESSAGE_SIZE) {
      this.pendingResolve(null)
      this.pendingResolve = null
      return
    }

    if (this.buffer.length < 4 + length) {
      return
    }

    const bytes = this.buffer.subarray(4, 4 + length)
    this.buffer = this.buffer.subarray(4 + length)
    this.pendingResolve(bytes.toString('utf-8'))
    this.pendingResolve = null
  }
}

function isChromeMessage(
  value: unknown,
): value is { type: string; [key: string]: unknown } {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
}

function frameSocketPayload(payload: NotificationPayload | Record<string, unknown>): Buffer {
  const bytes = Buffer.from(jsonStringify(payload), 'utf-8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(bytes.length, 0)
  return Buffer.concat([header, bytes])
}

function sanitizeRuntimeBrowserBinding(
  message: { [key: string]: unknown },
): RuntimeBrowserBinding {
  const protocolVersion =
    typeof message.protocolVersion === 'number' && Number.isFinite(message.protocolVersion)
      ? message.protocolVersion
      : undefined

  return {
    protocolVersion,
    browser: sanitizeOptionalString(message.browser),
    extensionId: sanitizeOptionalString(message.extensionId),
    extensionVersion: sanitizeOptionalString(message.extensionVersion),
    hostName: sanitizeOptionalString(message.hostName),
    instanceId: sanitizeOptionalString(message.instanceId),
  }
}

function sanitizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

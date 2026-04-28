import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BROWSER_BINDING_NOTIFICATION_METHOD } from '../src/browser.js'
import { ChromeNativeHost } from '../src/nativeHost.js'
import { createLogger } from '../src/shared.js'

test('binding_hello is broadcast as claw.binding to existing MCP clients', async () => {
  const host = new ChromeNativeHost({}, createLogger('silent'))
  const socket = new FakeSocket()

  ;(host as any).clients.set(1, {
    id: 1,
    socket,
    buffer: Buffer.alloc(0),
  })

  await host.handleMessage(
    JSON.stringify({
      type: 'binding_hello',
      protocolVersion: 1,
      browser: 'chrome',
      extensionId: 'ext-1',
      extensionVersion: '2.0.0',
      hostName: 'com.anthropic.claude_code_browser_extension',
      instanceId: 'instance-1',
    }),
  )

  assert.equal(socket.writes.length, 1)
  assert.deepEqual(decodeSocketPayload(socket.writes[0]!), {
    method: BROWSER_BINDING_NOTIFICATION_METHOD,
    params: {
      protocolVersion: 1,
      browser: 'chrome',
      extensionId: 'ext-1',
      extensionVersion: '2.0.0',
      hostName: 'com.anthropic.claude_code_browser_extension',
      instanceId: 'instance-1',
    },
  })
})

test('cached binding is replayed to MCP clients that connect after the hello message', async () => {
  const host = new ChromeNativeHost({}, createLogger('silent'))
  const socket = new FakeSocket()

  await host.handleMessage(
    JSON.stringify({
      type: 'binding_hello',
      protocolVersion: 1,
      browser: 'chrome',
      extensionId: 'ext-1',
      extensionVersion: '2.0.0',
      hostName: 'com.anthropic.claude_code_browser_extension',
      instanceId: 'instance-1',
    }),
  )

  withSilencedStdout(() => {
    ;(host as any).handleMcpClient(socket)
  })

  assert.equal(socket.writes.length, 1)
  assert.deepEqual(decodeSocketPayload(socket.writes[0]!), {
    method: BROWSER_BINDING_NOTIFICATION_METHOD,
    params: {
      protocolVersion: 1,
      browser: 'chrome',
      extensionId: 'ext-1',
      extensionVersion: '2.0.0',
      hostName: 'com.anthropic.claude_code_browser_extension',
      instanceId: 'instance-1',
    },
  })
})

test('get_status reports the current package version', async () => {
  const host = new ChromeNativeHost({}, createLogger('silent'))
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: string }

  const messages = await captureChromeStdoutMessages(async () => {
    await host.handleMessage(JSON.stringify({ type: 'get_status' }))
  })

  assert.deepEqual(messages, [
    {
      type: 'status_response',
      native_host_version: packageJson.version ?? '0.0.0',
    },
  ])
})

test('native host publishes runtime socket registration with browser binding metadata on windows', async () => {
  if (process.platform !== 'win32') {
    return
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'claw-in-chrome-mcp-native-host-'))
  const socketRegistryDir = join(tempRoot, 'runtime-sockets')
  const socketPath = `\\\\.\\pipe\\claw-in-chrome-mcp-native-host-test-${process.pid}-${Date.now()}`
  const host = new ChromeNativeHost(
    {
      socketPath,
      socketRegistryDir,
    },
    createLogger('silent'),
  )

  await host.start()

  const registrationPath = join(socketRegistryDir, `${process.pid}.json`)
  const initialRegistration = JSON.parse(
    await readFile(registrationPath, 'utf8'),
  ) as {
    socketPath: string
    runtimeBinding?: { browser?: string }
  }
  assert.equal(initialRegistration.socketPath, socketPath)
  assert.equal(initialRegistration.runtimeBinding, undefined)

  await host.handleMessage(
    JSON.stringify({
      type: 'binding_hello',
      protocolVersion: 1,
      browser: 'chrome',
      extensionId: 'ext-1',
      extensionVersion: '2.0.0',
      hostName: 'com.anthropic.claude_code_browser_extension',
      instanceId: 'instance-1',
    }),
  )

  const boundRegistration = JSON.parse(
    await readFile(registrationPath, 'utf8'),
  ) as {
    socketPath: string
    runtimeBinding?: { browser?: string }
  }
  assert.equal(boundRegistration.socketPath, socketPath)
  assert.equal(boundRegistration.runtimeBinding?.browser, 'chrome')

  await host.stop()
  await assert.rejects(readFile(registrationPath, 'utf8'))
})

class FakeSocket extends EventEmitter {
  public readonly writes: Buffer[] = []

  write(chunk: Buffer | string): boolean {
    this.writes.push(
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk),
    )
    return true
  }

  end(): void {}

  destroy(): this {
    this.emit('close')
    return this
  }
}

function decodeSocketPayload(buffer: Buffer): unknown {
  const length = buffer.readUInt32LE(0)
  return JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
}

function withSilencedStdout<T>(fn: () => T): T {
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    return fn()
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write
  }
}

async function captureChromeStdoutMessages(
  fn: () => Promise<void>,
): Promise<unknown[]> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  const chunks: Buffer[] = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk),
    )
    return true
  }) as typeof process.stdout.write

  try {
    await fn()
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write
  }

  const buffer = Buffer.concat(chunks)
  const messages: unknown[] = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    offset += 4
    messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString('utf8')))
    offset += length
  }
  return messages
}

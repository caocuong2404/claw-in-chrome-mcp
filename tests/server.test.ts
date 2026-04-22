import assert from 'node:assert/strict'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createClawInChromeMcpServer } from '../src/core/mcpServer.js'
import type { DoctorReport } from '../src/doctor.js'
import type { ClawInChromeContext, SocketClient } from '../src/core/types.js'
import {
  createChromeContext,
  maybeAutoLaunchBrowserOnStartup,
  shouldAutoLaunchBrowser,
} from '../src/server.js'
import { createLogger } from '../src/shared.js'

function createContext(): ClawInChromeContext {
  return {
    serverName: 'Claw in Chrome',
    logger: createLogger('silent'),
    socketPath: 'test-socket',
    clientTypeId: 'ai-ide',
    onToolCallDisconnected: () => 'disconnected',
  }
}

function createSocketClient(): SocketClient {
  return {
    ensureConnected: async () => true,
    callTool: async () => ({
      result: {
        content: [{ type: 'text', text: 'ok' }],
      },
    }),
    isConnected: () => true,
    disconnect: () => undefined,
    setNotificationHandler: () => undefined,
  }
}

async function listTools(context: ClawInChromeContext): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createClawInChromeMcpServer(context, createSocketClient())
  const client = new Client({ name: 'test-client', version: '1.0.0' })

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const result = await client.listTools()

  await Promise.all([clientTransport.close(), serverTransport.close()])
  return result.tools.map(tool => tool.name)
}

test('listTools exposes browser tools without bridge-only switch command', async () => {
  const tools = await listTools(createContext())
  assert.ok(tools.includes('navigate'))
  assert.ok(!tools.includes('switch_browser'))
})

test('createChromeContext triggers reconnect launch on disconnected tool calls', () => {
  const reasons: string[] = []
  const context = createChromeContext(
    { autoLaunchBrowser: true, logLevel: 'silent' },
    {
      autoLaunchBrowser: true,
      logger: createLogger('silent'),
      triggerReconnectLaunch: reason => reasons.push(reason),
    },
  )

  const message = context.onToolCallDisconnected()

  assert.match(message, /reconnect page in the background/i)
  assert.deepEqual(reasons, ['tool-call-disconnected'])
})

test('maybeAutoLaunchBrowserOnStartup triggers reconnect flow for actionable doctor reports', async () => {
  const reasons: string[] = []
  const triggered = await maybeAutoLaunchBrowserOnStartup(
    { autoLaunchBrowser: true },
    {
      autoLaunchBrowser: true,
      logger: createLogger('silent'),
      collectDoctorReportImpl: async () => buildDoctorReport(),
      triggerReconnectLaunch: reason => reasons.push(reason),
    },
  )

  assert.equal(triggered, true)
  assert.deepEqual(reasons, ['startup'])
})

test('shouldAutoLaunchBrowser returns false when a socket is already connectable', () => {
  const report = buildDoctorReport({
    socket: {
      expectedPath: 'test-socket',
      discoveredPaths: ['test-socket'],
      connectablePaths: ['test-socket'],
    },
  })

  assert.equal(shouldAutoLaunchBrowser(report), false)
})

function buildDoctorReport(
  overrides: Partial<DoctorReport> = {},
): DoctorReport {
  return {
    platform: 'windows',
    preferredBrowser: 'chrome',
    installedBrowsers: [{ browser: 'chrome', path: 'C:\\Chrome\\User Data' }],
    extension: {
      installed: true,
      browser: 'chrome',
      checkedPaths: [{ browser: 'chrome', path: 'C:\\Chrome\\User Data' }],
    },
    nativeHost: {
      wrapperPath: 'C:\\claw-in-chrome-mcp\\bin\\chrome-native-host.bat',
      wrapperExists: true,
      manifestPaths: [{ path: 'C:\\manifest.json', exists: true }],
      registryEntries: [{ key: 'HKCU\\Software\\Example', exists: true }],
    },
    socket: {
      expectedPath: 'test-socket',
      discoveredPaths: ['test-socket'],
      connectablePaths: [],
    },
    suggestions: [],
    ...overrides,
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import { McpSocketPool } from "../src/core/mcpSocketPool.js";
import type { ClawInChromeContext } from "../src/core/types.js";

type FakeResponse = unknown;

class FakeClient {
  public calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private notificationHandler:
    | ((notification: { method: string; params?: Record<string, unknown> }) => void)
    | null = null;

  constructor(
    private readonly handlers: Record<
      string,
      (args: Record<string, unknown>) => FakeResponse | Promise<FakeResponse>
    >,
  ) {}

  async ensureConnected(): Promise<boolean> {
    return true;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<FakeResponse> {
    this.calls.push({ name, args: { ...args } });
    const handler = this.handlers[name];
    if (!handler) {
      throw new Error(`Unhandled tool: ${name}`);
    }
    return await handler(args);
  }

  isConnected(): boolean {
    return true;
  }

  disconnect(): void {}

  setNotificationHandler(
    handler: (notification: {
      method: string;
      params?: Record<string, unknown>;
    }) => void,
  ): void {
    this.notificationHandler = handler;
  }

  emitNotification(notification: {
    method: string;
    params?: Record<string, unknown>;
  }): void {
    this.notificationHandler?.(notification);
  }
}

function createContext(socketPaths: string[]): ClawInChromeContext {
  return {
    serverName: "Claw in Chrome",
    logger: {
      info: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      silly: () => undefined,
    },
    socketPath: socketPaths[0]!,
    getSocketPaths: () => [...socketPaths],
    clientTypeId: "ai-ide",
    onToolCallDisconnected: () => "disconnected",
  };
}

function createTabsResult(
  availableTabs: Array<{ tabId: number; title: string; url: string }>,
) {
  return {
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ availableTabs }),
        },
      ],
    },
  };
}

function createPool(
  clients: Record<string, FakeClient>,
): McpSocketPool {
  const socketPaths = Object.keys(clients);
  const pool = new McpSocketPool(createContext(socketPaths));
  Reflect.set(pool, "clients", new Map(Object.entries(clients)));
  return pool;
}

test("routes tab-less tools to the socket that exposed the active tab context", async () => {
  const socketA = new FakeClient({
    tabs_context_mcp: () => createTabsResult([]),
    update_plan: () => ({ result: { content: [{ type: "text", text: "wrong" }] } }),
  });
  const socketB = new FakeClient({
    tabs_context_mcp: () =>
      createTabsResult([
        { tabId: 42, title: "Harness", url: "http://127.0.0.1:8123/" },
      ]),
    update_plan: () => ({ result: { content: [{ type: "text", text: "ok" }] } }),
  });

  const pool = createPool({
    "socket-a": socketA,
    "socket-b": socketB,
  });

  await pool.callTool("tabs_context_mcp", {});
  const response = await pool.callTool("update_plan", {
    domains: ["example.com"],
    approach: ["Open the page"],
  });

  assert.deepEqual(response, {
    result: { content: [{ type: "text", text: "ok" }] },
  });
  assert.equal(socketA.calls.some((call) => call.name === "update_plan"), false);
  assert.equal(socketB.calls.some((call) => call.name === "update_plan"), true);
});

test("tabs_context_mcp(createIfEmpty:true) only creates a new group on one preferred socket", async () => {
  const socketA = new FakeClient({
    tabs_context_mcp: (args) =>
      args.createIfEmpty
        ? createTabsResult([
            { tabId: 101, title: "New Tab", url: "chrome://newtab/" },
          ])
        : createTabsResult([]),
  });
  const socketB = new FakeClient({
    tabs_context_mcp: () => createTabsResult([]),
  });

  const pool = createPool({
    "socket-a": socketA,
    "socket-b": socketB,
  });

  const response = await pool.callTool("tabs_context_mcp", {
    createIfEmpty: true,
  });

  assert.deepEqual(response, createTabsResult([
    { tabId: 101, title: "New Tab", url: "chrome://newtab/" },
  ]));
  assert.deepEqual(
    socketA.calls.map((call) => call.args.createIfEmpty),
    [false, true],
  );
  assert.deepEqual(
    socketB.calls.map((call) => call.args.createIfEmpty),
    [false],
  );
});

test("tab-routed calls refresh the preferred socket for later tab-less tools", async () => {
  const socketA = new FakeClient({
    read_page: () => ({ result: { content: [{ type: "text", text: "a" }] } }),
    tabs_create_mcp: () => ({
      result: { content: [{ type: "text", text: "created-on-a" }] },
    }),
  });
  const socketB = new FakeClient({
    read_page: () => ({ result: { content: [{ type: "text", text: "b" }] } }),
    tabs_create_mcp: () => ({
      result: { content: [{ type: "text", text: "created-on-b" }] },
    }),
  });

  const pool = createPool({
    "socket-a": socketA,
    "socket-b": socketB,
  });

  Reflect.set(pool, "tabRoutes", new Map([[7, "socket-b"]]));

  await pool.callTool("read_page", { tabId: 7 });
  const response = await pool.callTool("tabs_create_mcp", {});

  assert.deepEqual(response, {
    result: { content: [{ type: "text", text: "created-on-b" }] },
  });
  assert.equal(
    socketA.calls.some((call) => call.name === "tabs_create_mcp"),
    false,
  );
  assert.equal(
    socketB.calls.some((call) => call.name === "tabs_create_mcp"),
    true,
  );
});

test("tabs_context_mcp drops a stale preferred socket when other sockets provide tabs", async () => {
  const socketA = new FakeClient({
    tabs_context_mcp: () => {
      throw new Error("stale socket");
    },
    update_plan: () => ({
      result: { content: [{ type: "text", text: "wrong" }] },
    }),
  });
  const socketB = new FakeClient({
    tabs_context_mcp: () =>
      createTabsResult([
        { tabId: 1, title: "B", url: "http://127.0.0.1:3001/" },
      ]),
    update_plan: () => ({
      result: { content: [{ type: "text", text: "ok-from-b" }] },
    }),
  });
  const socketC = new FakeClient({
    tabs_context_mcp: () =>
      createTabsResult([
        { tabId: 2, title: "C", url: "http://127.0.0.1:3002/" },
      ]),
    update_plan: () => ({
      result: { content: [{ type: "text", text: "ok-from-c" }] },
    }),
  });

  const pool = createPool({
    "socket-a": socketA,
    "socket-b": socketB,
    "socket-c": socketC,
  });
  Reflect.set(pool, "preferredSocketPath", "socket-a");

  await pool.callTool("tabs_context_mcp", {});
  const response = await pool.callTool("update_plan", {
    domains: ["example.com"],
    approach: ["Open the page"],
  });

  assert.notDeepEqual(response, {
    result: { content: [{ type: "text", text: "wrong" }] },
  });
  assert.equal(
    socketA.calls.some((call) => call.name === "update_plan"),
    false,
  );
});

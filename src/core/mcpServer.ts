import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  BROWSER_BINDING_NOTIFICATION_METHOD,
  rememberRuntimeBrowserBinding,
  type RuntimeBrowserBinding,
} from "../browser.js";
import { BROWSER_TOOLS } from "./browserTools.js";
import { createMcpSocketClient } from "./mcpSocketClient.js";
import { createMcpSocketPool } from "./mcpSocketPool.js";
import { handleToolCall } from "./toolCalls.js";
import type { ClawInChromeContext, SocketClient } from "./types.js";

/**
 * Create the socket/bridge client for the Chrome extension MCP server.
 * Exported so Desktop can share a single instance between the registered
 * MCP server and the InternalMcpServerManager (CCD sessions).
 */
export function createChromeSocketClient(
  context: ClawInChromeContext,
): SocketClient {
  return context.getSocketPaths
    ? createMcpSocketPool(context)
    : createMcpSocketClient(context);
}

export function createClawInChromeMcpServer(
  context: ClawInChromeContext,
  existingSocketClient?: SocketClient,
): Server {
  const { serverName, logger } = context;

  const socketClient =
    existingSocketClient ?? createChromeSocketClient(context);

  const server = new Server(
    {
      name: serverName,
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (context.isDisabled?.()) {
      return { tools: [] };
    }
    return { tools: BROWSER_TOOLS };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      logger.info(`[${serverName}] Executing tool: ${request.params.name}`);

      return handleToolCall(
        context,
        socketClient,
        request.params.name,
        request.params.arguments || {},
      );
    },
  );

  socketClient.setNotificationHandler((notification) => {
    if (notification.method === BROWSER_BINDING_NOTIFICATION_METHOD) {
      logger.info(
        `[${serverName}] Persisting internal browser binding notification`,
      );
      // 绑定通知属于控制面事件：收到后立刻落盘，后续 reconnect 才能显式回到正确 profile。
      void rememberRuntimeBrowserBinding(
        notification.params as RuntimeBrowserBinding,
        {
          log: (message) => logger.info(message),
        },
      ).catch((error) => {
        logger.info(
          `[${serverName}] Failed to persist browser binding: ${error.message}`,
        );
      });
      return;
    }

    logger.info(
      `[${serverName}] Forwarding MCP notification: ${notification.method}`,
    );
    server
      .notification({
        method: notification.method,
        params: notification.params,
      })
      .catch((error) => {
        // Server may not be connected yet (e.g., during startup or after disconnect)
        logger.info(
          `[${serverName}] Failed to forward MCP notification: ${error.message}`,
        );
      });
  });

  return server;
}

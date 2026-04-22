export interface Logger {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
  silly: (message: string, ...args: unknown[]) => void;
}

export interface ClawInChromeContext {
  serverName: string;
  logger: Logger;
  socketPath: string;
  // Optional dynamic resolver for socket path. When provided, called on each
  // connection attempt to handle runtime conditions (e.g., TMPDIR mismatch).
  getSocketPath?: () => string;
  // Optional resolver returning all available socket paths (for multi-profile support).
  // When provided, a socket pool connects to all sockets and routes by tab ID.
  getSocketPaths?: () => string[];
  clientTypeId: string;
  onToolCallDisconnected: () => string;
  isDisabled?: () => boolean;
}

/** Shared interface for McpSocketClient and McpSocketPool */
export interface SocketClient {
  ensureConnected(): Promise<boolean>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  isConnected(): boolean;
  disconnect(): void;
  setNotificationHandler(
    handler: (notification: {
      method: string;
      params?: Record<string, unknown>;
    }) => void,
  ): void;
}

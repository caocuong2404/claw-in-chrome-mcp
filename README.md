# Claw in Chrome MCP

<div align="center">

![Claw in Chrome MCP](https://img.shields.io/badge/Claw-in%20Chrome%20MCP-blue?style=for-the-badge)
![Version](https://img.shields.io/badge/version-0.1.0-green?style=for-the-badge)
![Platform](https://img.shields.io/badge/platform-macOS%20%2F%20Linux%20%2F%20Windows-lightgrey?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-orange?style=for-the-badge)

</div>

`claw-in-chrome-mcp` 是一个面向 **Claw in Chrome** 扩展的 Node 20+ MCP 工具。

它提供独立的 `stdio` MCP server、本地 Native Messaging Host 安装能力，以及浏览器 / 扩展 / socket 诊断能力，可被任意 AI IDE 以标准 MCP `stdio` 方式启动。

默认情况下，它会在合适的时候尽量自动拉起已安装扩展的 Chromium profile，并打开 reconnect 页面，尽量收敛“还得手动打开正确浏览器 profile”的使用差异。

## 这是什么

- 一个标准 `stdio` MCP server
- 一个本地 Native Messaging Host 安装器
- 一个浏览器 / 扩展 / manifest / socket 诊断工具

## 这不是什么

- 不包含浏览器扩展本体
- 不依赖任何官方 CLI
- 不包含 bridge WebSocket 远程模式
- 不包含登录、OAuth、配对或其他认证链路

## 配合目标

当前版本面向的是 **Claw in Chrome 浏览器扩展**：

- 仓库地址：[S-Trespassing/claw-in-chrome](https://github.com/S-Trespassing/claw-in-chrome)

当前 `claw-in-chrome` 仓库保留了与本项目兼容的扩展 ID 和 native host 协议，因此这套 MCP 包可以直接对接该 fork。若你后续修改了扩展 `key`、扩展 ID 或 native host 标识，请同步调整 MCP 侧配置。

## 安装

```bash
npm install -g claw-in-chrome-mcp
claw-in-chrome-mcp install-native-host
```

安装完成后，CLI 会默认尝试自动打开 reconnect 页面。

然后按下面顺序确认：

1. 按 [S-Trespassing/claw-in-chrome](https://github.com/S-Trespassing/claw-in-chrome) 仓库说明安装并启用 Claw in Chrome 扩展
2. 如果浏览器之前已经开着，完全退出并重启 Chromium 浏览器
3. 运行 `claw-in-chrome-mcp doctor` 确认环境状态

如果你是在源码目录里本地运行：

```bash
npm install
npm run build
node dist/cli.js install-native-host
```

## 在 AI IDE 中接入

发布后安装到全局环境时，可直接这样配置：

```json
{
  "mcpServers": {
    "claw-in-chrome": {
      "command": "claw-in-chrome-mcp",
      "args": ["serve"]
    }
  }
}
```

如果浏览器扩展暂时断开，`serve` 默认也会在后台尝试打开 reconnect 页面。你通常不需要先手动打开浏览器。

如果你是直接从源码目录运行，建议改成显式 `node + dist/cli.js`：

```json
{
  "mcpServers": {
    "claw-in-chrome": {
      "command": "node",
      "args": [
        "C:\\Users\\you\\path\\to\\claw-in-chrome-mcp\\dist\\cli.js",
        "serve"
      ]
    }
  }
}
```

## 常用命令

```bash
claw-in-chrome-mcp serve
claw-in-chrome-mcp install-native-host
claw-in-chrome-mcp doctor
claw-in-chrome-mcp doctor --json
claw-in-chrome-mcp --version
```

## 配置项

- `--socket-path` / `CIC_MCP_SOCKET_PATH`
- `--socket-dir` / `CIC_MCP_SOCKET_DIR`
- `--log-level` / `CIC_MCP_LOG_LEVEL`
- `--auto-launch-browser <true|false>` / `CIC_MCP_AUTO_LAUNCH_BROWSER`
- `--browser`：可重复传入 `chrome | edge | brave | chromium | arc | vivaldi | opera`
- `CLAW_IN_CHROME_EXTENSION_IDS`：逗号分隔的扩展 ID 覆盖默认值；如果你的 `claw-in-chrome` fork 改了扩展 `key` 或扩展 ID，请用它手动对齐

`CIC_MCP_AUTO_LAUNCH_BROWSER` 默认等价于 `true`。如果你不希望 `serve` 或 `install-native-host` 自动尝试拉起浏览器，可以显式关闭：

```bash
claw-in-chrome-mcp serve --auto-launch-browser false
```

或：

```bash
export CIC_MCP_AUTO_LAUNCH_BROWSER=0
```

## 发布说明

执行 `npm pack` 或 `npm publish` 前，包会自动执行：

1. `npm run clean`
2. `npm run build`
3. `npm test`

这样可以避免旧的 `dist` 残留被一起打进 tarball。

发布到 npm 时，请使用公开访问级别：

```bash
npm publish --access public
```

## License

MIT，详见 [LICENSE](./LICENSE)。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=S-Trespassing/claw-in-chrome&type=date&legend=top-left)](https://www.star-history.com/#S-Trespassing/claw-in-chrome&date)

#  Claw in Chrome MCP

<div align="center">

![Claw in Chrome MCP](https://img.shields.io/badge/Claw-in%20Chrome%20MCP-blue?style=for-the-badge)
![Version](https://img.shields.io/badge/version-0.1.0-green?style=for-the-badge)
![Platform](https://img.shields.io/badge/platform-macOS%20%2F%20Linux%20%2F%20Windows-lightgrey?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-orange?style=for-the-badge)

</div>

`claw-in-chrome-mcp` 是一个面向 **Claw in Chrome** 扩展的 Node 20+ MCP 工具,从泄露的cc源码中提取得到。

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

本项目面向 **Claw in Chrome 浏览器扩展**：

- 仓库地址：[S-Trespassing/claw-in-chrome](https://github.com/S-Trespassing/claw-in-chrome)

`claw-in-chrome` 仓库保留了与本项目兼容的扩展 ID 和 native host 协议，因此这套 MCP 包可以直接对接该 fork。若扩展侧修改了 `key`、扩展 ID 或 native host 标识，需要同步调整 MCP 侧配置。

## 安装

```bash
npm install -g claw-in-chrome-mcp
claw-in-chrome-mcp install-native-host
```

安装完成后，CLI 会默认尝试自动打开 reconnect 页面。

安装后建议按以下顺序确认环境：

1. 按 [S-Trespassing/claw-in-chrome](https://github.com/S-Trespassing/claw-in-chrome) 仓库说明安装并启用 Claw in Chrome 扩展
2. 如果浏览器之前已经开着，完全退出并重启 Chromium 浏览器
3. 运行 `claw-in-chrome-mcp doctor` 确认环境状态

源码目录本地运行方式：

```bash
npm install
npm run build
node dist/cli.js install-native-host
```

## 在 AI IDE 中接入

全局安装后的 MCP 配置示例：

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

浏览器扩展暂时断开时，`serve` 默认也会在后台尝试打开 reconnect 页面，通常无需预先手动打开浏览器。

源码目录运行时，可改为显式 `node + dist/cli.js`：

```json
{
  "mcpServers": {
    "claw-in-chrome": {
      "command": "node",
      "args": [
        "C:\\path\\to\\claw-in-chrome-mcp\\dist\\cli.js",
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
- `CLAW_IN_CHROME_EXTENSION_IDS`：逗号分隔的扩展 ID 覆盖默认值；如 `claw-in-chrome` fork 修改了扩展 `key` 或扩展 ID，可用该变量手动对齐

`CIC_MCP_AUTO_LAUNCH_BROWSER` 默认等价于 `true`。如需关闭 `serve` 或 `install-native-host` 的自动拉起浏览器行为，可显式设置：

```bash
claw-in-chrome-mcp serve --auto-launch-browser false
```

或：

```bash
export CIC_MCP_AUTO_LAUNCH_BROWSER=0
```

## License

MIT，详见 [LICENSE](./LICENSE)。

##  Star 历史


[![Star History Chart](https://api.star-history.com/svg?repos=S-Trespassing/claw-in-chrome-mcp&type=date&legend=top-left)](https://www.star-history.com/#S-Trespassing/claw-in-chrome-mcp&date)

# GraviSync

> 📱 Connect to your Antigravity AI session from anywhere by scanning a QR code. Monitor progress, approve actions, and manage your session remotely.

## Features

- **🏠 Secured Local Connect** — Same Wi-Fi, no tunnel, HTTPS with self-signed certs.
- **🌍 Secured Remote Connect** — Any network via Cloudflare Quick Tunnels (default, zero-config) or ngrok tunnel.
- **📡 Real-time Session Mirroring** — See AI thinking, code generation, progress walkthroughs, and file edits live.
- **⚡ Interactive Approvals** — Review implementation plans and approve sandboxed/unsandboxed command requests directly from your mobile device.
- **🔐 Security First** — Single-use HMAC-signed tokens, zero hardcoded secrets, rate limiting, and strict security headers.
- **🎨 Premium Mobile UI** — Dark glassmorphic design optimized for mobile web browsers with native markdown rendering.

## How it Works (Chrome DevTools Protocol - CDP)

GraviSync connects directly to your Antigravity IDE using the **Chrome DevTools Protocol (CDP)**. This allows the extension to capture the user interface snapshot, monitor execution state, and simulate click/input actions securely.

### Automatic Scanning
By default, GraviSync will scan popular CDP debugging ports (`9222`, `9000`, `9001`, `9002`, `9003`) to locate the Antigravity instance.

### Enabling CDP in Antigravity IDE

To allow GraviSync to connect, you must run the Antigravity IDE with remote debugging enabled. There are two ways to do this:

#### Method A: Relaunch via Command (Quickest)
1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Search and run: **`Relaunch IDE with CDP Enabled`** (or `agRemoteConnect.relaunchWithCDP`).
3. This will relaunch the IDE automatically with the debugging port open.

#### Method B: Configure IDE Permanently (Recommended)
To ensure the debugging port is always open whenever you start your IDE, add the remote debugging flag to your IDE launcher shortcut:
* **Windows**: Right-click the Antigravity IDE shortcut → Properties → In the **Target** field, append ` --remote-debugging-port=9222` to the end of the path.
* **Mac/Linux**: Launch the IDE from your terminal:
  ```bash
  antigravity --remote-debugging-port=9222 .
  ```

---

## Quick Start

### 1. Install the Extension
Search for **GraviSync** in the Extensions panel, or install from [Open VSX](https://open-vsx.org).

### 2. Launch the Sync Server
Click the **📱 GraviSync** icon in the Activity Bar, then click:
- **Secured GraviSync Remote** — Recommended. Sets up a zero-config secure tunnel.
- **Secured GraviSync Local** — Same Wi-Fi. Uses direct local IP (no tunnel needed).

### 3. Scan the QR Code
Scan the QR code in the sidebar with your phone. You'll instantly see your AI session!

---

## Configuration

Exposed as VS Code settings under the **GraviSync** category:

| Setting | Default | Description |
|:---|:---|:---|
| `agRemoteConnect.serverPort` | `7392` | Local server port for mobile clients |
| `agRemoteConnect.tunnelProvider` | `"cloudflare"` | Tunnel provider: `"cloudflare"` or `"ngrok"` |
| `agRemoteConnect.ngrokAuthToken` | `""` | ngrok authentication token |
| `agRemoteConnect.maxClients` | `5` | Max concurrent mobile connections |
| `agRemoteConnect.sessionTimeoutHours` | `24` | Client session expiration limit |
| `agRemoteConnect.snapshotIntervalMs` | `1000` | Snapshot polling interval |
| `agRemoteConnect.cdpPorts` | `"9222,9000,9001,9002,9003"` | Ports to scan for Antigravity instance |

## License

[MIT](LICENSE)

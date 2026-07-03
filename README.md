# GraviSync

Connect to your Antigravity AI session from anywhere by scanning a QR code. Monitor progress, approve actions, and manage your session remotely from any mobile device.

## Features

- **Secured Local Connect** — Same Wi-Fi, no tunnel, HTTPS with self-signed certificates.
- **Secured Remote Connect** — Any network via Cloudflare Quick Tunnels (zero-config, default) or ngrok.
- **Real-time Session Mirroring** — See AI reasoning, code generation, progress walkthroughs, and file edits live.
- **Interactive Approvals** — Review implementation plans and approve or deny sandboxed command requests directly from your phone.
- **Security First** — Single-use HMAC-signed tokens, zero hardcoded secrets, rate limiting, and strict security headers.
- **Premium Mobile UI** — Dark glassmorphic design optimized for mobile browsers with native markdown rendering.

## How it Works

GraviSync connects to your Antigravity IDE using the **Chrome DevTools Protocol (CDP)**. This allows the extension to capture the live UI snapshot, monitor execution state, and relay click and input actions securely to the running IDE instance.

### Automatic Port Scanning

By default, GraviSync scans the following CDP debugging ports to locate the Antigravity instance: `9222`, `9000`, `9001`, `9002`, `9003`.

### Enabling CDP in Antigravity IDE

Remote debugging must be enabled for GraviSync to connect. There are two methods:

#### Method A: Relaunch via Command (Quickest)

1. Open the command palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS).
2. Search for and run: **Relaunch IDE with CDP Enabled** (`agRemoteConnect.relaunchWithCDP`).
3. The IDE will automatically relaunch with the debugging port open.

#### Method B: Configure Permanently (Recommended)

Add the remote debugging flag to your IDE launcher so it is always enabled on startup.

- **Windows:** Right-click the Antigravity IDE shortcut, open Properties, and append `--remote-debugging-port=9222` to the end of the Target field.
- **macOS / Linux:** Launch the IDE from a terminal:
  ```bash
  antigravity --remote-debugging-port=9222 .
  ```

---

## Quick Start

### 1. Install

Search for **GraviSync** in the Extensions panel of Antigravity IDE, or install directly from [Open VSX](https://open-vsx.org/extension/gravisync/gravisync).

### 2. Start a Connection

Click the **GraviSync** icon in the Activity Bar, then select one of the connection modes:

- **Secured GraviSync Remote** — Recommended. Creates a zero-config encrypted tunnel accessible from anywhere.
- **Secured GraviSync Local** — Same Wi-Fi only. Uses your local IP directly with no tunnel required.

### 3. Connect from Your Phone

Scan the QR code shown in the sidebar. Your browser will open the GraviSync mobile interface, displaying your live AI session.

---

## Configuration

All settings are available under the **GraviSync** category in VS Code / Antigravity IDE settings.

| Setting | Default | Description |
|:---|:---|:---|
| `agRemoteConnect.serverPort` | `7392` | Local server port for mobile clients |
| `agRemoteConnect.tunnelProvider` | `"cloudflare"` | Tunnel provider: `"cloudflare"` or `"ngrok"` |
| `agRemoteConnect.ngrokAuthToken` | `""` | ngrok authentication token (required when using ngrok) |
| `agRemoteConnect.maxClients` | `5` | Maximum concurrent mobile connections |
| `agRemoteConnect.sessionTimeoutHours` | `24` | Client session expiration in hours |
| `agRemoteConnect.snapshotIntervalMs` | `1000` | Snapshot polling interval in milliseconds |
| `agRemoteConnect.cdpPorts` | `"9222,9000,9001,9002,9003"` | Comma-separated CDP ports to scan |

---

## License

This project is licensed under the MIT License. See the [LICENSE](https://github.com/shreyash3087/GraviSync/blob/main/LICENSE) file for details.

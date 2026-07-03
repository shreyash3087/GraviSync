/**
 * Sidebar WebView Provider
 * Renders the QR code, connection status, and controls in the sidebar
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { logInfo, logDebug } from '../utils/logger';
import { isServerRunning, getActiveServer, getActiveMode, getActiveTunnelUrl } from '../server/serverManager';
import { generateQRDataURI } from '../utils/qrGenerator';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'agRemoteConnect.sidebar';
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._extensionUri = _context.extensionUri;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        /**
         * Restore the running state into the sidebar whenever it becomes visible.
         * This is needed because VS Code destroys the webview context when the
         * sidebar is hidden (retainContextWhenHidden is false by default), so
         * every time the user clicks back to this panel we must re-hydrate it.
         */
        const restoreRunningState = async () => {
            if (!isServerRunning()) {
                return;
            }
            const srv = getActiveServer();
            const md = getActiveMode();
            if (!srv || !md) {
                return;
            }
            try {
                const { token } = srv.getAuthManager().generateMagicToken();
                const status = srv.getStatus();

                let authUrl = '';
                if (md === 'remote') {
                    const tunnelUrl = getActiveTunnelUrl() || '';
                    authUrl = `${tunnelUrl}/auth?t=${token}`;
                } else {
                    const localUrl = status.url || '';
                    authUrl = `${localUrl}/auth?t=${token}`;
                }

                const qrDataURI = await generateQRDataURI(authUrl);
                this.updateStatus({
                    state: 'running',
                    mode: md,
                    url: md === 'local' ? authUrl : `${status.url}/auth?t=${token}`,
                    tunnelUrl: md === 'remote' ? authUrl : undefined,
                    qrDataURI,
                    clients: status.clients,
                    cdpState: status.cdpState
                });
            } catch (err) {
                logDebug('Failed to restore running state: ' + err);
            }
        };

        // Re-hydrate state every time the panel becomes visible (covers the case
        // where the webview context was destroyed while the sidebar was hidden).
        this._context.subscriptions.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    // Wait for the webview script to signal readiness, then restore
                    const disposable = webviewView.webview.onDidReceiveMessage(
                        (message) => {
                            if (message.command === 'webviewReady') {
                                restoreRunningState();
                                disposable.dispose();
                            }
                        }
                    );
                }
            })
        );

        // Determine if we should render in running state immediately
        const serverAlreadyRunning = isServerRunning();

        // Read the current tunnel provider so the badge is shown correctly
        const tunnelProvider = vscode.workspace.getConfiguration('agRemoteConnect')
            .get<'cloudflare' | 'ngrok'>('tunnelProvider', 'cloudflare');

        // Render HTML with the correct initial state baked in — avoids the
        // postMessage race condition where the webview script hasn't attached
        // its listener yet when the first status update arrives.
        webviewView.webview.html = this._getHtml(webviewView.webview, serverAlreadyRunning ? 'running' : 'stopped', tunnelProvider);

        // On first resolve, if server is already running, restore once the
        // webview signals it is ready.
        if (serverAlreadyRunning) {
            const disposable = webviewView.webview.onDidReceiveMessage(
                (message) => {
                    if (message.command === 'webviewReady') {
                        restoreRunningState();
                        disposable.dispose();
                    }
                }
            );
        }



        // Handle messages from the WebView
        webviewView.webview.onDidReceiveMessage(
            (message) => {
                switch (message.command) {
                    case 'startLocal':
                        vscode.commands.executeCommand('agRemoteConnect.startLocal');
                        break;
                    case 'startRemote':
                        vscode.commands.executeCommand('agRemoteConnect.startRemote');
                        break;
                    case 'stop':
                        vscode.commands.executeCommand('agRemoteConnect.stop');
                        break;
                    case 'refreshQR':
                        vscode.commands.executeCommand('agRemoteConnect.refreshQR');
                        break;
                    case 'disconnectAll':
                        vscode.commands.executeCommand('agRemoteConnect.disconnectAll');
                        break;
                    case 'relaunch':
                        if (this._context.extensionMode === vscode.ExtensionMode.Development) {
                            vscode.window.showWarningMessage(
                                'This will close all open windows of the IDE and restart them with the remote debugging port (CDP) enabled. Proceed?',
                                'Relaunch IDE'
                            ).then(selection => {
                                if (selection === 'Relaunch IDE') {
                                    vscode.commands.executeCommand('agRemoteConnect.relaunchWithCDP');
                                }
                            });
                        } else {
                            vscode.commands.executeCommand('agRemoteConnect.relaunchWithCDP');
                        }
                        break;
                    case 'openUrl':
                        if (message.url) {
                            vscode.env.openExternal(vscode.Uri.parse(message.url));
                        }
                        break;
                    case 'copyUrl':
                        if (message.url) {
                            vscode.env.clipboard.writeText(message.url);
                            vscode.window.showInformationMessage('URL copied to clipboard');
                        }
                        break;
                }
            },
            undefined,
            this._context.subscriptions
        );

        logInfo('Sidebar WebView initialized');
    }

    /**
     * Post a message to the WebView
     */
    postMessage(message: Record<string, unknown>): void {
        this._view?.webview.postMessage(message);
    }

    /**
     * Update the sidebar with server status
     */
    updateStatus(data: {
        state: 'stopped' | 'starting' | 'running';
        mode?: 'local' | 'remote';
        url?: string;
        tunnelUrl?: string;
        qrDataURI?: string;
        clients?: { id: string; ip: string; connectedAt: number }[];
        cdpState?: string;
        startingMessage?: string;
    }): void {
        this.postMessage({ type: 'statusUpdate', ...data });
    }

    private _getHtml(webview: vscode.Webview, initialState: 'stopped' | 'running' = 'stopped', tunnelProvider: 'cloudflare' | 'ngrok' = 'cloudflare'): string {
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" 
          content="default-src 'none'; 
                   style-src ${webview.cspSource} 'unsafe-inline' https://cdnjs.cloudflare.com; 
                   script-src 'nonce-${nonce}'; 
                   img-src ${webview.cspSource} data:; 
                   font-src ${webview.cspSource} https://cdnjs.cloudflare.com;">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {
            --bg: var(--vscode-sideBar-background);
            --fg: var(--vscode-sideBar-foreground);
            --accent: #6366f1;
            --accent-secondary: #8b5cf6;
            --accent-gradient: linear-gradient(135deg, #6366f1, #8b5cf6);
            --success: #22c55e;
            --warning: #f59e0b;
            --danger: #ef4444;
            --surface: var(--vscode-editor-background);
            --border: var(--vscode-panel-border);
            --radius: 8px;
            --transition: 200ms ease;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg);
            background: var(--bg);
            padding: 12px;
            line-height: 1.5;
        }

        .section {
            margin-bottom: 16px;
        }

        .section-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.7;
            margin-bottom: 8px;
        }

        /* Buttons */
        .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            width: 100%;
            padding: 8px 12px;
            border: none;
            border-radius: var(--radius);
            cursor: pointer;
            font-family: inherit;
            font-size: 12px;
            font-weight: 500;
            transition: all var(--transition);
        }

        .btn-primary {
            background: var(--accent-gradient);
            color: white;
        }
        .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }

        .btn-secondary {
            background: var(--surface);
            color: var(--fg);
            border: 1px solid var(--border);
        }
        .btn-secondary:hover { border-color: var(--accent); }

        .btn-danger {
            background: transparent;
            color: var(--danger);
            border: 1px solid var(--danger);
        }
        .btn-danger:hover { background: var(--danger); color: white; }

        .btn-sm {
            padding: 5px 10px;
            font-size: 11px;
        }

        .btn + .btn { margin-top: 6px; }

        /* Status badge */
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 500;
            background: var(--surface);
            border: 1px solid var(--border);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--danger);
        }
        .status-dot.active { background: var(--success); animation: pulse 2s infinite; }
        .status-dot.connecting { background: var(--warning); animation: pulse 1s infinite; }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        /* QR Code container */
        .qr-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 16px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            margin-bottom: 12px;
        }

        .qr-container img {
            width: 200px;
            height: 200px;
            border-radius: 4px;
        }

        .qr-label {
            font-size: 11px;
            opacity: 0.6;
            margin-top: 8px;
            text-align: center;
        }

        /* URL display */
        .url-display {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            font-size: 11px;
            word-break: break-all;
            cursor: pointer;
            transition: border-color var(--transition);
        }
        .url-display:hover { border-color: var(--accent); }

        .url-display .icon { opacity: 0.5; flex-shrink: 0; }

        /* Client list */
        .client-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 8px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            font-size: 11px;
            margin-bottom: 4px;
        }

        .client-ip { font-family: monospace; }
        .client-time { opacity: 0.5; }

        /* Empty state */
        .empty-state {
            text-align: center;
            padding: 24px 12px;
            opacity: 0.5;
        }

        .empty-state .icon {
            font-size: 32px;
            margin-bottom: 8px;
        }

        .empty-state p {
            font-size: 12px;
        }

        /* Hidden state management */
        .hidden { display: none !important; }

        /* Mode label */
        .mode-label {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .mode-local { background: rgba(34, 197, 94, 0.15); color: var(--success); }
        .mode-remote { background: rgba(99, 102, 241, 0.15); color: var(--accent); }

        .status-badge-inline {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .status-badge-inline.success { background: rgba(34, 197, 94, 0.15); color: var(--success); }
        .status-badge-inline.warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
        .status-badge-inline.danger { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
        .status-badge-inline.info { background: rgba(156, 163, 175, 0.15); color: var(--fg); opacity: 0.8; }


        /* Info row */
        .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            font-size: 11px;
        }
        .info-row .label { opacity: 0.6; }

        /* Starting / downloading state */
        .qr-placeholder {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 16px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            margin-bottom: 12px;
        }

        .qr-shimmer {
            width: 160px;
            height: 160px;
            background: linear-gradient(
                90deg,
                var(--surface) 0%,
                rgba(99,102,241,0.2) 50%,
                var(--surface) 100%
            );
            background-size: 200% 100%;
            animation: shimmer 1.6s ease-in-out infinite;
            border-radius: 6px;
        }

        @keyframes shimmer {
            0%   { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        .spin {
            display: inline-block;
            animation: rotate 1.2s linear infinite;
        }

        @keyframes rotate {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
        }

        .url-placeholder {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            font-size: 11px;
            opacity: 0.4;
            font-style: italic;
        }
    </style>
</head>
<body>
    <!-- Stopped State -->
    <div id="stoppedState" class="${initialState === 'running' ? 'hidden' : ''}">
        <div class="empty-state">
            <div class="icon"><i class="fas fa-mobile-screen-button"></i></div>
            <p>Connect to your Antigravity session from your phone</p>
        </div>

        <div class="section">
            <div class="section-title">Start Connection</div>
            <button id="btnStartRemote" class="btn btn-primary">
                <i class="fas fa-globe"></i> Secured GraviSync Remote
            </button>
            <div style="margin-top: 6px; display: flex; align-items: center; gap: 6px; font-size: 10px; opacity: 0.7;">
                <span>via</span>
                ${tunnelProvider === 'cloudflare'
                    ? '<span class="mode-label" style="background:rgba(249,160,46,0.15);color:#f9a02e;"><i class="fas fa-cloud" style="font-size:9px;margin-right:3px;"></i>Cloudflare</span>'
                    : '<span class="mode-label" style="background:rgba(29,181,156,0.15);color:#1db59c;"><i class="fas fa-lock" style="font-size:9px;margin-right:3px;"></i>ngrok</span>'
                }
                <span style="opacity:0.5;">&bull; change in settings</span>
            </div>
            <button id="btnStartLocal" class="btn btn-secondary" style="margin-top: 8px;">
                <i class="fas fa-house"></i> Secured GraviSync Local
            </button>
            <div style="margin-top: 8px; font-size: 10px; opacity: 0.85; color: var(--warning); display: flex; gap: 6px; align-items: flex-start; line-height: 1.4;">
                <i class="fas fa-exclamation-triangle" style="flex-shrink: 0; margin-top: 2px;"></i>
                <span>Local connect uses self-signed SSL. Browsers will warn "Connection not secure". Tap <strong>Advanced → Proceed</strong> to continue.</span>
            </div>
        </div>

        <div class="section">
            <div class="section-title">Info</div>
            <div style="font-size: 11px; opacity: 0.6;">
                ${tunnelProvider === 'cloudflare'
                    ? '<p><strong>Remote:</strong> Any network &bull; Cloudflare tunnel &bull; No bandwidth limits (Recommended)</p>'
                    : '<p><strong>Remote:</strong> Any network &bull; ngrok tunnel &bull; Full auth (1 GB/month free)</p>'
                }
                <p style="margin-top: 4px;"><strong>Local:</strong> Same Wi-Fi &bull; No tunnel &bull; Self-signed HTTPS</p>
            </div>
        </div>
    </div>

    <!-- Starting / Downloading State -->
    <div id="startingState" class="hidden">
        <div class="section" style="text-align: center; padding: 16px 0 8px;">
            <div style="font-size: 30px; color: var(--accent); margin-bottom: 10px;">
                <span class="spin"><i class="fas fa-circle-notch"></i></span>
            </div>
            <div id="startingMessage" style="font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 4px;">Setting up tunnel...</div>
            <div style="font-size: 10px; opacity: 0.45;">Please wait, this may take a moment on first run</div>
        </div>

        <div class="qr-placeholder">
            <div class="qr-shimmer"></div>
            <div class="qr-label" style="margin-top: 8px;">QR code generating...</div>
        </div>

        <div class="section">
            <div class="section-title">Connection URL</div>
            <div class="url-placeholder">
                <i class="fas fa-link"></i>
                <span>Awaiting tunnel URL...</span>
            </div>
        </div>

        <div class="section">
            <button id="btnCancelStarting" class="btn btn-danger btn-sm">
                <i class="fas fa-times"></i> Cancel
            </button>
        </div>
    </div>

    <!-- Running State -->
    <div id="runningState" class="${initialState === 'stopped' ? 'hidden' : ''}">
        <div class="section">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                <div class="status-badge">
                    <span class="status-dot active" id="statusDot"></span>
                    <span id="statusText">Connected</span>
                </div>
                <span class="mode-label" id="modeLabel"></span>
            </div>
        </div>

        <!-- QR Code -->
        <div class="qr-container" id="qrContainer">
            <img id="qrImage" src="" alt="QR Code" />
            <div class="qr-label">Scan with your phone camera</div>
        </div>

        <!-- URL -->
        <div class="section">
            <div class="section-title">Connection URL</div>
            <div class="url-display" id="urlDisplay">
                <span class="icon"><i class="fas fa-link"></i></span>
                <span id="urlText"></span>
            </div>
        </div>

        <!-- Connected Clients -->
        <div class="section">
            <div class="section-title">Connected Clients (<span id="clientCount">0</span>)</div>
            <div id="clientList">
                <div class="client-item" style="opacity: 0.5; justify-content: center;">
                    No clients connected
                </div>
            </div>
        </div>

        <!-- CDP Status -->
        <div class="section">
            <div class="section-title">Session Status</div>
            <div class="info-row">
                <span class="label">CDP</span>
                <span id="cdpStatus">Connecting...</span>
            </div>
            <button id="btnRelaunchCDP" class="btn btn-secondary btn-sm hidden" style="margin-top: 8px;">
                <i class="fas fa-redo"></i> Relaunch IDE with CDP
            </button>
        </div>

        <!-- Actions -->
        <div class="section">
            <button id="btnRefreshQR" class="btn btn-secondary btn-sm">
                <i class="fas fa-sync-alt"></i> New QR Code
            </button>
            <button id="btnStopServer" class="btn btn-danger btn-sm">
                <i class="fas fa-stop"></i> Stop Server
            </button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let currentUrl = '';

        // Signal to the extension that the webview script is ready to receive messages
        vscode.postMessage({ command: 'webviewReady' });

        document.getElementById('btnStartLocal').addEventListener('click', () => {
            vscode.postMessage({ command: 'startLocal' });
            document.getElementById('stoppedState').classList.add('hidden');
        });

        document.getElementById('btnStartRemote').addEventListener('click', () => {
            vscode.postMessage({ command: 'startRemote' });
            // Immediately switch to starting state so the user sees feedback
            document.getElementById('stoppedState').classList.add('hidden');
            document.getElementById('startingState').classList.remove('hidden');
            document.getElementById('startingMessage').textContent = 'Starting server...';
        });

        document.getElementById('btnCancelStarting').addEventListener('click', () => {
            vscode.postMessage({ command: 'stop' });
            document.getElementById('startingState').classList.add('hidden');
            document.getElementById('stoppedState').classList.remove('hidden');
        });

        document.getElementById('btnStopServer').addEventListener('click', () => {
            vscode.postMessage({ command: 'stop' });
            document.getElementById('runningState').classList.add('hidden');
            document.getElementById('stoppedState').classList.remove('hidden');
        });

        document.getElementById('btnRefreshQR').addEventListener('click', () => {
            vscode.postMessage({ command: 'refreshQR' });
        });

        document.getElementById('btnRelaunchCDP').addEventListener('click', () => {
            vscode.postMessage({ command: 'relaunch' });
        });

        document.getElementById('urlDisplay').addEventListener('click', () => {
            if (currentUrl) {
                vscode.postMessage({ command: 'copyUrl', url: currentUrl });
            }
        });

        function formatTime(timestamp) {
            const d = new Date(timestamp);
            return d.toLocaleTimeString();
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.type === 'statusUpdate') {
                if (msg.state === 'running') {
                    document.getElementById('stoppedState').classList.add('hidden');
                    document.getElementById('startingState').classList.add('hidden');
                    document.getElementById('runningState').classList.remove('hidden');

                    // Mode label
                    const modeLabel = document.getElementById('modeLabel');
                    if (msg.mode === 'local') {
                        modeLabel.innerHTML = '<i class="fas fa-house" style="font-size: 9px; margin-right: 4px;"></i> LOCAL';
                        modeLabel.className = 'mode-label mode-local';
                    } else if (msg.mode === 'remote') {
                        modeLabel.innerHTML = '<i class="fas fa-globe" style="font-size: 9px; margin-right: 4px;"></i> REMOTE';
                        modeLabel.className = 'mode-label mode-remote';
                    }

                    // QR code
                    if (msg.qrDataURI) {
                        document.getElementById('qrImage').src = msg.qrDataURI;
                    }

                    // URL
                    currentUrl = msg.tunnelUrl || msg.url || '';
                    document.getElementById('urlText').textContent = currentUrl;

                    // CDP status
                    if (msg.cdpState) {
                        const statusEl = document.getElementById('cdpStatus');
                        const relaunchBtn = document.getElementById('btnRelaunchCDP');
                        
                        let badgeHtml = '';
                        let showRelaunch = false;
                        
                        switch (msg.cdpState) {
                            case 'connected':
                                badgeHtml = '<span class="status-badge-inline success"><i class="fas fa-check-circle"></i> Connected</span>';
                                break;
                            case 'connecting':
                                badgeHtml = '<span class="status-badge-inline warning"><i class="fas fa-spinner fa-spin"></i> Connecting</span>';
                                break;
                            case 'error':
                                badgeHtml = '<span class="status-badge-inline danger"><i class="fas fa-exclamation-circle"></i> Error (Not Found)</span>';
                                showRelaunch = true;
                                break;
                            case 'disconnected':
                            default:
                                badgeHtml = '<span class="status-badge-inline info"><i class="fas fa-power-off"></i> Disconnected</span>';
                                showRelaunch = true;
                                break;
                        }
                        
                        statusEl.innerHTML = badgeHtml;
                        if (relaunchBtn) {
                            if (showRelaunch) {
                                relaunchBtn.classList.remove('hidden');
                            } else {
                                relaunchBtn.classList.add('hidden');
                            }
                        }
                    }
                } else if (msg.state === 'starting') {
                    document.getElementById('stoppedState').classList.add('hidden');
                    document.getElementById('runningState').classList.add('hidden');
                    document.getElementById('startingState').classList.remove('hidden');
                    if (msg.startingMessage) {
                        document.getElementById('startingMessage').textContent = msg.startingMessage;
                    }
                } else if (msg.state === 'stopped') {
                    document.getElementById('runningState').classList.add('hidden');
                    document.getElementById('startingState').classList.add('hidden');
                    document.getElementById('stoppedState').classList.remove('hidden');
                }

                // Clients
                if (msg.clients) {
                    const list = document.getElementById('clientList');
                    const count = document.getElementById('clientCount');
                    count.textContent = msg.clients.length;

                    if (msg.clients.length === 0) {
                        list.innerHTML = '<div class="client-item" style="opacity: 0.5; justify-content: center;">No clients connected</div>';
                    } else {
                        list.innerHTML = msg.clients.map(c => 
                            '<div class="client-item">' +
                                '<span class="client-ip">' + c.ip + '</span>' +
                                '<span class="client-time">' + formatTime(c.connectedAt) + '</span>' +
                            '</div>'
                        ).join('');
                    }
                }
            }
        });
    </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

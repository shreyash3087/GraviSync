/**
 * Command: Start Secured Remote Connect
 * Launches the server + tunnel for global access.
 * Supports Cloudflare Quick Tunnels (default, zero-config) and ngrok.
 */
import * as vscode from 'vscode';
import { AppServer } from '../server/httpServer';
import { getOrCreateSSLCerts } from '../server/ssl';
import { startTunnel } from '../server/tunnel';
import { generateQRDataURI } from '../utils/qrGenerator';
import {
    isServerRunning,
    setActiveServer,
    setTunnelUrl,
    stopActiveServer
} from '../server/serverManager';
import { ExtensionConfig, ConnectedClient, CDPState } from '../types';
import { logInfo, logError, logWarn, showOutputChannel } from '../utils/logger';

export async function startRemoteConnect(
    context: vscode.ExtensionContext,
    config: ExtensionConfig,
    onStatusUpdate: (data: {
        mode: 'remote';
        localUrl: string;
        tunnelUrl: string;
        qrDataURI: string;
        magicToken: string;
    }) => void,
    onClientChange: (clients: ConnectedClient[]) => void,
    onCDPStateChange: (state: CDPState) => void,
    onProgress?: (message: string) => void
): Promise<void> {
    if (isServerRunning()) {
        vscode.window.showWarningMessage('Server is already running. Stop it first.');
        return;
    }

    // ─── ngrok token check (only when ngrok is the provider) ─────────────────
    if (config.tunnelProvider === 'ngrok') {
        const allTokens = buildNgrokTokenPool(config);

        if (allTokens.length === 0) {
            const selection = await vscode.window.showInformationMessage(
                'ngrok Auth Token Required\n\nTo connect remotely with ngrok, you need an auth token (free):\n1. Go to dashboard.ngrok.com (log in or sign up).\n2. Navigate to \'Your Authtoken\' in the left menu.\n3. Copy the token.\n\nThis will be saved globally so you only have to do this once.',
                { modal: true },
                'Enter Token'
            );

            if (selection !== 'Enter Token') {
                vscode.window.showWarningMessage('ngrok auth token is required when using the ngrok provider.');
                return;
            }

            const token = await vscode.window.showInputBox({
                prompt: 'Paste your ngrok auth token below:',
                placeHolder: 'your_ngrok_authtoken',
                password: true,
                ignoreFocusOut: true
            });

            if (!token) {
                vscode.window.showWarningMessage('ngrok auth token is required for Remote Connect.');
                return;
            }

            // Save globally (User scope) so all projects inherit it
            const wsConfig = vscode.workspace.getConfiguration('agRemoteConnect');
            await wsConfig.update('ngrokAuthToken', token, vscode.ConfigurationTarget.Global);

            // Remove workspace-level override if it exists, so the global value isn't shadowed
            const workspaceValue = wsConfig.inspect('ngrokAuthToken')?.workspaceValue;
            if (workspaceValue !== undefined) {
                await wsConfig.update('ngrokAuthToken', undefined, vscode.ConfigurationTarget.Workspace);
                logInfo('Removed workspace-level ngrokAuthToken override; now using global token.');
            }

            config.ngrokAuthToken = token;
            vscode.window.showInformationMessage('✅ Token saved globally — it will be available in all projects.');
        }
    }

    try {
        showOutputChannel();
        logInfo('Starting Secured Remote Connect...');

        // SSL certs for the local server
        const sslCerts = getOrCreateSSLCerts(context.extensionPath);

        // Create and start local server first
        const server = new AppServer(
            config,
            'remote',
            context.extensionPath,
            sslCerts,
            onClientChange,
            onCDPStateChange
        );

        const { localUrl, magicToken } = await server.start();
        setActiveServer(server, 'remote');
        logInfo(`Local server ready: ${localUrl}`);

        // Build the token pool for ngrok (primary + rotation tokens)
        const ngrokTokens = buildNgrokTokenPool(config);

        // Emit 'starting' to switch the sidebar into the loading panel
        const providerLabel = config.tunnelProvider === 'cloudflare' ? '☁ Cloudflare' : '🔒 ngrok';
        onProgress?.(`${providerLabel} tunnel starting...`);

        // Start tunnel via the configured provider
        vscode.window.showInformationMessage(`🌍 Starting ${providerLabel} tunnel...`);

        const tunnelUrl = await startTunnel(
            config.serverPort,
            config.tunnelProvider,
            context.globalStorageUri.fsPath,
            ngrokTokens,
            onProgress
        );
        setTunnelUrl(tunnelUrl);

        // Build magic link
        const authUrl = `${tunnelUrl}/auth?t=${magicToken}`;

        // Generate QR code
        const qrDataURI = await generateQRDataURI(authUrl);

        logInfo(`GraviSync ready: ${authUrl}`);
        vscode.window.showInformationMessage(
            `🌍 GraviSync ready! Scan QR or visit: ${tunnelUrl}`
        );

        onStatusUpdate({
            mode: 'remote',
            localUrl,
            tunnelUrl,
            qrDataURI,
            magicToken
        });

        // Non-blocking CDP status check
        setTimeout(() => {
            const status = server.getStatus();
            if (status.cdpState !== 'connected') {
                logWarn(`CDP is not connected yet (state: ${status.cdpState}). Session mirroring will activate once CDP connects.`);

                if (context.extensionMode === vscode.ExtensionMode.Development) {
                    vscode.window.showWarningMessage(
                        'CDP connection is not established. Relaunch the entire IDE (all windows) with CDP enabled to support debugging?',
                        'Relaunch IDE'
                    ).then(selection => {
                        if (selection === 'Relaunch IDE') {
                            vscode.commands.executeCommand('agRemoteConnect.relaunchWithCDP');
                        }
                    });
                } else {
                    vscode.window.showWarningMessage(
                        'CDP connection is not established. Relaunch the IDE with CDP enabled to support session mirroring.',
                        'Relaunch IDE with CDP'
                    ).then(selection => {
                        if (selection === 'Relaunch IDE with CDP') {
                            vscode.commands.executeCommand('agRemoteConnect.relaunchWithCDP');
                        }
                    });
                }
            }
        }, 3000);
    } catch (error) {
        logError('Failed to start Remote Connect', error);
        await stopActiveServer();

        vscode.window.showErrorMessage(
            `Failed to start Remote Connect: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Build the ordered ngrok token pool: [primary, ...extras]
 * Deduplicates and strips empty strings.
 */
function buildNgrokTokenPool(config: ExtensionConfig): string[] {
    const seen = new Set<string>();
    const pool: string[] = [];
    for (const t of [config.ngrokAuthToken, ...config.ngrokAuthTokens]) {
        const trimmed = t?.trim();
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            pool.push(trimmed);
        }
    }
    return pool;
}

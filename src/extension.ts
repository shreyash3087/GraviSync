/**
 * Antigravity Remote Connect — Extension Entry Point
 *
 * Registers commands, sidebar provider, and manages the server lifecycle.
 */
import * as vscode from 'vscode';
import { SidebarProvider } from './views/SidebarProvider';
import { startLocalConnect } from './commands/startLocal';
import { startRemoteConnect } from './commands/startRemote';
import { stopAllServers, isServerRunning, disconnectAllClients } from './commands/stopServer';
import { getActiveServer, getActiveMode, getActiveTunnelUrl } from './server/serverManager';
import { generateQRDataURI } from './utils/qrGenerator';
import { initLogger, logInfo, logError, disposeLogger } from './utils/logger';
import { ExtensionConfig } from './types';
import { relaunchWithCDP } from './utils/relaunchIDE';

let sidebarProvider: SidebarProvider;

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    initLogger();
    logInfo('GraviSync activating...');

    // Create sidebar provider
    sidebarProvider = new SidebarProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarProvider.viewType,
            sidebarProvider
        )
    );

    // --- Register Commands ---

    // Start Local Connect
    context.subscriptions.push(
        vscode.commands.registerCommand('agRemoteConnect.startLocal', async () => {
            const config = getConfig();
            await startLocalConnect(
                context,
                config,
                (data) => {
                    sidebarProvider.updateStatus({
                        state: 'running',
                        mode: data.mode,
                        url: `${data.url}/auth?t=${data.magicToken}`,
                        qrDataURI: data.qrDataURI
                    });
                },
                (clients) => {
                    sidebarProvider.updateStatus({
                        state: 'running',
                        clients
                    });
                },
                (cdpState) => {
                    sidebarProvider.updateStatus({
                        state: 'running',
                        cdpState
                    });
                }
            );
        })
    );

    // Start Remote Connect
    context.subscriptions.push(
        vscode.commands.registerCommand('agRemoteConnect.startRemote', async () => {
            const config = getConfig();

            // Immediately switch sidebar to starting state
            sidebarProvider.updateStatus({
                state: 'starting',
                startingMessage: config.tunnelProvider === 'cloudflare'
                    ? '☁ Starting Cloudflare tunnel...'
                    : '🔒 Starting ngrok tunnel...'
            });

            await startRemoteConnect(
                context,
                config,
                (data) => {
                    sidebarProvider.updateStatus({
                        state: 'running',
                        mode: data.mode,
                        url: `${data.localUrl}/auth?t=${data.magicToken}`,
                        tunnelUrl: `${data.tunnelUrl}/auth?t=${data.magicToken}`,
                        qrDataURI: data.qrDataURI
                    });
                },
                (clients) => {
                    sidebarProvider.updateStatus({
                        state: 'running',
                        clients
                    });
                },
                (cdpState) => {
                    sidebarProvider.updateStatus({
                        state: 'running',
                        cdpState
                    });
                },
                // Progress callback: keeps the starting message updated live
                (message) => {
                    sidebarProvider.updateStatus({
                        state: 'starting',
                        startingMessage: message
                    });
                }
            );
        })
    );

    // Stop Server
    context.subscriptions.push(
        vscode.commands.registerCommand('agRemoteConnect.stop', async () => {
            await stopAllServers();
            sidebarProvider.updateStatus({ state: 'stopped' });
        })
    );

    // Refresh QR Code
    context.subscriptions.push(
        vscode.commands.registerCommand('agRemoteConnect.refreshQR', async () => {
            const server = getActiveServer();
            const mode = getActiveMode();
            if (!server || !mode) {
                vscode.window.showWarningMessage('No server is running.');
                return;
            }

            try {
                // Generate new magic token
                const { token } = server.getAuthManager().generateMagicToken();
                const status = server.getStatus();
                
                // Determine base and auth URL
                let authUrl = '';
                if (mode === 'remote') {
                    const tunnelUrl = getActiveTunnelUrl() || '';
                    authUrl = `${tunnelUrl}/auth?t=${token}`;
                } else {
                    const localUrl = status.url || '';
                    authUrl = `${localUrl}/auth?t=${token}`;
                }

                const qrDataURI = await generateQRDataURI(authUrl);

                sidebarProvider.updateStatus({
                    state: 'running',
                    qrDataURI,
                    url: mode === 'local' ? authUrl : `${status.url}/auth?t=${token}`,
                    tunnelUrl: mode === 'remote' ? authUrl : undefined
                });

                vscode.window.showInformationMessage('QR code refreshed with a new token.');
            } catch (error) {
                logError('Failed to refresh QR', error);
                vscode.window.showErrorMessage('Failed to refresh QR code.');
            }
        })
    );

    // Disconnect All Clients
    context.subscriptions.push(
        vscode.commands.registerCommand('agRemoteConnect.disconnectAll', () => {
            disconnectAllClients();
            sidebarProvider.updateStatus({
                state: 'running',
                clients: []
            });
            vscode.window.showInformationMessage('All mobile clients disconnected.');
        })
    );

    // Relaunch IDE with CDP
    context.subscriptions.push(
        vscode.commands.registerCommand('agRemoteConnect.relaunchWithCDP', async () => {
            const config = getConfig();
            const port = config.cdpPorts[0] || 9222;
            await relaunchWithCDP(port, context);
        })
    );

    // Auto-start if configured
    const config = getConfig();
    if (config.autoStart) {
        logInfo('Auto-start enabled, starting Local Connect...');
        vscode.commands.executeCommand('agRemoteConnect.startLocal');
    }

    logInfo('GraviSync activated ✓');
}

export function deactivate() {
    logInfo('GraviSync deactivating...');

    // Stop all servers gracefully
    stopAllServers().catch(err => {
        logError('Error during deactivation', err);
    });

    disposeLogger();
}

/**
 * Read extension configuration from VS Code settings
 */
function getConfig(): ExtensionConfig {
    const wsConfig = vscode.workspace.getConfiguration('agRemoteConnect');

    const cdpPortsStr = wsConfig.get<string>('cdpPorts', '9222,9000,9001,9002,9003');
    const cdpPorts = cdpPortsStr.split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));

    return {
        serverPort: wsConfig.get<number>('serverPort', 7392),
        tunnelProvider: wsConfig.get<'cloudflare' | 'ngrok'>('tunnelProvider', 'cloudflare'),
        ngrokAuthToken: wsConfig.get<string>('ngrokAuthToken', ''),
        ngrokAuthTokens: wsConfig.get<string[]>('ngrokAuthTokens', []),
        maxClients: wsConfig.get<number>('maxClients', 5),
        sessionTimeoutHours: wsConfig.get<number>('sessionTimeoutHours', 24),
        snapshotIntervalMs: wsConfig.get<number>('snapshotIntervalMs', 1000),
        enableTotp: wsConfig.get<boolean>('enableTotp', false),
        autoStart: wsConfig.get<boolean>('autoStart', false),
        cdpPorts
    };
}

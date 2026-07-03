/**
 * Command: Start Secured Local Connect
 * Launches the server in LAN-only mode with HTTPS
 */
import * as vscode from 'vscode';
import { AppServer } from '../server/httpServer';
import { getOrCreateSSLCerts } from '../server/ssl';
import { generateQRDataURI } from '../utils/qrGenerator';
import {
    isServerRunning,
    setActiveServer,
    stopActiveServer
} from '../server/serverManager';
import { ExtensionConfig, ConnectedClient, CDPState } from '../types';
import { logInfo, logError, logWarn, showOutputChannel } from '../utils/logger';

export async function startLocalConnect(
    context: vscode.ExtensionContext,
    config: ExtensionConfig,
    onStatusUpdate: (data: {
        mode: 'local';
        url: string;
        qrDataURI: string;
        magicToken: string;
    }) => void,
    onClientChange: (clients: ConnectedClient[]) => void,
    onCDPStateChange: (state: CDPState) => void
): Promise<void> {
    if (isServerRunning()) {
        vscode.window.showWarningMessage('Server is already running. Stop it first.');
        return;
    }

    try {
        showOutputChannel();
        logInfo('Starting Secured Local Connect...');

        // Generate SSL certs
        const sslCerts = getOrCreateSSLCerts(context.extensionPath);

        // Create and start server
        const server = new AppServer(
            config,
            'local',
            context.extensionPath,
            sslCerts,
            onClientChange,
            onCDPStateChange
        );

        const { localUrl, magicToken } = await server.start();

        // Register in shared state
        setActiveServer(server, 'local');

        // Build magic link URL
        const authUrl = `${localUrl}/auth?t=${magicToken}`;

        // Generate QR code
        const qrDataURI = await generateQRDataURI(authUrl);

        logInfo(`Local Connect ready: ${authUrl}`);
        vscode.window.showInformationMessage(
            `🏠 Local Connect ready! Scan the QR code or visit: ${localUrl}`
        );

        onStatusUpdate({
            mode: 'local',
            url: localUrl,
            qrDataURI,
            magicToken
        });

        // Non-blocking CDP status check — warn if not connected after a short delay,
        // but don't block the server. CDP will keep retrying in the background.
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
        logError('Failed to start Local Connect', error);
        await stopActiveServer();
        vscode.window.showErrorMessage(
            `Failed to start Local Connect: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}


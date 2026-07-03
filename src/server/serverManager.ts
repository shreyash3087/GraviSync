/**
 * Shared server state manager
 * Ensures only one server instance runs at a time across Local and Remote modes.
 */
import { AppServer } from './httpServer';
import { stopTunnel, isTunnelActive } from './tunnel';
import { ConnectionMode } from '../types';
import { logInfo, logError } from '../utils/logger';

let activeServer: AppServer | null = null;
let activeMode: ConnectionMode | null = null;
let activeTunnelUrl: string | null = null;

export function getActiveServer(): AppServer | null {
    return activeServer;
}

export function getActiveMode(): ConnectionMode | null {
    return activeMode;
}

export function getActiveTunnelUrl(): string | null {
    return activeTunnelUrl;
}

export function setActiveServer(server: AppServer, mode: ConnectionMode): void {
    activeServer = server;
    activeMode = mode;
}

export function setTunnelUrl(url: string | null): void {
    activeTunnelUrl = url;
}

export function isServerRunning(): boolean {
    return activeServer !== null;
}

/**
 * Stop the active server and tunnel
 */
export async function stopActiveServer(): Promise<void> {
    if (!activeServer) {
        return;
    }

    try {
        // Stop tunnel first if active
        if (isTunnelActive()) {
            await stopTunnel();
            logInfo('ngrok tunnel closed');
        }
        activeTunnelUrl = null;

        // Stop server
        await activeServer.stop();
        logInfo('Server stopped');
    } catch (error) {
        logError('Error stopping server', error);
    } finally {
        activeServer = null;
        activeMode = null;
        activeTunnelUrl = null;
    }
}

/**
 * Disconnect all mobile clients without stopping the server
 */
export function disconnectAllClients(): void {
    if (activeServer) {
        activeServer.disconnectAllClients();
        logInfo('All clients disconnected');
    }
}

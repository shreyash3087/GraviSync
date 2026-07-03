/**
 * Tunnel dispatcher
 * Routes to the configured tunnel provider (Cloudflare or ngrok).
 */
import { TunnelProvider } from '../types';
import {
    startCloudflaredTunnel,
    stopCloudflaredTunnel,
    isCloudflaredTunnelActive
} from './providers/cloudflare';
import {
    startNgrokTunnel,
    stopNgrokTunnel,
    isNgrokTunnelActive
} from './providers/ngrok';
import { logInfo } from '../utils/logger';

let activeProvider: TunnelProvider | null = null;

/**
 * Start a tunnel using the configured provider.
 *
 * @param port         Local server port
 * @param provider     Which provider to use
 * @param storagePath  Extension global storage path (for cloudflared auto-download)
 * @param tokens       ngrok token pool (index 0 = primary, rest = rotation fallbacks)
 * @param onProgress   Optional callback for live status messages during setup
 */
export async function startTunnel(
    port: number,
    provider: TunnelProvider,
    storagePath: string,
    tokens: string[],
    onProgress?: (message: string) => void
): Promise<string> {
    activeProvider = provider;

    if (provider === 'cloudflare') {
        logInfo('Using Cloudflare Quick Tunnel provider');
        return startCloudflaredTunnel(port, storagePath, onProgress);
    }

    logInfo('Using ngrok tunnel provider');
    return startNgrokTunnel(port, tokens);
}

/** Stop whichever tunnel is currently active */
export async function stopTunnel(): Promise<void> {
    if (activeProvider === 'cloudflare') {
        stopCloudflaredTunnel();
    } else if (activeProvider === 'ngrok') {
        await stopNgrokTunnel();
    }
    activeProvider = null;
}

/** True if any tunnel is currently active */
export function isTunnelActive(): boolean {
    return isCloudflaredTunnelActive() || isNgrokTunnelActive();
}

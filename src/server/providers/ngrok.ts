/**
 * ngrok Tunnel Provider
 * Programmatic tunnel creation using @ngrok/ngrok SDK.
 * Supports token rotation: if the primary token hits the bandwidth limit,
 * the next token in the pool is tried automatically.
 */
import { logInfo, logWarn, logError } from '../../utils/logger';

let ngrokModule: typeof import('@ngrok/ngrok') | null = null;
let activeListener: unknown = null;

/**
 * Start an ngrok tunnel, rotating through the provided token pool on failure.
 * @param port      Local server port to tunnel to
 * @param tokens    Token pool — index 0 is the primary, rest are fallbacks
 */
export async function startNgrokTunnel(port: number, tokens: string[]): Promise<string> {
    const validTokens = tokens.filter(t => t && t.trim() !== '');

    if (validTokens.length === 0) {
        throw new Error(
            'ngrok auth token is required when using the ngrok tunnel provider. ' +
            'Set it in extension settings (agRemoteConnect.ngrokAuthToken).'
        );
    }

    // Dynamic import to avoid loading ngrok when not needed
    ngrokModule = ngrokModule ?? await import('@ngrok/ngrok');

    let lastError: unknown;

    for (let i = 0; i < validTokens.length; i++) {
        const token = validTokens[i];
        const isLast = i === validTokens.length - 1;

        try {
            logInfo(`Starting ngrok tunnel to localhost:${port} (token slot ${i + 1}/${validTokens.length})...`);

            const listener = await ngrokModule!.forward({
                addr: `https://localhost:${port}`,
                authtoken: token,
                verify_upstream_tls: false
            });

            activeListener = listener;
            const url = (listener as any).url();

            if (!url) {
                throw new Error('ngrok returned no URL');
            }

            logInfo(`ngrok tunnel established: ${url}`);
            return url;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            const isBandwidthError =
                msg.includes('ERR_NGROK_402') || // payment required / limit exceeded
                msg.includes('bandwidth')        ||
                msg.includes('limit');

            if (isBandwidthError && !isLast) {
                logWarn(`ngrok token slot ${i + 1} hit bandwidth limit. Rotating to next token...`);
                lastError = error;

                // Disconnect before trying next token
                try { await ngrokModule!.disconnect(); } catch { /* ignore */ }
                activeListener = null;
                continue;
            }

            // Non-recoverable error or last token — rethrow
            logError(`ngrok tunnel failed (token slot ${i + 1})`, error);
            activeListener = null;
            throw error;
        }
    }

    // All tokens exhausted
    throw lastError ?? new Error('All ngrok tokens exhausted. Check your bandwidth limits or add more tokens via agRemoteConnect.ngrokAuthTokens.');
}

/** Stop the active ngrok tunnel */
export async function stopNgrokTunnel(): Promise<void> {
    if (!ngrokModule) { return; }
    try {
        if (activeListener && typeof (activeListener as any).close === 'function') {
            await (activeListener as any).close();
        }
        await ngrokModule.disconnect();
        activeListener = null;
        logInfo('ngrok tunnel closed');
    } catch (error) {
        logError('Error closing ngrok tunnel', error);
        activeListener = null;
    }
}

/** True if an ngrok tunnel is currently active */
export function isNgrokTunnelActive(): boolean {
    return activeListener !== null;
}

/**
 * Cloudflare Quick Tunnel Provider
 *
 * Uses the `cloudflared` binary to create a free, ephemeral HTTPS tunnel with
 * no bandwidth limits and no account/sign-up required.
 *
 * If `cloudflared` is not found on PATH, the extension will automatically
 * download the binary into its own global storage directory and use it from there.
 */
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { logInfo, logError, logWarn } from '../../utils/logger';

const CLOUDFLARED_URL_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

// Download URLs for each platform
const CLOUDFLARED_DOWNLOAD: Record<string, string> = {
    'win32':  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    'darwin': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64',
    'linux':  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
};

// Windows PE magic bytes: "MZ"
const PE_MAGIC = Buffer.from([0x4d, 0x5a]);
// ELF magic bytes: "\x7fELF"
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

let activeProcess: ChildProcess | null = null;
/** Cached path to a verified-good cloudflared binary */
let resolvedBinaryPath: string | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Binary resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the path to a usable `cloudflared` binary.
 * Checks PATH first, then the extension-private storage dir.
 * If not found anywhere (or the cached copy is corrupt), downloads it.
 */
export async function resolveCloudflaredBinary(storagePath: string, onProgress?: (msg: string) => void): Promise<string> {
    // Clear cached path if it no longer exists or is corrupt
    if (resolvedBinaryPath) {
        if (!fs.existsSync(resolvedBinaryPath) || !isValidBinary(resolvedBinaryPath)) {
            logWarn(`Cached cloudflared binary at ${resolvedBinaryPath} is invalid. Re-resolving.`);
            resolvedBinaryPath = null;
        } else {
            return resolvedBinaryPath;
        }
    }

    onProgress?.('☁ Checking for cloudflared binary...');

    const onPath = await findOnPath();
    if (onPath && isValidBinary(onPath)) {
        logInfo(`cloudflared found on PATH: ${onPath}`);
        resolvedBinaryPath = onPath;
        return onPath;
    }

    // Check the private storage directory
    const localBin = getLocalBinaryPath(storagePath);
    if (fs.existsSync(localBin)) {
        if (isValidBinary(localBin)) {
            logInfo(`cloudflared found in extension storage: ${localBin}`);
            resolvedBinaryPath = localBin;
            return localBin;
        } else {
            logWarn('Cached cloudflared binary is corrupt. Deleting and re-downloading...');
            try { fs.unlinkSync(localBin); } catch { /* ignore */ }
        }
    }

    // Auto-download
    logInfo('cloudflared not found locally. Downloading automatically...');
    await downloadCloudflared(localBin, onProgress);
    resolvedBinaryPath = localBin;
    return localBin;
}

function getLocalBinaryPath(storagePath: string): string {
    const bin = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    return path.join(storagePath, 'cloudflared', bin);
}

/**
 * Checks that a file exists and has the correct magic bytes for the current
 * platform (PE on Windows, ELF on Linux/macOS).
 */
function isValidBinary(filePath: string): boolean {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size < 4) { return false; }

        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);

        if (process.platform === 'win32') {
            return buf.slice(0, 2).equals(PE_MAGIC);
        }
        return buf.equals(ELF_MAGIC);
    } catch {
        return false;
    }
}

async function findOnPath(): Promise<string | null> {
    return new Promise(resolve => {
        const cmd  = process.platform === 'win32' ? 'where' : 'which';
        const bin  = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
        const proc = spawn(cmd, [bin], { stdio: 'pipe', shell: true });
        let out = '';
        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.on('close', code => {
            resolve(code === 0 && out.trim() ? out.trim().split('\n')[0].trim() : null);
        });
        proc.on('error', () => resolve(null));
    });
}

async function downloadCloudflared(destPath: string, onProgress?: (msg: string) => void): Promise<void> {
    const platform = process.platform as string;
    const url = CLOUDFLARED_DOWNLOAD[platform];
    if (!url) {
        throw new Error(
            `No cloudflared binary available for platform: ${platform}. ` +
            `Please install it manually from https://developers.cloudflare.com/cloudflared/get-started/`
        );
    }

    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    onProgress?.('☁ Downloading cloudflared (~30 MB)...');
    logInfo(`Downloading cloudflared from ${url} → ${destPath}`);
    await downloadFileFollowingRedirects(url, destPath, onProgress);

    onProgress?.('☁ Validating binary...');
    // Validate the downloaded file before declaring success
    if (!isValidBinary(destPath)) {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        throw new Error(
            'Downloaded cloudflared binary appears to be invalid or corrupt. ' +
            'Please install it manually: https://developers.cloudflare.com/cloudflared/get-started/'
        );
    }

    // Make executable on Unix
    if (process.platform !== 'win32') {
        fs.chmodSync(destPath, 0o755);
    }
    logInfo('cloudflared downloaded and validated successfully.');
}

/**
 * Downloads a file following any number of HTTP redirects before opening the
 * write stream. This avoids the Windows file-locking issue that occurred when
 * the stream was opened before the final redirect destination was known.
 */
function downloadFileFollowingRedirects(url: string, destPath: string, onProgress?: (msg: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        let bytesReceived = 0;
        let contentLength = 0;
        let lastReportedPercent = -1;

        const doRequest = (currentUrl: string, redirectCount: number) => {
            if (redirectCount > 15) {
                return reject(new Error('Too many redirects while downloading cloudflared.'));
            }

            const parsedUrl = new URL(currentUrl);
            const options = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                headers: {
                    // GitHub requires a User-Agent header to avoid 403
                    'User-Agent': 'antigravity-remote-connect/1.0'
                }
            };

            https.get(options, (res) => {
                const status = res.statusCode ?? 0;

                // Follow any redirect
                if ([301, 302, 303, 307, 308].includes(status)) {
                    res.resume(); // drain & discard the redirect body
                    const location = res.headers.location;
                    if (!location) {
                        return reject(new Error('Redirect response had no Location header.'));
                    }
                    // Resolve relative redirect URLs
                    const nextUrl = location.startsWith('http')
                        ? location
                        : new URL(location, currentUrl).toString();
                    logInfo(`[cloudflared download] Redirect ${redirectCount + 1}: ${nextUrl}`);
                    doRequest(nextUrl, redirectCount + 1);
                    return;
                }

                if (status !== 200) {
                    res.resume();
                    return reject(new Error(`Download failed with HTTP ${status} from ${currentUrl}`));
                }

                contentLength = parseInt(res.headers['content-length'] ?? '0', 10);

                // Only open the file AFTER we've reached the final destination
                const file = fs.createWriteStream(destPath);
                res.on('data', (chunk: Buffer) => {
                    bytesReceived += chunk.length;
                    if (contentLength > 0 && onProgress) {
                        const pct = Math.floor((bytesReceived / contentLength) * 100);
                        if (pct !== lastReportedPercent && pct % 10 === 0) {
                            lastReportedPercent = pct;
                            onProgress(`☁ Downloading cloudflared... ${pct}%`);
                        }
                    }
                });
                res.pipe(file);

                file.on('finish', () => {
                    file.close(() => resolve());
                });
                file.on('error', (err) => {
                    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
                    reject(err);
                });
                res.on('error', (err) => {
                    file.close();
                    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
                    reject(err);
                });
            }).on('error', reject);
        };

        doRequest(url, 0);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tunnel lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a Cloudflare Quick Tunnel.
 * @param port        Local server port
 * @param storagePath Extension global storage path (for auto-downloaded binary)
 * @returns           The public trycloudflare.com HTTPS URL
 */
export async function startCloudflaredTunnel(port: number, storagePath: string, onProgress?: (msg: string) => void): Promise<string> {
    const binary = await resolveCloudflaredBinary(storagePath, onProgress);

    onProgress?.('☁ Establishing Cloudflare tunnel...');

    return new Promise((resolve, reject) => {
        logInfo(`Starting cloudflared quick tunnel to localhost:${port}...`);

        activeProcess = spawn(
            binary,
            [
                'tunnel',
                '--url', `https://localhost:${port}`,
                '--no-tls-verify'   // our local server uses a self-signed cert
            ],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env }
            }
        );

        let urlResolved = false;
        const timeoutMs = 45_000;

        const timeout = setTimeout(() => {
            if (!urlResolved) {
                stopCloudflaredProcess();
                reject(new Error('cloudflared timed out before providing a tunnel URL.'));
            }
        }, timeoutMs);

        const handleOutput = (data: Buffer) => {
            const text = data.toString();
            logInfo(`[cloudflared] ${text.trim()}`);

            if (!urlResolved) {
                const match = text.match(CLOUDFLARED_URL_REGEX);
                if (match) {
                    urlResolved = true;
                    clearTimeout(timeout);
                    const tunnelUrl = match[0];
                    logInfo(`cloudflared tunnel established: ${tunnelUrl}`);
                    resolve(tunnelUrl);
                }
            }
        };

        activeProcess.stdout?.on('data', handleOutput);
        activeProcess.stderr?.on('data', handleOutput);

        activeProcess.on('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timeout);
            // EFTYPE / ENOEXEC means the binary is not executable — clear the
            // cache so the next attempt re-downloads a fresh copy.
            if (err.code === 'EFTYPE' || err.code === 'ENOEXEC') {
                resolvedBinaryPath = null;
                logWarn('cloudflared binary rejected by OS (EFTYPE/ENOEXEC). Clearing cached path.');
                reject(new Error(
                    `cloudflared binary could not be executed (${err.code}). ` +
                    `The download may have been corrupt. Please try again — the extension will re-download it automatically.`
                ));
            } else {
                logError('cloudflared process error', err);
                reject(err);
            }
            activeProcess = null;
        });

        activeProcess.on('close', (code) => {
            if (!urlResolved) {
                clearTimeout(timeout);
                reject(new Error(`cloudflared exited with code ${code} before establishing a tunnel.`));
            } else {
                logWarn(`cloudflared process exited with code ${code}`);
            }
            activeProcess = null;
        });
    });
}

/** Stop the active cloudflared tunnel */
export function stopCloudflaredTunnel(): void {
    stopCloudflaredProcess();
}

function stopCloudflaredProcess(): void {
    if (activeProcess) {
        try { activeProcess.kill(); } catch (e) { logError('Error killing cloudflared', e); }
        activeProcess = null;
        logInfo('cloudflared tunnel closed');
    }
}

/** True if a cloudflared tunnel process is currently running */
export function isCloudflaredTunnelActive(): boolean {
    return activeProcess !== null;
}

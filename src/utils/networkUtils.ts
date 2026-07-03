/**
 * Network utility functions — IP detection, port checking
 */
import * as os from 'os';
import * as net from 'net';

/**
 * Get the best local network IP address for mobile access.
 * Prioritizes 192.168.x.x > 10.x.x.x > 172.x.x.x to prefer
 * real home/office Wi-Fi over virtual adapters (WSL/Docker).
 */
export function getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    const candidates: { address: string; priority: number }[] = [];

    for (const name of Object.keys(interfaces)) {
        const ifaces = interfaces[name];
        if (!ifaces) { continue; }

        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

/**
 * Get all local IPv4 addresses (for SSL certificate SAN)
 */
export function getAllLocalIPs(): string[] {
    const interfaces = os.networkInterfaces();
    const ips: string[] = ['127.0.0.1'];

    for (const name of Object.keys(interfaces)) {
        const ifaces = interfaces[name];
        if (!ifaces) { continue; }

        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }

    return [...new Set(ips)];
}

/**
 * Check if a port is available
 */
export function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(port, '0.0.0.0');
        server.on('listening', () => {
            server.close();
            resolve(true);
        });
        server.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Find the next available port starting from the given port
 */
export async function findAvailablePort(startPort: number): Promise<number> {
    for (let port = startPort; port < startPort + 100; port++) {
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    throw new Error(`No available port found in range ${startPort}-${startPort + 99}`);
}

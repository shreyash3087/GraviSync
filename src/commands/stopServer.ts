/**
 * Command: Stop Server
 * Re-exports from serverManager for clean API surface
 */
export { stopActiveServer as stopAllServers, isServerRunning, disconnectAllClients } from '../server/serverManager';

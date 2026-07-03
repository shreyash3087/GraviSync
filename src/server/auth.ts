/**
 * Authentication module
 * HMAC-signed magic link tokens, session management, rate limiting
 * No hardcoded secrets — everything is generated at runtime.
 */
import * as crypto from 'crypto';
import { Session, MagicLinkPayload } from '../types';
import { logInfo, logWarn, logError } from '../utils/logger';

const MAGIC_LINK_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export class AuthManager {
    private sessionSecret: Buffer;
    private sessions: Map<string, Session> = new Map();
    private usedNonces: Set<string> = new Set();
    private rateLimits: Map<string, { attempts: number; blockedUntil: number; windowStart: number }> = new Map();
    private sessionTTL: number;

    constructor(sessionTimeoutHours: number = 24) {
        // Generate a fresh 256-bit secret — never leaves server memory
        this.sessionSecret = crypto.randomBytes(32);
        this.sessionTTL = sessionTimeoutHours * 60 * 60 * 1000;
        logInfo('Auth manager initialized with fresh session secret');
    }

    /**
     * Generate a magic link token for QR code embedding
     * Returns { token, nonce, timestamp } to be encoded in the URL
     */
    generateMagicToken(): { token: string; nonce: string; timestamp: number } {
        const nonce = crypto.randomBytes(16).toString('hex');
        const timestamp = Date.now();
        const payload = `${nonce}:${timestamp}`;
        const signature = crypto
            .createHmac('sha256', this.sessionSecret)
            .update(payload)
            .digest('hex');

        const token = Buffer.from(`${payload}:${signature}`).toString('base64url');

        logInfo(`Magic token generated (nonce: ${nonce.slice(0, 8)}..., expires in 10 min)`);
        return { token, nonce, timestamp };
    }

    /**
     * Validate a magic link token
     * Returns true if valid, false otherwise
     */
    validateMagicToken(token: string, clientIP: string): boolean {
        // Check rate limit first
        if (this.isRateLimited(clientIP)) {
            logWarn(`Rate limited: ${clientIP}`);
            return false;
        }

        try {
            const decoded = Buffer.from(token, 'base64url').toString('utf8');
            const parts = decoded.split(':');
            if (parts.length !== 3) {
                this.recordAttempt(clientIP);
                return false;
            }

            const [nonce, timestampStr, signature] = parts;
            const timestamp = parseInt(timestampStr, 10);

            // Check expiry
            if (Date.now() - timestamp > MAGIC_LINK_EXPIRY_MS) {
                logWarn(`Magic token expired (age: ${Date.now() - timestamp}ms)`);
                this.recordAttempt(clientIP);
                return false;
            }

            // Nonce reuse check is disabled to allow multiple devices/clients
            // to connect concurrently using the same magic link / QR code.
            /*
            if (this.usedNonces.has(nonce)) {
                logWarn(`Nonce replay attempt detected: ${nonce.slice(0, 8)}...`);
                this.recordAttempt(clientIP);
                return false;
            }
            */

            // Verify HMAC signature
            const payload = `${nonce}:${timestampStr}`;
            const expectedSignature = crypto
                .createHmac('sha256', this.sessionSecret)
                .update(payload)
                .digest('hex');

            if (!crypto.timingSafeEqual(
                Buffer.from(signature, 'hex'),
                Buffer.from(expectedSignature, 'hex')
            )) {
                logWarn(`Invalid signature from ${clientIP}`);
                this.recordAttempt(clientIP);
                return false;
            }

            // Nonce marking is disabled to allow token re-use
            /*
            this.usedNonces.add(nonce);
            if (this.usedNonces.size > 1000) {
                const arr = Array.from(this.usedNonces);
                this.usedNonces = new Set(arr.slice(-500));
            }
            */

            logInfo(`Magic token validated for ${clientIP}`);
            return true;
        } catch (error) {
            logError('Token validation error', error);
            this.recordAttempt(clientIP);
            return false;
        }
    }

    /**
     * Create a new session after successful authentication
     */
    createSession(clientIP: string, userAgent?: string): string {
        const sessionId = crypto.randomBytes(32).toString('hex');
        const session: Session = {
            id: sessionId,
            clientIP,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            userAgent
        };

        this.sessions.set(sessionId, session);
        logInfo(`Session created for ${clientIP} (id: ${sessionId.slice(0, 8)}...)`);
        return sessionId;
    }

    /**
     * Validate a session cookie
     */
    validateSession(sessionId: string): Session | null {
        const session = this.sessions.get(sessionId);
        if (!session) { return null; }

        // Check expiry
        if (Date.now() - session.connectedAt > this.sessionTTL) {
            this.sessions.delete(sessionId);
            logInfo(`Session expired: ${sessionId.slice(0, 8)}...`);
            return null;
        }

        // Update last activity
        session.lastActivity = Date.now();
        return session;
    }

    /**
     * Destroy a session
     */
    destroySession(sessionId: string): void {
        this.sessions.delete(sessionId);
        logInfo(`Session destroyed: ${sessionId.slice(0, 8)}...`);
    }

    /**
     * Destroy all sessions (panic button)
     */
    destroyAllSessions(): void {
        const count = this.sessions.size;
        this.sessions.clear();
        logInfo(`All ${count} sessions destroyed`);
    }

    /**
     * Get all active sessions
     */
    getActiveSessions(): Session[] {
        const now = Date.now();
        const active: Session[] = [];

        for (const [id, session] of this.sessions) {
            if (now - session.connectedAt > this.sessionTTL) {
                this.sessions.delete(id);
            } else {
                active.push(session);
            }
        }

        return active;
    }

    /**
     * Get the number of active sessions
     */
    getSessionCount(): number {
        return this.getActiveSessions().length;
    }

    // --- Rate Limiting ---

    private isRateLimited(ip: string): boolean {
        const entry = this.rateLimits.get(ip);
        if (!entry) { return false; }

        if (entry.blockedUntil > Date.now()) {
            return true;
        }

        // Reset if window has passed
        if (Date.now() - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
            this.rateLimits.delete(ip);
            return false;
        }

        return false;
    }

    private recordAttempt(ip: string): void {
        const now = Date.now();
        let entry = this.rateLimits.get(ip);

        if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
            entry = { attempts: 0, blockedUntil: 0, windowStart: now };
        }

        entry.attempts++;

        if (entry.attempts >= MAX_ATTEMPTS) {
            entry.blockedUntil = now + BLOCK_DURATION_MS;
            logWarn(`IP ${ip} blocked for ${BLOCK_DURATION_MS / 1000}s after ${entry.attempts} failed attempts`);
        }

        this.rateLimits.set(ip, entry);
    }

    /**
     * Clean up expired rate limit entries
     */
    cleanupRateLimits(): void {
        const now = Date.now();
        for (const [ip, entry] of this.rateLimits) {
            if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS && entry.blockedUntil < now) {
                this.rateLimits.delete(ip);
            }
        }
    }

    /**
     * Regenerate the session secret (invalidates all tokens and sessions)
     */
    regenerateSecret(): void {
        this.sessionSecret = crypto.randomBytes(32);
        this.sessions.clear();
        this.usedNonces.clear();
        logInfo('Session secret regenerated — all sessions invalidated');
    }

    dispose(): void {
        this.sessions.clear();
        this.usedNonces.clear();
        this.rateLimits.clear();
    }
}

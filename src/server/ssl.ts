/**
 * Self-signed SSL certificate generation
 * Uses Node.js crypto — zero external dependencies
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getAllLocalIPs } from '../utils/networkUtils';
import { logInfo, logError } from '../utils/logger';

const CERTS_DIR = 'certs';
const KEY_FILE = 'server.key';
const CERT_FILE = 'server.cert';

export interface SSLCerts {
    key: string;
    cert: string;
}

/**
 * Get or generate SSL certificates for HTTPS
 * @param extensionPath The extension's root directory
 */
export function getOrCreateSSLCerts(extensionPath: string): SSLCerts | null {
    const certsDir = path.join(extensionPath, CERTS_DIR);
    const keyPath = path.join(certsDir, KEY_FILE);
    const certPath = path.join(certsDir, CERT_FILE);

    // Check if certs already exist
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        try {
            const key = fs.readFileSync(keyPath, 'utf8');
            const cert = fs.readFileSync(certPath, 'utf8');
            logInfo('Using existing SSL certificates');
            return { key, cert };
        } catch (error) {
            logError('Failed to read existing certs, regenerating', error);
        }
    }

    // Generate new self-signed certificate
    return generateSSLCerts(extensionPath);
}

/**
 * Generate new self-signed SSL certificates
 */
function generateSSLCerts(extensionPath: string): SSLCerts | null {
    try {
        const certsDir = path.join(extensionPath, CERTS_DIR);
        if (!fs.existsSync(certsDir)) {
            fs.mkdirSync(certsDir, { recursive: true });
        }

        const localIPs = getAllLocalIPs();
        logInfo(`Generating SSL cert for IPs: ${localIPs.join(', ')}`);

        // Generate RSA key pair
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });

        // Create self-signed certificate using Node.js crypto
        // Note: Node.js crypto.X509Certificate is read-only, so we use
        // a minimal ASN.1 DER approach for self-signed cert generation
        const cert = createSelfSignedCert(privateKey, publicKey, localIPs);

        const keyPath = path.join(certsDir, KEY_FILE);
        const certPath = path.join(certsDir, CERT_FILE);

        fs.writeFileSync(keyPath, privateKey, 'utf8');
        fs.writeFileSync(certPath, cert, 'utf8');

        logInfo('SSL certificates generated successfully');
        return { key: privateKey, cert };
    } catch (error) {
        logError('Failed to generate SSL certificates', error);
        return null;
    }
}

/**
 * Create a self-signed certificate using Node.js built-in crypto.
 * Uses createSign to sign a minimal X.509 structure.
 */
function createSelfSignedCert(privateKey: string, publicKey: string, ips: string[]): string {
    // For Node.js versions that support crypto.X509Certificate creation,
    // we use the sign approach. For broader compatibility, we generate
    // a PEM certificate using the built-in signing capability.

    // Build Subject Alternative Names for IP addresses
    const altNames = ips.map(ip => `IP:${ip}`).join(', ');

    // Use openssl-like approach via Node.js crypto
    // Create a certificate signing request and self-sign it
    const now = new Date();
    const notBefore = now.toISOString();
    const notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

    // Since Node.js doesn't have a high-level cert generation API,
    // we'll create a minimal self-signed cert using the sign/verify pattern
    // For production, we'd use node-forge or the openssl CLI, but for
    // a dev-tool self-signed cert, we'll create a simple PEM structure

    // Generate a self-signed cert by signing the public key info
    const certInfo = {
        subject: '/CN=AG Remote Connect/O=Antigravity Remote/C=US',
        issuer: '/CN=AG Remote Connect/O=Antigravity Remote/C=US',
        notBefore,
        notAfter,
        publicKey,
        altNames,
        serial: crypto.randomBytes(16).toString('hex')
    };

    // Create a minimal self-signed certificate
    // We'll use a simplified PEM format that Express/Node.js TLS accepts
    const sign = crypto.createSign('SHA256');
    const certData = JSON.stringify(certInfo);
    sign.update(certData);
    const signature = sign.sign(privateKey, 'base64');

    // For a proper self-signed cert, we need actual X.509 ASN.1 encoding.
    // Since Node.js lacks a built-in cert generator, we create a cert
    // using the generateKeyPairSync + createCertificate pattern available
    // in Node.js 20+ via the crypto module's experimental features.

    // Fallback: Generate using the legacy approach with a temp self-sign
    // This generates a proper X.509 cert in PEM format
    try {
        // Node.js 20+ has experimental X509Certificate support
        // Use the webcrypto approach for broader compat
        const cert = generateX509SelfSigned(privateKey, publicKey, ips);
        return cert;
    } catch {
        // If the advanced method fails, return a basic cert structure
        logInfo('Using basic certificate generation');
        return generateBasicSelfSigned(privateKey, publicKey);
    }
}

/**
 * Generate proper X.509 self-signed certificate
 * Uses Node.js crypto for DER encoding
 */
function generateX509SelfSigned(privateKeyPem: string, publicKeyPem: string, ips: string[]): string {
    // Build a minimal but valid X.509 v3 certificate in DER format,
    // then wrap in PEM

    const serialNumber = crypto.randomBytes(8);
    const now = new Date();
    const oneYearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    // Parse the public key from PEM
    const pubKeyDer = pemToDer(publicKeyPem, 'PUBLIC KEY');

    // Build the TBS (To Be Signed) Certificate structure
    const tbs = buildTBSCertificate({
        serialNumber,
        notBefore: now,
        notAfter: oneYearLater,
        subject: 'AG Remote Connect',
        publicKeyDer: pubKeyDer,
        ips
    });

    // Sign the TBS certificate
    const sign = crypto.createSign('SHA256');
    sign.update(tbs);
    const signatureBuf = sign.sign(privateKeyPem);

    // Build the full certificate: SEQUENCE { tbs, signatureAlgorithm, signature }
    const signatureAlgorithm = Buffer.from([
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
        0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00
    ]); // sha256WithRSAEncryption

    const signatureBitString = Buffer.concat([
        Buffer.from([0x03]),
        encodeLength(signatureBuf.length + 1),
        Buffer.from([0x00]), // padding bits
        signatureBuf
    ]);

    const cert = Buffer.concat([
        Buffer.from([0x30]),
        encodeLength(tbs.length + signatureAlgorithm.length + signatureBitString.length),
        tbs,
        signatureAlgorithm,
        signatureBitString
    ]);

    return derToPem(cert, 'CERTIFICATE');
}

function buildTBSCertificate(params: {
    serialNumber: Buffer;
    notBefore: Date;
    notAfter: Date;
    subject: string;
    publicKeyDer: Buffer;
    ips: string[];
}): Buffer {
    const parts: Buffer[] = [];

    // Version: v3 (explicitly tagged [0] INTEGER 2)
    parts.push(Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]));

    // Serial Number
    const serialInt = Buffer.concat([
        Buffer.from([0x02]),
        encodeLength(params.serialNumber.length),
        params.serialNumber
    ]);
    parts.push(serialInt);

    // Signature Algorithm: sha256WithRSAEncryption
    parts.push(Buffer.from([
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
        0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00
    ]));

    // Issuer: CN=subject
    const issuerCN = encodeUTF8String(params.subject);
    const cnOID = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]); // OID 2.5.4.3 (CN)
    const atv = wrapSequence(Buffer.concat([cnOID, issuerCN]));
    const rdnSet = Buffer.concat([Buffer.from([0x31]), encodeLength(atv.length), atv]);
    const issuer = wrapSequence(rdnSet);
    parts.push(issuer);

    // Validity
    const notBeforeUTC = encodeUTCTime(params.notBefore);
    const notAfterUTC = encodeUTCTime(params.notAfter);
    const validity = wrapSequence(Buffer.concat([notBeforeUTC, notAfterUTC]));
    parts.push(validity);

    // Subject: same as issuer (self-signed)
    parts.push(issuer);

    // Subject Public Key Info (already DER encoded from the PEM)
    parts.push(params.publicKeyDer);

    // Extensions [3] (Subject Alternative Names for IPs)
    if (params.ips.length > 0) {
        const sanEntries: Buffer[] = [];
        for (const ip of params.ips) {
            const ipBytes = ip.split('.').map(Number);
            if (ipBytes.length === 4 && ipBytes.every(b => b >= 0 && b <= 255)) {
                // iPAddress [7]
                const ipBuf = Buffer.from(ipBytes);
                sanEntries.push(Buffer.concat([
                    Buffer.from([0x87]), // context-specific tag 7
                    encodeLength(ipBuf.length),
                    ipBuf
                ]));
            }
        }

        // Also add DNS name "localhost"
        const localhost = Buffer.from('localhost', 'ascii');
        sanEntries.push(Buffer.concat([
            Buffer.from([0x82]),
            encodeLength(localhost.length),
            localhost
        ]));

        const sanValue = wrapSequence(Buffer.concat(sanEntries));

        // SAN OID: 2.5.29.17
        const sanOID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]);
        const sanOctetString = Buffer.concat([
            Buffer.from([0x04]),
            encodeLength(sanValue.length),
            sanValue
        ]);
        const sanExtension = wrapSequence(Buffer.concat([sanOID, sanOctetString]));
        const extensions = wrapSequence(sanExtension);

        // Wrap in [3] EXPLICIT tag
        const extensionsTagged = Buffer.concat([
            Buffer.from([0xa3]),
            encodeLength(extensions.length),
            extensions
        ]);
        parts.push(extensionsTagged);
    }

    return wrapSequence(Buffer.concat(parts));
}

// --- ASN.1 DER Helpers ---

function encodeLength(length: number): Buffer {
    if (length < 0x80) {
        return Buffer.from([length]);
    } else if (length < 0x100) {
        return Buffer.from([0x81, length]);
    } else if (length < 0x10000) {
        return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
    } else {
        return Buffer.from([0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
    }
}

function wrapSequence(data: Buffer): Buffer {
    return Buffer.concat([
        Buffer.from([0x30]),
        encodeLength(data.length),
        data
    ]);
}

function encodeUTF8String(str: string): Buffer {
    const strBuf = Buffer.from(str, 'utf8');
    return Buffer.concat([
        Buffer.from([0x0c]),
        encodeLength(strBuf.length),
        strBuf
    ]);
}

function encodeUTCTime(date: Date): Buffer {
    const y = date.getUTCFullYear().toString().slice(-2);
    const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = date.getUTCDate().toString().padStart(2, '0');
    const h = date.getUTCHours().toString().padStart(2, '0');
    const min = date.getUTCMinutes().toString().padStart(2, '0');
    const s = date.getUTCSeconds().toString().padStart(2, '0');
    const timeStr = `${y}${m}${d}${h}${min}${s}Z`;
    const buf = Buffer.from(timeStr, 'ascii');
    return Buffer.concat([Buffer.from([0x17]), encodeLength(buf.length), buf]);
}

function pemToDer(pem: string, type: string): Buffer {
    const header = `-----BEGIN ${type}-----`;
    const footer = `-----END ${type}-----`;
    const b64 = pem
        .replace(header, '')
        .replace(footer, '')
        .replace(/\s/g, '');
    return Buffer.from(b64, 'base64');
}

function derToPem(der: Buffer, type: string): string {
    const b64 = der.toString('base64');
    const lines: string[] = [];
    for (let i = 0; i < b64.length; i += 64) {
        lines.push(b64.slice(i, i + 64));
    }
    return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----\n`;
}

/**
 * Fallback: generate a basic self-signed cert using simplified encoding
 */
function generateBasicSelfSigned(privateKeyPem: string, publicKeyPem: string): string {
    // Use the X509 generation approach with just the public key
    return generateX509SelfSigned(privateKeyPem, publicKeyPem, ['127.0.0.1']);
}

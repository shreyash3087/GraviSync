/**
 * QR code generation utility
 * Generates QR codes as data URIs for embedding in the WebView sidebar
 */
import QRCode from 'qrcode';

/**
 * Generate a QR code as a data URI (PNG base64)
 */
export async function generateQRDataURI(url: string): Promise<string> {
    try {
        const dataURI = await QRCode.toDataURL(url, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            margin: 2,
            width: 280,
            color: {
                dark: '#e2e8f0',   // Light text for dark sidebar
                light: '#00000000' // Transparent background
            }
        });
        return dataURI;
    } catch (error) {
        throw new Error(`Failed to generate QR code: ${error}`);
    }
}

/**
 * Generate QR code as SVG string (for inline embedding)
 */
export async function generateQRSVG(url: string): Promise<string> {
    try {
        const svg = await QRCode.toString(url, {
            type: 'svg',
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 280,
            color: {
                dark: '#e2e8f0',
                light: '#00000000'
            }
        });
        return svg;
    } catch (error) {
        throw new Error(`Failed to generate QR SVG: ${error}`);
    }
}

/**
 * Structured logging with VS Code output channel
 */
import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | null = null;

export function initLogger(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('AG Remote Connect');
    }
    return outputChannel;
}

function getTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function logInfo(message: string, ...args: unknown[]): void {
    const formatted = `[${getTimestamp()}] [INFO] ${message}`;
    outputChannel?.appendLine(formatted);
    if (args.length) {
        outputChannel?.appendLine(`  ${JSON.stringify(args)}`);
    }
    console.log(formatted, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
    const formatted = `[${getTimestamp()}] [WARN] ${message}`;
    outputChannel?.appendLine(formatted);
    if (args.length) {
        outputChannel?.appendLine(`  ${JSON.stringify(args)}`);
    }
    console.warn(formatted, ...args);
}

export function logError(message: string, error?: unknown): void {
    const formatted = `[${getTimestamp()}] [ERROR] ${message}`;
    outputChannel?.appendLine(formatted);
    if (error instanceof Error) {
        outputChannel?.appendLine(`  ${error.message}`);
        if (error.stack) {
            outputChannel?.appendLine(`  ${error.stack}`);
        }
    } else if (error) {
        outputChannel?.appendLine(`  ${JSON.stringify(error)}`);
    }
    console.error(formatted, error);
}

export function logDebug(message: string, ...args: unknown[]): void {
    const formatted = `[${getTimestamp()}] [DEBUG] ${message}`;
    outputChannel?.appendLine(formatted);
    if (args.length) {
        outputChannel?.appendLine(`  ${JSON.stringify(args)}`);
    }
}

export function showOutputChannel(): void {
    outputChannel?.show(true);
}

export function disposeLogger(): void {
    outputChannel?.dispose();
    outputChannel = null;
}

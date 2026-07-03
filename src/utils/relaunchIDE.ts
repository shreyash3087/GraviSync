import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logInfo, logError } from './logger';

/**
 * Relaunch the current IDE window with the remote debugging port enabled.
 */
export async function relaunchWithCDP(port: number = 9222, context?: vscode.ExtensionContext): Promise<void> {
    try {
        logInfo(`Attempting to relaunch IDE with --remote-debugging-port=${port}`);
        
        // Get the active workspace folder path if one is open
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspacePath = workspaceFolders && workspaceFolders.length > 0
            ? workspaceFolders[0].uri.fsPath
            : '';

        // Arguments for relaunch
        const args = [
            `--remote-debugging-port=${port}`
        ];

        if (context && context.extensionMode === vscode.ExtensionMode.Development) {
            args.push(`--extensionDevelopmentPath=${context.extensionPath}`);
        }
        
        if (workspacePath) {
            args.push(workspacePath);
        }

        // Create a temporary Node.js script to handle the delayed relaunch.
        // Running it as a Node process ensures no terminal window flashes on Windows,
        // and we can reliably escape and pass arguments without platform shell bugs.
        const tempDir = os.tmpdir();
        const helperPath = path.join(tempDir, `ag-relaunch-${Date.now()}.js`);
        
        const scriptContent = `
const { spawn } = require('child_process');
const fs = require('fs');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ASAR;
for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_')) {
        delete env[key];
    }
}

setTimeout(() => {
    try {
        const child = spawn(process.argv[2], process.argv.slice(3), {
            detached: true,
            stdio: 'ignore',
            env
        });
        child.unref();
    } catch (e) {
        // Detached child spawn error, ignore since parent context is gone
    } finally {
        try {
            fs.unlinkSync(__filename);
        } catch (e) {}
        process.exit(0);
    }
}, 2000);
`;

        fs.writeFileSync(helperPath, scriptContent, 'utf8');

        // Spawn the helper script using the current Electron binary running in Node mode.
        // We keep process.env so it runs as a headless Node process.
        const child = spawn(process.execPath, [helperPath, process.execPath, ...args], {
            detached: true,
            stdio: 'ignore',
            env: process.env
        });

        child.unref();

        // Quit the entire application to ensure the root process exits and releases the single-instance lock.
        // On restart, all windows (including the developer workspace) will be restored under the new process.
        await vscode.commands.executeCommand('workbench.action.quit');
    } catch (error) {
        logError('Failed to relaunch IDE with CDP', error);
        vscode.window.showErrorMessage(
            `Failed to reload window: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

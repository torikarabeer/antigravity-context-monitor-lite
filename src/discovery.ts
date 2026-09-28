import { execFile } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as https from 'https';
import { existsSync } from 'fs';

const execFileAsync = promisify(execFile);

/**
 * Structured information about the discovered Antigravity Language Server.
 */
export interface LSInfo {
    pid: number;
    port: number;
    csrfToken: string;
    useTls: boolean;
}

export type DiscoveryFailedStep =
    | 'process_discovery'
    | 'process_match'
    | 'pid'
    | 'csrf_token'
    | 'port_discovery'
    | 'probe';

export interface DiscoveryResult {
    success: boolean;
    info?: LSInfo;
    error?: string;
    failedStep?: DiscoveryFailedStep;
    timestamp: Date;
}

export type WindowsExeKind = 'wmic' | 'powershell' | 'netstat';

/**
 * Build the absolute path to a Windows system executable from %SystemRoot%.
 * Avoids relying on the Extension Host process PATH environment variable.
 */
export function buildWindowsExePath(systemRoot: string | undefined, kind: WindowsExeKind): string {
    const bare: Record<WindowsExeKind, string> = {
        wmic: 'wmic',
        powershell: 'powershell.exe',
        netstat: 'netstat',
    };
    if (!systemRoot || !systemRoot.trim()) {
        return bare[kind];
    }
    const root = systemRoot.trim().replace(/[\\/]+$/, '');
    const rel: Record<WindowsExeKind, string> = {
        wmic: 'System32\\wbem\\WMIC.exe',
        powershell: 'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        netstat: 'System32\\NETSTAT.EXE',
    };
    return `${root}\\${rel[kind]}`;
}

/**
 * Extract PID from a Windows process-discovery CSV line:
 * - PowerShell ConvertTo-Csv: PID is the first column -> "12345","..."
 * - WMIC /format:csv: PID is the last column -> Node,CommandLine,12345
 */
export function extractWindowsPid(line: string): number | null {
    const trimmed = line.replace(/\r+$/, '').trim();
    if (!trimmed) {
        return null;
    }
    const inRange = (n: number) => n > 0 && n <= 0xffffffff;

    // PowerShell ConvertTo-Csv format: "12345","..."
    const psMatch = trimmed.match(/^\s*"?(\d+)"?\s*,/);
    if (psMatch) {
        const n = parseInt(psMatch[1], 10);
        if (inRange(n)) {
            return n;
        }
    }

    // WMIC CSV format: ...,12345
    const wmicMatch = trimmed.match(/,(\d+)\s*$/);
    if (wmicMatch) {
        const n = parseInt(wmicMatch[1], 10);
        if (inRange(n)) {
            return n;
        }
    }

    return null;
}

/**
 * Extract CSRF token from a command line string (--csrf_token <token>).
 */
export function extractCsrfToken(line: string): string | null {
    const match = line.match(/--csrf_token\s+([^\s"]+)/);
    return match ? match[1] : null;
}

/**
 * Extract workspace_id from a command line string (--workspace_id <id>).
 */
export function extractWorkspaceId(line: string): string | null {
    const match = line.match(/--workspace_id\s+([^\s"]+)/);
    return match ? match[1] : null;
}

/**
 * Select the appropriate Language Server process line.
 * Priority:
 * 1. Process without --workspace_id (Antigravity 1.22.2+ shared LS architecture)
 * 2. Process with matching workspace_id (if workspaceUri specified)
 * 3. First candidate process
 */
export function selectMatchingProcessLine(lines: readonly string[], workspaceUri?: string): string | null {
    if (lines.length === 0) {
        return null;
    }
    if (lines.length === 1) {
        return lines[0];
    }

    const newStyleLines = lines.filter(l => extractWorkspaceId(l) === null);
    const oldStyleLines = lines.filter(l => extractWorkspaceId(l) !== null);

    // Priority 1: New-style shared LS (no --workspace_id)
    if (newStyleLines.length > 0) {
        return newStyleLines[0];
    }

    // Priority 2: Old-style LS matching workspace_id
    if (workspaceUri && oldStyleLines.length > 0) {
        const expectedId = buildExpectedWorkspaceId(workspaceUri);
        const match = oldStyleLines.find(l => extractWorkspaceId(l) === expectedId);
        if (match) {
            return match;
        }
    }

    // Priority 3: Fallback to first line
    return lines[0];
}

/**
 * Helper to build expected workspace_id matching Antigravity's internal convention.
 */
export function buildExpectedWorkspaceId(workspaceUri: string): string {
    let id = workspaceUri.replace(':///', '_');
    id = id.replace(/:/g, '_3A_');
    id = id.replace(/[^a-zA-Z0-9_]/g, '_');
    id = id.replace(/__+/g, '_');
    return id;
}

/**
 * Check whether a netstat line represents a LISTENING socket belonging exactly to `pid`.
 */
export function netstatLineMatchesPid(line: string, pid: number): boolean {
    const trimmed = line.trim();
    const m = trimmed.match(/\s(\d+)$/);
    if (!m || m[1] !== String(pid)) {
        return false;
    }
    if (trimmed.includes('LISTENING')) {
        return true;
    }
    // Structural fallback for non-English locales
    const cols = trimmed.split(/\s+/);
    if (cols.length !== 5 || cols[0].toUpperCase() !== 'TCP') {
        return false;
    }
    return cols[2] === '0.0.0.0:0' || cols[2] === '[::]:0' || cols[2] === '*:*';
}

/**
 * Extract listening port from netstat column if host is loopback reachable.
 */
export function extractPortFromNetstat(line: string): number | null {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) {
        return null;
    }
    const localAddr = cols[1];
    const match = localAddr.match(/^(?:127\.0\.0\.1|0\.0\.0\.0|\*|::|\[::\]|\[::1\]):(\d+)$/);
    if (!match) {
        return null;
    }
    const port = parseInt(match[1], 10);
    return port > 0 && port <= 65535 ? port : null;
}

/**
 * Discover Windows Language Server processes via WMIC or PowerShell Get-CimInstance.
 */
async function discoverWindowsProcesses(signal?: AbortSignal, log?: (msg: string) => void): Promise<string> {
    const winRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const wmicExe = buildWindowsExePath(winRoot, 'wmic');
    const psExe = buildWindowsExePath(winRoot, 'powershell');

    // Try WMIC if present on disk (Windows 10 / older Windows 11)
    if (existsSync(wmicExe)) {
        try {
            const result = await execFileAsync(wmicExe, [
                'process', 'where',
                "name like 'language_server_windows%'",
                'get', 'ProcessId,CommandLine', '/format:csv'
            ], { encoding: 'utf-8', timeout: 5000, signal });

            if (result.stdout && result.stdout.includes('language_server_windows')) {
                return result.stdout;
            }
            log?.('[Lite] WMIC returned no language_server rows; falling back to PowerShell');
        } catch (e) {
            const msg = (e as Error).message ?? 'unknown';
            log?.(`[Lite] WMIC execution failed (${msg}); falling back to PowerShell`);
        }
    }

    // PowerShell Get-CimInstance fallback (standard on Windows 11 24H2+)
    try {
        const result = await execFileAsync(psExe, [
            '-NoProfile', '-NoLogo', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name like 'language_server_windows%'\" | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation"
        ], { encoding: 'utf-8', timeout: 10000, signal });
        return result.stdout;
    } catch (e) {
        const msg = (e as Error).message ?? 'unknown';
        log?.(`[Lite] PowerShell process discovery failed (${msg})`);
        return '';
    }
}

/**
 * Find listening TCP ports for a given PID using netstat -ano.
 */
async function findListeningPorts(pid: number, signal?: AbortSignal, log?: (msg: string) => void): Promise<number[]> {
    const winRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const netstatExe = buildWindowsExePath(winRoot, 'netstat');

    try {
        const result = await execFileAsync(netstatExe, ['-ano'], {
            encoding: 'utf-8',
            timeout: 5000,
            signal
        });
        const ports: number[] = [];
        for (const line of result.stdout.split('\n')) {
            if (netstatLineMatchesPid(line, pid)) {
                const port = extractPortFromNetstat(line);
                if (port !== null && !ports.includes(port)) {
                    ports.push(port);
                }
            }
        }
        return ports;
    } catch (e) {
        const msg = (e as Error).message ?? 'unknown';
        log?.(`[Lite] netstat execution failed (${msg})`);
        return [];
    }
}

/**
 * Probe a listening port with a lightweight Connect-RPC request to verify the Language Server.
 */
export async function probePort(
    port: number,
    csrfToken: string,
    useTls: boolean,
    signal?: AbortSignal
): Promise<boolean> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }

        let settled = false;
        const settle = (value: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            if (signal && onAbort) {
                signal.removeEventListener('abort', onAbort);
            }
            resolve(value);
        };

        const postData = JSON.stringify({
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                ideVersion: 'unknown',
                locale: 'en'
            }
        });

        const options: https.RequestOptions = {
            hostname: '127.0.0.1',
            port,
            path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': csrfToken,
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 3000,
            rejectUnauthorized: false // Language server uses a self-signed TLS cert
        };

        let onAbort: (() => void) | undefined;
        if (signal) {
            onAbort = () => {
                req.destroy();
                settle(false);
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }

        const transport = useTls ? https : http;
        const req = transport.request(options, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer | string) => {
                body += chunk;
                if (body.length > 1024 * 1024) {
                    req.destroy();
                    settle(false);
                }
            });
            res.on('error', () => settle(false));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        JSON.parse(body);
                        settle(true);
                    } catch {
                        settle(false);
                    }
                } else {
                    settle(false);
                }
            });
        });

        req.on('error', () => settle(false));
        req.on('timeout', () => {
            req.destroy();
            settle(false);
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Main discovery function: finds running Antigravity Language Server on Windows,
 * extracts PID, CSRF token, identifies listening port, and checks TLS requirement.
 */
export async function discoverLanguageServer(
    workspaceUri?: string,
    signal?: AbortSignal,
    log?: (msg: string) => void
): Promise<DiscoveryResult> {
    const timestamp = new Date();
    log?.('[Lite] Starting discovery...');

    if (process.platform !== 'win32') {
        const error = 'Unsupported platform: Windows only';
        log?.(`[Lite] Error: ${error}`);
        return { success: false, error, failedStep: 'process_discovery', timestamp };
    }

    // Step 1: Discover processes
    const rawOutput = await discoverWindowsProcesses(signal, log);
    const candidateLines = rawOutput.split('\n').filter(line => {
        const low = line.toLowerCase();
        return low.includes('language_server_windows') && low.includes('antigravity');
    });

    if (candidateLines.length === 0) {
        const error = 'No running Antigravity Language Server process found';
        log?.(`[Lite] Error: ${error}`);
        return { success: false, error, failedStep: 'process_discovery', timestamp };
    }

    // Step 2: Match process line
    const targetLine = selectMatchingProcessLine(candidateLines, workspaceUri);
    if (!targetLine) {
        const error = `Failed to select target LS process from ${candidateLines.length} candidates`;
        log?.(`[Lite] Error: ${error}`);
        return { success: false, error, failedStep: 'process_match', timestamp };
    }

    // Step 3: Extract PID
    const pid = extractWindowsPid(targetLine);
    if (!pid) {
        const error = 'Failed to extract PID from LS process command line';
        log?.(`[Lite] Error: ${error}`);
        return { success: false, error, failedStep: 'pid', timestamp };
    }

    // Step 4: Extract CSRF token
    const csrfToken = extractCsrfToken(targetLine);
    if (!csrfToken) {
        const error = `Failed to extract --csrf_token for PID ${pid}`;
        log?.(`[Lite] Error: ${error}`);
        return { success: false, error, failedStep: 'csrf_token', timestamp };
    }

    log?.('[Lite] Language Server found');
    log?.(`[Lite] PID: ${pid}`);

    // Step 5: Find listening ports
    const ports = await findListeningPorts(pid, signal, log);
    if (ports.length === 0) {
        const error = `No listening localhost ports found for PID ${pid}`;
        log?.(`[Lite] Error: ${error}`);
        return { success: false, error, failedStep: 'port_discovery', timestamp };
    }
    log?.(`[Lite] Found candidate listening ports: ${ports.join(', ')}`);

    // Step 6: Probe each port (Try HTTPS first, then HTTP)
    for (const port of ports) {
        // Try HTTPS
        if (await probePort(port, csrfToken, true, signal)) {
            log?.(`[Lite] Port: ${port}`);
            log?.('[Lite] TLS: true');
            log?.('[Lite] Discovery succeeded (HTTPS)');
            return {
                success: true,
                info: { pid, port, csrfToken, useTls: true },
                timestamp
            };
        }

        // Try HTTP fallback
        if (await probePort(port, csrfToken, false, signal)) {
            log?.(`[Lite] Port: ${port}`);
            log?.('[Lite] TLS: false');
            log?.('[Lite] Discovery succeeded (HTTP)');
            return {
                success: true,
                info: { pid, port, csrfToken, useTls: false },
                timestamp
            };
        }
    }

    const error = `Connect-RPC probe failed on all ports [${ports.join(', ')}] for PID ${pid}`;
    log?.(`[Lite] Error: ${error}`);
    return { success: false, error, failedStep: 'probe', timestamp };
}

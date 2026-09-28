import * as vscode from 'vscode';
import { discoverLanguageServer, DiscoveryResult, LSInfo } from './discovery';
import { getAllCascadeTrajectories, RpcError } from './rpc-client';
import {
    inspectActiveTrajectory,
    TrajectoryInspectionResult,
    ContextSnapshot,
    extractContextSnapshot,
    compareContextSnapshots
} from './tracker';
import { StatusBarManager } from './statusbar';

let outputChannel: vscode.OutputChannel;
let statusBar: StatusBarManager;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let abortController: AbortController | undefined;
let cachedLsInfo: LSInfo | null = null;
let lastSnapshot: ContextSnapshot | null = null;
let isDiscovering = false;

function log(msg: string): void {
    outputChannel.appendLine(msg);
}

/**
 * Execute discovery and Connect-RPC check, updating status bar and output channel.
 */
async function runDiscovery(showChannelOnFailure = false): Promise<DiscoveryResult> {
    if (isDiscovering) {
        return {
            success: false,
            error: 'Discovery already in progress',
            timestamp: new Date()
        };
    }

    isDiscovering = true;
    statusBar.setDiscovering();

    // Cancel any previous in-flight requests
    abortController?.abort();
    abortController = new AbortController();

    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString();

    try {
        const result = await discoverLanguageServer(workspaceUri, abortController.signal, log);

        if (!result.success || !result.info) {
            cachedLsInfo = null;
            statusBar.update({
                discoveryResult: result,
                failureCategory: 'discovery',
                errorMessage: result.error
            });
            if (showChannelOnFailure) {
                outputChannel.show(true);
            }
            return result;
        }

        cachedLsInfo = result.info;

        // Perform Connect-RPC call: GetAllCascadeTrajectories
        try {
            const resp = await getAllCascadeTrajectories(result.info, abortController.signal);
            const count = Object.keys(resp.trajectorySummaries ?? {}).length;

            log('[Lite] RPC connected');
            log('[Lite] GetAllCascadeTrajectories: OK');
            log(`[Lite] Trajectory count: ${count}`);

            // Inspect trajectories and active trajectory checkpoints safely (Phase 3-8)
            let inspectionResult: TrajectoryInspectionResult | null = null;
            try {
                const trackResult = await inspectActiveTrajectory(result.info, workspaceUri, abortController.signal, log);
                inspectionResult = trackResult.inspection;

                const currentSnapshot = extractContextSnapshot(trackResult.candidate, inspectionResult);
                if (lastSnapshot && currentSnapshot.estimatedInputTokens !== undefined) {
                    const change = compareContextSnapshots(lastSnapshot, currentSnapshot);
                    if (change.tokensTrend !== 'unknown') {
                        const sign = (change.tokensDelta ?? 0) > 0 ? '+' : '';
                        log(`[Lite] Context trend: ${change.tokensTrend} (${sign}${change.tokensDelta ?? 0} tokens)`);
                    }
                    if (change.maxTokensChanged) {
                        log(`[Lite] maxContextTokens changed: ${change.previousMaxTokens} -> ${change.currentMaxTokens}`);
                    }
                    if (change.modelIdChanged || change.modelLabelChanged) {
                        log(`[Lite] Model changed: ${change.previousModelLabel ?? change.previousModelId} -> ${change.currentModelLabel ?? change.currentModelId}`);
                    }
                }
                lastSnapshot = currentSnapshot;
            } catch (inspectErr) {
                log(`[Lite] Trajectory inspection note: ${(inspectErr as Error).message}`);
            }

            statusBar.update({
                discoveryResult: result,
                rpcSuccess: true,
                trajectoryCount: count,
                contextAnalysis: inspectionResult?.contextAnalysis ?? undefined
            });

            if (inspectionResult?.contextAnalysis?.contextPercent !== undefined) {
                const percentStr = `${inspectionResult.contextAnalysis.contextPercent}%`;
                const modelStr = inspectionResult.contextAnalysis.resolvedModelLabel
                    ? ` | ${inspectionResult.contextAnalysis.resolvedModelLabel}`
                    : '';
                log(`[Lite] Status bar display: 🧠 Context: ${percentStr}${modelStr}`);
            }
        } catch (rpcErr) {
            const err = rpcErr as Error;
            const isRpc = rpcErr instanceof RpcError;
            const failureCategory = isRpc && (rpcErr.kind === 'connection' || rpcErr.kind === 'timeout')
                ? 'rpc_connection'
                : 'rpc_response_parsing';

            log(`[Lite] GetAllCascadeTrajectories: FAILED (${err.message})`);

            statusBar.update({
                discoveryResult: result,
                rpcSuccess: false,
                failureCategory,
                errorMessage: err.message
            });

            if (showChannelOnFailure) {
                outputChannel.show(true);
            }
        }

        return result;
    } catch (e) {
        const error = (e as Error).message ?? 'Unknown error';
        log(`[Lite] Unexpected discovery exception: ${error}`);
        const failure: DiscoveryResult = {
            success: false,
            error,
            timestamp: new Date()
        };
        statusBar.update({
            discoveryResult: failure,
            failureCategory: 'discovery',
            errorMessage: error
        });
        return failure;
    } finally {
        isDiscovering = false;
    }
}

/**
 * Schedule periodic revalidation.
 */
function scheduleNextDiscovery(intervalMs = 15000): void {
    if (pollTimer) {
        clearTimeout(pollTimer);
    }
    pollTimer = setTimeout(async () => {
        await runDiscovery(false);
        scheduleNextDiscovery(intervalMs);
    }, intervalMs);
}

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('Antigravity Context Monitor Lite');
    statusBar = new StatusBarManager();

    context.subscriptions.push(outputChannel);
    context.subscriptions.push(statusBar);

    log('[Lite] Extension activated.');

    // Register refresh command
    const refreshCmd = vscode.commands.registerCommand(
        'antigravity-context-monitor-lite.refresh',
        async () => {
            log('[Lite] Manual refresh triggered.');
            await runDiscovery(true);
        }
    );
    context.subscriptions.push(refreshCmd);

    // Register diagnostic RPC test command
    const testRpcCmd = vscode.commands.registerCommand(
        'antigravity-context-monitor-lite.testRpc',
        async () => {
            log('[Lite] Diagnostic RPC command triggered.');
            outputChannel.show(true);
            await runDiscovery(true);
        }
    );
    context.subscriptions.push(testRpcCmd);

    // Initial discovery and RPC validation
    void runDiscovery().then(() => {
        scheduleNextDiscovery(15000);
    });
}

export function deactivate(): void {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
    }
    abortController?.abort();
    abortController = undefined;
    if (outputChannel) {
        log('[Lite] Extension deactivated.');
    }
}

/**
 * Exported for testing or Phase 3 consumers.
 */
export function getCachedLanguageServerInfo(): LSInfo | null {
    return cachedLsInfo;
}

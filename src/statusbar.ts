import * as vscode from 'vscode';
import { DiscoveryResult } from './discovery';
import { ContextAnalysisResult } from './tracker';

export type RpcStatusFailureCategory =
    | 'discovery'
    | 'rpc_connection'
    | 'rpc_response_parsing';

export interface StatusBarUpdateParams {
    discoveryResult: DiscoveryResult;
    rpcSuccess?: boolean;
    trajectoryCount?: number;
    failureCategory?: RpcStatusFailureCategory;
    errorMessage?: string;
    contextPercent?: number;
    modelLabel?: string;
    contextLimit?: number;
    lastEstimatedInputTokens?: number;
    trajectoryId?: string;
    observationTimestamp?: string;
    contextAnalysis?: ContextAnalysisResult;
}

export const DEFAULT_MAX_MODEL_LABEL_LENGTH = 35;

export interface FormatStatusBarTextOptions {
    contextPercent?: number;
    modelLabel?: string;
    maxModelLength?: number;
}

/**
 * Pure function to format status bar text.
 *
 * Rules:
 * 1. contextPercent + modelLabel -> "🧠 Context: 70.7% | Gemini 3.8 Flash (High)"
 * 2. contextPercent only -> "🧠 Context: 70.7%"
 * 3. No context info (or invalid percent) -> "🧠 RPC: OK"
 * 4. percent = 0 -> "🧠 Context: 0%"
 * 5. percent = 100 -> "🧠 Context: 100%"
 * 6. Model label longer than maxModelLength -> truncated with ellipsis
 */
export function formatStatusBarText(
    contextPercent?: number,
    modelLabel?: string,
    maxModelLength?: number
): string;
export function formatStatusBarText(options: FormatStatusBarTextOptions): string;
export function formatStatusBarText(
    arg1?: number | FormatStatusBarTextOptions,
    arg2?: string,
    arg3?: number
): string {
    let contextPercent: number | undefined;
    let modelLabel: string | undefined;
    let maxModelLength = DEFAULT_MAX_MODEL_LABEL_LENGTH;

    if (typeof arg1 === 'object' && arg1 !== null) {
        contextPercent = arg1.contextPercent;
        modelLabel = arg1.modelLabel;
        if (typeof arg1.maxModelLength === 'number' && arg1.maxModelLength > 0) {
            maxModelLength = arg1.maxModelLength;
        }
    } else {
        contextPercent = arg1;
        modelLabel = arg2;
        if (typeof arg3 === 'number' && arg3 > 0) {
            maxModelLength = arg3;
        }
    }

    // Validate contextPercent: must be a finite number >= 0
    if (
        contextPercent === undefined ||
        contextPercent === null ||
        typeof contextPercent !== 'number' ||
        !Number.isFinite(contextPercent) ||
        contextPercent < 0
    ) {
        return '🧠 RPC: OK';
    }

    // Format percent: round to 1 decimal place if it has more decimal places
    const roundedPercent = Math.round(contextPercent * 10) / 10;
    const formattedPercent = `${roundedPercent}%`;

    const trimmedModel = modelLabel?.trim();
    if (!trimmedModel) {
        return `🧠 Context: ${formattedPercent}`;
    }

    const safeModel = trimmedModel.length > maxModelLength
        ? `${trimmedModel.slice(0, Math.max(0, maxModelLength - 3))}...`
        : trimmedModel;

    return `🧠 Context: ${formattedPercent} | ${safeModel}`;
}

/**
 * Manages the Antigravity Context Monitor Lite status bar item.
 */
export class StatusBarManager {
    private item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            'antigravityContextMonitorLite',
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = 'antigravity-context-monitor-lite.refresh';
        this.setDiscovering();
        this.item.show();
    }

    /**
     * For testing/inspection: access the underlying status bar item.
     */
    public getItem(): vscode.StatusBarItem {
        return this.item;
    }

    /**
     * Show initial or pending discovery/RPC state.
     */
    public setDiscovering(): void {
        this.item.text = '$(sync~spin) RPC: ...';
        this.item.tooltip = 'Antigravity Context Monitor Lite: Connecting to Language Server...';
    }

    /**
     * Update status bar with the latest discovery and RPC results.
     */
    public update(params: StatusBarUpdateParams | DiscoveryResult): void {
        const updateParams: StatusBarUpdateParams = 'timestamp' in params
            ? { discoveryResult: params }
            : params;

        const { discoveryResult, rpcSuccess, trajectoryCount, failureCategory, errorMessage } = updateParams;
        const timeStr = discoveryResult.timestamp.toLocaleTimeString();

        // Condition for connected RPC:
        // 1. Language Server discovery succeeds.
        // 2. GetAllCascadeTrajectories succeeds.
        if (discoveryResult.success && discoveryResult.info && rpcSuccess) {
            const { pid, port, useTls } = discoveryResult.info;
            const contextPercent = updateParams.contextPercent ?? updateParams.contextAnalysis?.contextPercent;
            const modelLabel = updateParams.modelLabel ?? updateParams.contextAnalysis?.resolvedModelLabel;
            const contextLimit = updateParams.contextLimit ?? updateParams.contextAnalysis?.contextLimit;
            const currentTokens = updateParams.lastEstimatedInputTokens ?? updateParams.contextAnalysis?.lastEstimatedInputTokens;

            this.item.text = formatStatusBarText(contextPercent, modelLabel);
            this.item.color = undefined;

            const md = new vscode.MarkdownString();
            md.isTrusted = true;
            md.appendMarkdown('### 🧠 Antigravity Context Monitor Lite\n\n');
            md.appendMarkdown('- **Status:** Connected (`RPC: OK`)\n');
            md.appendMarkdown(`- **PID:** \`${pid}\`\n`);
            md.appendMarkdown(`- **Port:** \`${port}\`\n`);
            md.appendMarkdown(`- **TLS:** \`${useTls ? 'true (HTTPS)' : 'false (HTTP)'}\`\n`);
            if (trajectoryCount !== undefined) {
                md.appendMarkdown(`- **Trajectory Count:** \`${trajectoryCount}\`\n`);
            }
            if (contextPercent !== undefined) {
                md.appendMarkdown(`- **Context Utilization:** \`${contextPercent}%\`\n`);
            }
            if (currentTokens !== undefined && contextLimit !== undefined) {
                md.appendMarkdown(`- **Estimated Tokens:** \`${currentTokens.toLocaleString()} / ${contextLimit.toLocaleString()}\`\n`);
            } else if (currentTokens !== undefined) {
                md.appendMarkdown(`- **Estimated Tokens:** \`${currentTokens.toLocaleString()}\`\n`);
            } else if (contextLimit !== undefined) {
                md.appendMarkdown(`- **Context Limit:** \`${contextLimit.toLocaleString()}\`\n`);
            }
            const trajId = updateParams.trajectoryId ?? updateParams.contextAnalysis?.trajectoryId;
            if (trajId) {
                md.appendMarkdown(`- **Trajectory ID:** \`${trajId}\`\n`);
            }
            if (modelLabel) {
                md.appendMarkdown(`- **Model:** \`${modelLabel}\`\n`);
            }
            const obsTime = updateParams.observationTimestamp ?? updateParams.contextAnalysis?.lastObservationTimestamp;
            if (obsTime) {
                md.appendMarkdown(`- **Observation Timestamp:** \`${obsTime}\`\n`);
            }
            md.appendMarkdown(`- **Last Checked:** ${timeStr}\n\n`);
            md.appendMarkdown('---\n\n');
            md.appendMarkdown('*Click to refresh RPC connection*');
            this.item.tooltip = md;
            return;
        }

        // Failure state: 🧠 RPC: ?
        this.item.text = '🧠 RPC: ?';
        this.item.color = new vscode.ThemeColor('errorForeground');

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown('### 🧠 Antigravity Context Monitor Lite\n\n');
        md.appendMarkdown('- **Status:** Disconnected (`RPC: ?`)\n');

        // Distinguish the three failure types in tooltip:
        // 1. Language Server discovery failure
        // 2. RPC connection failure
        // 3. RPC response/parsing failure
        if (!discoveryResult.success || failureCategory === 'discovery') {
            md.appendMarkdown('- **Failure Category:** `Language Server discovery failure`\n');
            if (discoveryResult.failedStep) {
                md.appendMarkdown(`- **Failed Step:** \`${discoveryResult.failedStep}\`\n`);
            }
            if (discoveryResult.error) {
                md.appendMarkdown(`- **Error:** ${discoveryResult.error}\n`);
            }
        } else if (failureCategory === 'rpc_connection') {
            const { pid, port, useTls } = discoveryResult.info!;
            md.appendMarkdown('- **Failure Category:** `RPC connection failure`\n');
            md.appendMarkdown(`- **PID:** \`${pid}\`\n`);
            md.appendMarkdown(`- **Port:** \`${port}\`\n`);
            md.appendMarkdown(`- **TLS:** \`${useTls ? 'true (HTTPS)' : 'false (HTTP)'}\`\n`);
            if (errorMessage) {
                md.appendMarkdown(`- **Error:** ${errorMessage}\n`);
            }
        } else if (failureCategory === 'rpc_response_parsing') {
            const { pid, port, useTls } = discoveryResult.info!;
            md.appendMarkdown('- **Failure Category:** `RPC response/parsing failure`\n');
            md.appendMarkdown(`- **PID:** \`${pid}\`\n`);
            md.appendMarkdown(`- **Port:** \`${port}\`\n`);
            md.appendMarkdown(`- **TLS:** \`${useTls ? 'true (HTTPS)' : 'false (HTTP)'}\`\n`);
            if (errorMessage) {
                md.appendMarkdown(`- **Error:** ${errorMessage}\n`);
            }
        } else {
            // General RPC failure fallback
            md.appendMarkdown('- **Failure Category:** `RPC communication failure`\n');
            if (errorMessage) {
                md.appendMarkdown(`- **Error:** ${errorMessage}\n`);
            }
        }

        md.appendMarkdown(`- **Last Checked:** ${timeStr}\n\n`);
        md.appendMarkdown('---\n\n');
        md.appendMarkdown('*Click to retry*');
        this.item.tooltip = md;
    }

    public dispose(): void {
        this.item.dispose();
    }
}

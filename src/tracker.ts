/**
 * Antigravity Context Window Tracker — Phase 3
 *
 * Provides functions to:
 * 1. Select the candidate active trajectory based on workspace and status.
 * 2. Inspect trajectory steps and extract real modelUsage from checkpoints.
 */

import { LSInfo } from './discovery';
import {
    TrajectorySummaryItem,
    TrajectoryStep,
    ModelUsage,
    getAllCascadeTrajectories,
    getCascadeTrajectorySteps,
    GeneratorMetadataItem,
    ClientModelConfigItem,
    getCascadeTrajectoryGeneratorMetadata,
    getCascadeModelConfigData
} from './rpc-client';

export interface TrajectoryCandidate {
    cascadeId: string;
    summaryItem: TrajectorySummaryItem;
    reason: string;
}

export interface CheckpointModelUsageInfo {
    stepIndex: number;
    stepType: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    thinkingOutputTokens?: number;
    responseOutputTokens?: number;
    cacheReadTokens?: number;
    estimatedInputTokens?: number;
    cacheHit?: boolean;
    raw: ModelUsage;
}

export interface ModelUsageObservation {
    stepIndex: number;
    stepType: string;
    timestamp?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    responseOutputTokens?: number;
    cacheReadTokens?: number;
    thinkingOutputTokens?: number;
    apiProvider?: string;
    responseId?: string;
    estimatedInputTokens?: number;
    cacheHit?: boolean;
}

export interface ContextDecreaseEvent {
    stepIndex: number;
    previousStepIndex: number;
    currentTokens: number;
    previousTokens: number;
    delta: number;
    timestamp?: string;
    previousTimestamp?: string;
}

export interface ContextTimeSeriesEntry {
    stepIndex: number;
    timestamp?: string;
    inputTokens: number;
    cacheReadTokens: number;
    estimatedInputTokens: number;
    cacheHit: boolean;
    cacheReadDelta?: number;
    estimatedDelta?: number;
}

export interface ContextAnalysisResult {
    trajectoryId?: string;
    observationCount: number;
    minEstimatedInputTokens: number;
    maxEstimatedInputTokens: number;
    avgEstimatedInputTokens: number;
    medianEstimatedInputTokens: number;
    firstEstimatedInputTokens: number;
    lastEstimatedInputTokens: number;
    lastObservationTimestamp?: string;
    cacheHitCount: number;
    cacheMissCount: number;
    cacheHitEstimatedTokens: number[];
    cacheMissEstimatedTokens: number[];
    maxStepIndex: number;
    timeSeries: ContextTimeSeriesEntry[];
    contextLimit?: number;
    contextPercent?: number;
    resolvedModelLabel?: string;
    modelId?: string;
    decreaseCount?: number;
    decreases?: ContextDecreaseEvent[];
}

export interface TrajectoryInspectionResult {
    trajectoryId?: string;
    totalSteps: number;
    checkpointCount: number;
    modelUsageCheckpointCount: number;
    checkpoints: CheckpointModelUsageInfo[];
    plannerResponseModelUsages: CheckpointModelUsageInfo[];
    observations?: ModelUsageObservation[];
    contextAnalysis?: ContextAnalysisResult;
}

export interface ContextSnapshot {
    trajectoryId?: string;
    stepIndex?: number;
    estimatedInputTokens?: number;
    maxContextTokens?: number;
    contextPercent?: number;
    modelId?: string;
    resolvedModelLabel?: string;
    observationTimestamp?: string;
}

export type ContextTokensTrend = 'increase' | 'decrease' | 'same' | 'unknown';

export interface ContextChangeReport {
    previousTokens?: number;
    currentTokens?: number;
    tokensDelta?: number;
    tokensTrend: ContextTokensTrend;
    previousPercent?: number;
    currentPercent?: number;
    percentDelta?: number;
    previousMaxTokens?: number;
    currentMaxTokens?: number;
    maxTokensChanged: boolean;
    previousModelId?: string;
    currentModelId?: string;
    modelIdChanged: boolean;
    previousModelLabel?: string;
    currentModelLabel?: string;
    modelLabelChanged: boolean;
    trajectoryIdChanged: boolean;
}

/**
 * Normalize a URI for consistent workspace comparison.
 */
export function normalizeUri(uri: string): string {
    let normalized = uri;
    const remoteMatch = normalized.match(/^vscode-remote:\/\/[^/]+(\/.*)/);
    if (remoteMatch) {
        normalized = remoteMatch[1];
    }
    normalized = normalized.replace(/^file:\/\/\//, '/');
    normalized = normalized.replace(/^file:\/\//, '');
    try {
        normalized = decodeURIComponent(normalized);
    } catch {
        // Keep as-is if decoding fails
    }
    if (process.platform === 'win32') {
        normalized = normalized.replace(/^\/([a-zA-Z]:)/, '$1');
    }
    normalized = normalized.replace(/\/$/, '');
    if (process.platform === 'darwin' || process.platform === 'win32') {
        normalized = normalized.toLowerCase();
    }
    return normalized;
}

/**
 * Check whether a trajectory summary item belongs to the specified workspace URI.
 */
export function trajectoryMatchesWorkspace(item: TrajectorySummaryItem, workspaceUri: string): boolean {
    const normalizedWs = normalizeUri(workspaceUri);
    if (!item.workspaces || !Array.isArray(item.workspaces)) {
        return false;
    }
    return item.workspaces.some(w => {
        const uri = w.workspaceFolderAbsoluteUri;
        return uri ? normalizeUri(uri) === normalizedWs : false;
    });
}

type TrajectoryEntry = [string, TrajectorySummaryItem];

/**
 * Select the active trajectory candidate from GetAllCascadeTrajectories summaries.
 *
 * Selection hierarchy matching reference implementation:
 * 1. RUNNING trajectory in current workspace.
 * 2. RUNNING trajectory outside current workspace (cross-workspace tracking).
 * 3. Most recently modified trajectory in current workspace.
 * 4. Fallback: most recently modified trajectory globally.
 */
export function selectActiveTrajectory(
    summaries: Record<string, TrajectorySummaryItem>,
    workspaceUri?: string
): TrajectoryCandidate | null {
    const entries: TrajectoryEntry[] = Object.entries(summaries);
    if (entries.length === 0) {
        return null;
    }

    const inWorkspace: TrajectoryEntry[] = workspaceUri
        ? entries.filter(([_, item]) => trajectoryMatchesWorkspace(item, workspaceUri))
        : entries;

    // 1. RUNNING trajectory in current workspace
    if (inWorkspace.length > 0) {
        const runningInWs = inWorkspace.find(([_, item]) => item.status === 'CASCADE_RUN_STATUS_RUNNING');
        if (runningInWs) {
            const [cascadeId, summaryItem] = runningInWs;
            return {
                cascadeId,
                summaryItem,
                reason: 'RUNNING cascade in active workspace'
            };
        }
    }

    // 2. RUNNING trajectory outside current workspace
    const runningAnywhere = entries.find(([_, item]) => item.status === 'CASCADE_RUN_STATUS_RUNNING');
    if (runningAnywhere) {
        const [cascadeId, summaryItem] = runningAnywhere;
        return {
            cascadeId,
            summaryItem,
            reason: 'RUNNING cascade (cross-workspace)'
        };
    }

    // Sort helper: most recently modified first
    const sortByLastModified = (list: TrajectoryEntry[]): TrajectoryEntry[] => [...list].sort((a, b) => {
        const timeA = a[1].lastModifiedTime || '';
        const timeB = b[1].lastModifiedTime || '';
        return timeB.localeCompare(timeA);
    });

    // 3. Most recently modified in current workspace
    if (inWorkspace.length > 0) {
        const sortedInWs = sortByLastModified(inWorkspace);
        const [cascadeId, summaryItem] = sortedInWs[0];
        return {
            cascadeId,
            summaryItem,
            reason: 'most recently modified in active workspace'
        };
    }

    // 4. Most recently modified globally
    const sortedGlobal = sortByLastModified(entries);
    const [cascadeId, summaryItem] = sortedGlobal[0];
    return {
        cascadeId,
        summaryItem,
        reason: 'most recently modified globally (fallback)'
    };
}

/**
 * Safely parse numeric tokens from string or number field.
 */
export function parseTokenValue(val: unknown): number {
    if (typeof val === 'number') {
        return isNaN(val) ? 0 : val;
    }
    if (typeof val === 'string') {
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}

/**
 * Extract time-series modelUsage observations from trajectory steps.
 * Targets only CORTEX_STEP_TYPE_CHECKPOINT and CORTEX_STEP_TYPE_PLANNER_RESPONSE steps
 * with an existing metadata.modelUsage field.
 * Returns observations in step order (oldest to newest).
 */
export function extractModelUsageObservations(steps: TrajectoryStep[]): ModelUsageObservation[] {
    const observations: ModelUsageObservation[] = [];

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepType = step.type || '';

        const isTargetStep =
            stepType === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
            stepType === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' ||
            stepType.includes('CHECKPOINT') ||
            stepType.includes('PLANNER_RESPONSE');

        if (!isTargetStep) {
            continue;
        }

        const meta = step.metadata;
        const mu = meta?.modelUsage;
        if (!mu) {
            continue;
        }

        const timestamp =
            meta?.createdAt ||
            meta?.startedAt ||
            meta?.completedAt ||
            (typeof (step as Record<string, unknown>).timestamp === 'string'
                ? (step as Record<string, unknown>).timestamp as string
                : undefined);

        const responseId =
            (typeof mu.responseId === 'string' ? mu.responseId : undefined) ||
            (typeof meta?.responseId === 'string' ? meta.responseId : undefined);

        const apiProvider = mu.apiProvider || (typeof meta?.apiProvider === 'string' ? meta.apiProvider : undefined);

        const isPlannerResponse =
            stepType === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' ||
            stepType.includes('PLANNER_RESPONSE') ||
            stepType.includes('PLANNER');

        let estimatedInputTokens: number | undefined = undefined;
        let cacheHit: boolean | undefined = undefined;

        if (isPlannerResponse && mu.inputTokens !== undefined) {
            const inputVal = parseTokenValue(mu.inputTokens);
            const hasCacheRead = mu.cacheReadTokens !== undefined;
            const cacheVal = hasCacheRead ? parseTokenValue(mu.cacheReadTokens) : 0;
            estimatedInputTokens = inputVal + cacheVal;
            cacheHit = hasCacheRead && cacheVal > 0;
        }

        observations.push({
            stepIndex: i,
            stepType,
            timestamp,
            model: mu.model,
            inputTokens: mu.inputTokens !== undefined ? parseTokenValue(mu.inputTokens) : undefined,
            outputTokens: mu.outputTokens !== undefined ? parseTokenValue(mu.outputTokens) : undefined,
            responseOutputTokens: mu.responseOutputTokens !== undefined ? parseTokenValue(mu.responseOutputTokens) : undefined,
            cacheReadTokens: mu.cacheReadTokens !== undefined ? parseTokenValue(mu.cacheReadTokens) : undefined,
            thinkingOutputTokens: mu.thinkingOutputTokens !== undefined ? parseTokenValue(mu.thinkingOutputTokens) : undefined,
            apiProvider,
            responseId,
            estimatedInputTokens,
            cacheHit
        });
    }

    return observations;
}

/**
 * Inspect an array of trajectory steps and extract checkpoints and modelUsage.
 */
export function inspectTrajectorySteps(steps: TrajectoryStep[]): TrajectoryInspectionResult {
    let checkpointCount = 0;
    let modelUsageCheckpointCount = 0;
    const checkpoints: CheckpointModelUsageInfo[] = [];
    const plannerResponseModelUsages: CheckpointModelUsageInfo[] = [];

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepType = step.type || '';
        const meta = step.metadata;
        const mu = meta?.modelUsage;

        if (stepType === 'CORTEX_STEP_TYPE_CHECKPOINT' || stepType.includes('CHECKPOINT')) {
            checkpointCount++;
            if (mu) {
                modelUsageCheckpointCount++;
                checkpoints.push({
                    stepIndex: i,
                    stepType,
                    model: mu.model,
                    inputTokens: parseTokenValue(mu.inputTokens),
                    outputTokens: parseTokenValue(mu.outputTokens),
                    thinkingOutputTokens: mu.thinkingOutputTokens !== undefined ? parseTokenValue(mu.thinkingOutputTokens) : undefined,
                    responseOutputTokens: mu.responseOutputTokens !== undefined ? parseTokenValue(mu.responseOutputTokens) : undefined,
                    cacheReadTokens: mu.cacheReadTokens !== undefined ? parseTokenValue(mu.cacheReadTokens) : undefined,
                    raw: mu
                });
            }
        } else if (mu && (stepType === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || stepType.includes('PLANNER'))) {
            const inTok = parseTokenValue(mu.inputTokens);
            const hasCache = mu.cacheReadTokens !== undefined;
            const crTok = hasCache ? parseTokenValue(mu.cacheReadTokens) : undefined;
            const estTok = inTok + (crTok ?? 0);
            const hit = hasCache && (crTok ?? 0) > 0;

            plannerResponseModelUsages.push({
                stepIndex: i,
                stepType,
                model: mu.model,
                inputTokens: inTok,
                outputTokens: parseTokenValue(mu.outputTokens),
                thinkingOutputTokens: mu.thinkingOutputTokens !== undefined ? parseTokenValue(mu.thinkingOutputTokens) : undefined,
                responseOutputTokens: mu.responseOutputTokens !== undefined ? parseTokenValue(mu.responseOutputTokens) : undefined,
                cacheReadTokens: crTok,
                estimatedInputTokens: estTok,
                cacheHit: hit,
                raw: mu
            });
        }
    }

    const observations = extractModelUsageObservations(steps);
    const contextAnalysis = analyzeContextObservations(observations) ?? undefined;

    return {
        totalSteps: steps.length,
        checkpointCount,
        modelUsageCheckpointCount,
        checkpoints,
        plannerResponseModelUsages,
        observations,
        contextAnalysis
    };
}

/**
 * Format safe diagnostic logs for trajectory summaries as requested by Phase 3 Step 2.
 */
export function logSafeTrajectorySummaries(
    summaries: Record<string, TrajectorySummaryItem>,
    log: (msg: string) => void
): void {
    for (const [key, item] of Object.entries(summaries)) {
        log('[Lite] Trajectory:');
        log(`[Lite]   ID: ${key}`);
        log(`[Lite]   summary/title: ${item.summary || '(none)'}`);
        log(`[Lite]   created/updated time: created=${item.createdTime || 'unknown'}, updated=${item.lastModifiedTime || 'unknown'}`);
        log(`[Lite]   steps: ${item.stepCount ?? 0}`);
    }
}

/**
 * Format safe diagnostic logs for trajectory steps and modelUsage as requested by Phase 3 Step 4 & 5.
 */
export function logSafeStepInspection(
    cascadeId: string,
    inspection: TrajectoryInspectionResult,
    log: (msg: string) => void
): void {
    log(`[Lite] Active trajectory identified: ${cascadeId}`);
    log(`[Lite] Step count: ${inspection.totalSteps}`);
    log(`[Lite] Checkpoint count: ${inspection.checkpointCount}`);
    log(`[Lite] modelUsage checkpoints: ${inspection.modelUsageCheckpointCount}`);

    for (const cp of inspection.checkpoints) {
        log('[Lite] modelUsage checkpoint:');
        if (cp.model) {
            log(`[Lite]   model: ${cp.model}`);
        }
        log(`[Lite]   inputTokens: ${cp.inputTokens}`);
        log(`[Lite]   outputTokens: ${cp.outputTokens}`);
        if (cp.responseOutputTokens !== undefined) {
            log(`[Lite]   responseOutputTokens: ${cp.responseOutputTokens}`);
        }
        if (cp.cacheReadTokens !== undefined) {
            log(`[Lite]   cacheReadTokens: ${cp.cacheReadTokens}`);
        }
    }
}

/**
 * Format safe diagnostic logs for modelUsage observations as requested by Phase 4 Step 3.
 * Preserves chronological order (oldest to newest) and never logs personal info, conversation text, or CSRF tokens.
 */
export function logSafeObservations(
    observations: ModelUsageObservation[],
    log: (msg: string) => void
): void {
    log(`[Lite] modelUsage observations: ${observations.length}`);

    for (const obs of observations) {
        log('[Lite] Observation:');
        log(`[Lite]   step: ${obs.stepIndex}`);
        log(`[Lite]   type: ${obs.stepType}`);
        if (obs.timestamp) {
            log(`[Lite]   timestamp: ${obs.timestamp}`);
        }
        if (obs.model) {
            log(`[Lite]   model: ${obs.model}`);
        }
        if (obs.inputTokens !== undefined) {
            log(`[Lite]   inputTokens: ${obs.inputTokens}`);
        }
        if (obs.outputTokens !== undefined) {
            log(`[Lite]   outputTokens: ${obs.outputTokens}`);
        }
        if (obs.responseOutputTokens !== undefined) {
            log(`[Lite]   responseOutputTokens: ${obs.responseOutputTokens}`);
        }
        if (obs.cacheReadTokens !== undefined) {
            log(`[Lite]   cacheReadTokens: ${obs.cacheReadTokens}`);
        }
        if (obs.thinkingOutputTokens !== undefined) {
            log(`[Lite]   thinkingOutputTokens: ${obs.thinkingOutputTokens}`);
        }
        if (obs.apiProvider) {
            log(`[Lite]   apiProvider: ${obs.apiProvider}`);
        }
        if (obs.responseId) {
            log(`[Lite]   responseId: ${obs.responseId}`);
        }
    }
}

/**
 * Format safe diagnostic logs for context input observations as requested by Phase 5 Step 3.
 * Only logs planner response context inputs, with step, inputTokens, cacheReadTokens, estimatedInputTokens, cacheHit.
 * Never logs personal information, conversation text, or CSRF tokens.
 */
export function logSafeContextObservations(
    observations: ModelUsageObservation[],
    log: (msg: string) => void
): void {
    const contextObs = observations.filter(o => o.estimatedInputTokens !== undefined);
    log(`[Lite] Context input observations: ${contextObs.length}`);

    for (const obs of contextObs) {
        log('[Lite] Context Observation:');
        log(`[Lite]   step: ${obs.stepIndex}`);
        log(`[Lite]   inputTokens: ${obs.inputTokens ?? 0}`);
        log(`[Lite]   cacheReadTokens: ${obs.cacheReadTokens ?? 0}`);
        log(`[Lite]   estimatedInputTokens: ${obs.estimatedInputTokens}`);
        log(`[Lite]   cacheHit: ${obs.cacheHit ?? false}`);
    }
}

/**
 * Perform time-series analysis over planner response observations as requested by Phase 5 Step 5.
 */
export function analyzeContextObservations(
    observations: ModelUsageObservation[]
): ContextAnalysisResult | null {
    const contextObs = observations.filter(o => o.estimatedInputTokens !== undefined);
    if (contextObs.length === 0) {
        return null;
    }

    const timeSeries: ContextTimeSeriesEntry[] = [];
    const decreases: ContextDecreaseEvent[] = [];
    let prevCacheRead: number | undefined = undefined;
    let prevEstimated: number | undefined = undefined;
    let prevStepIndex: number | undefined = undefined;
    let prevTimestamp: string | undefined = undefined;

    for (const obs of contextObs) {
        const input = obs.inputTokens ?? 0;
        const cache = obs.cacheReadTokens ?? 0;
        const estimated = obs.estimatedInputTokens!;
        const hit = obs.cacheHit ?? false;

        let delta: number | undefined = undefined;
        if (hit && prevCacheRead !== undefined && cache !== prevCacheRead) {
            delta = cache - prevCacheRead;
        }
        if (hit) {
            prevCacheRead = cache;
        }

        let estimatedDelta: number | undefined = undefined;
        if (prevEstimated !== undefined) {
            estimatedDelta = estimated - prevEstimated;
            if (estimatedDelta < 0) {
                decreases.push({
                    stepIndex: obs.stepIndex,
                    previousStepIndex: prevStepIndex!,
                    currentTokens: estimated,
                    previousTokens: prevEstimated,
                    delta: estimatedDelta,
                    timestamp: obs.timestamp,
                    previousTimestamp: prevTimestamp
                });
            }
        }
        prevEstimated = estimated;
        prevStepIndex = obs.stepIndex;
        prevTimestamp = obs.timestamp;

        timeSeries.push({
            stepIndex: obs.stepIndex,
            timestamp: obs.timestamp,
            inputTokens: input,
            cacheReadTokens: cache,
            estimatedInputTokens: estimated,
            cacheHit: hit,
            cacheReadDelta: delta,
            estimatedDelta
        });
    }

    const estimatedList = timeSeries.map(t => t.estimatedInputTokens);
    const sorted = [...estimatedList].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const avg = Math.round(sum / sorted.length);

    let median: number;
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        median = Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    } else {
        median = sorted[mid];
    }

    const first = estimatedList[0];
    const last = estimatedList[estimatedList.length - 1];

    const cacheHitEntries = timeSeries.filter(t => t.cacheHit);
    const cacheMissEntries = timeSeries.filter(t => !t.cacheHit);

    const maxEntry = timeSeries.find(t => t.estimatedInputTokens === max);

    const lastObservationTimestamp = timeSeries[timeSeries.length - 1].timestamp;

    return {
        observationCount: timeSeries.length,
        minEstimatedInputTokens: min,
        maxEstimatedInputTokens: max,
        avgEstimatedInputTokens: avg,
        medianEstimatedInputTokens: median,
        firstEstimatedInputTokens: first,
        lastEstimatedInputTokens: last,
        lastObservationTimestamp,
        cacheHitCount: cacheHitEntries.length,
        cacheMissCount: cacheMissEntries.length,
        cacheHitEstimatedTokens: cacheHitEntries.map(e => e.estimatedInputTokens),
        cacheMissEstimatedTokens: cacheMissEntries.map(e => e.estimatedInputTokens),
        maxStepIndex: maxEntry ? maxEntry.stepIndex : timeSeries[timeSeries.length - 1].stepIndex,
        timeSeries,
        decreaseCount: decreases.length,
        decreases
    };
}

/**
 * Format safe diagnostic logs for context time-series analysis as requested by Phase 5 Step 5.
 */
export function logSafeContextAnalysis(
    analysis: ContextAnalysisResult,
    log: (msg: string) => void
): void {
    log('[Lite] Context Time-Series Analysis:');
    if (analysis.trajectoryId) {
        log(`[Lite]   Trajectory ID: ${analysis.trajectoryId}`);
    }
    log(`[Lite]   Observation count: ${analysis.observationCount}`);
    log(`[Lite]   First estimatedInputTokens: ${analysis.firstEstimatedInputTokens}`);
    log(`[Lite]   Last estimatedInputTokens: ${analysis.lastEstimatedInputTokens}`);
    if (analysis.lastObservationTimestamp) {
        log(`[Lite]   Observation timestamp: ${analysis.lastObservationTimestamp}`);
    }
    log(`[Lite]   Minimum: ${analysis.minEstimatedInputTokens}`);
    log(`[Lite]   Maximum: ${analysis.maxEstimatedInputTokens} (at step ${analysis.maxStepIndex})`);
    log(`[Lite]   Average: ${analysis.avgEstimatedInputTokens}`);
    log(`[Lite]   Median: ${analysis.medianEstimatedInputTokens}`);
    log(`[Lite]   Cache hits: ${analysis.cacheHitCount}`);
    log(`[Lite]   Cache misses: ${analysis.cacheMissCount}`);
    if (analysis.decreaseCount !== undefined && analysis.decreaseCount > 0) {
        log(`[Lite]   Context decreases observed: ${analysis.decreaseCount}`);
        if (analysis.decreases) {
            for (const dec of analysis.decreases) {
                log(`[Lite]     step ${dec.previousStepIndex} (${dec.previousTokens}) -> step ${dec.stepIndex} (${dec.currentTokens}), delta: ${dec.delta}`);
            }
        }
    }
    log('[Lite] Time-Series (step | input | cache | estimated | hit/miss):');
    for (const row of analysis.timeSeries) {
        const hitStr = row.cacheHit ? 'hit' : 'miss';
        const deltaStr = row.cacheReadDelta !== undefined ? ` (delta: ${row.cacheReadDelta > 0 ? '+' : ''}${row.cacheReadDelta})` : '';
        log(`[Lite]   step ${row.stepIndex.toString().padStart(3, ' ')} | input: ${row.inputTokens.toString().padStart(6, ' ')} | cache: ${row.cacheReadTokens.toString().padStart(6, ' ')} | estimated: ${row.estimatedInputTokens.toString().padStart(6, ' ')} | ${hitStr}${deltaStr}`);
    }
    if (analysis.contextLimit !== undefined) {
        log(`[Lite]   Effective context limit: ${analysis.contextLimit}`);
    }
    if (analysis.contextPercent !== undefined) {
        log(`[Lite]   Context utilization: ${analysis.contextPercent}%`);
    }
    if (analysis.resolvedModelLabel) {
        log(`[Lite]   Model: ${analysis.resolvedModelLabel}${analysis.modelId ? ` (${analysis.modelId})` : ''}`);
    }
}

/**
 * Safely calculate context window utilization percentage.
 *
 * Rules:
 * - If maxTokens is undefined, null, <= 0, NaN, or non-finite, returns undefined (no fake denominator).
 * - If tokens is negative, NaN, or non-finite, returns undefined.
 * - Otherwise returns percentage rounded to specified decimal places (default 1 decimal place).
 *
 * @param tokens Current token count (e.g. estimatedInputTokens)
 * @param maxTokens Maximum context window limit
 * @param decimalPlaces Number of decimal places to round (default 1)
 */
export function calculateContextPercent(
    tokens: number,
    maxTokens: number | undefined | null,
    decimalPlaces: number = 1
): number | undefined {
    if (maxTokens === undefined || maxTokens === null) {
        return undefined;
    }
    if (typeof tokens !== 'number' || typeof maxTokens !== 'number') {
        return undefined;
    }
    if (!Number.isFinite(tokens) || !Number.isFinite(maxTokens)) {
        return undefined;
    }
    if (tokens < 0 || maxTokens <= 0) {
        return undefined;
    }
    const factor = Math.pow(10, Math.max(0, decimalPlaces));
    const percent = (tokens / maxTokens) * 100;
    return Math.round(percent * factor) / factor;
}

/**
 * Extract the effective context window limit (maxContextTokens) from generator metadata items.
 * Inspects generatorMetadata in reverse order (newest invocation first) matching Antigravity IDE behavior.
 */
export function extractContextWindowLimit(
    generatorMetadatas?: GeneratorMetadataItem[]
): number | undefined {
    if (!generatorMetadatas || !Array.isArray(generatorMetadatas)) {
        return undefined;
    }
    for (let i = generatorMetadatas.length - 1; i >= 0; i--) {
        const item = generatorMetadatas[i];
        const maxTokens = item.chatModel?.chatStartMetadata?.contextWindowMetadata?.maxContextTokens;
        if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
            return maxTokens;
        }
    }
    return undefined;
}

/**
 * Extract active model identifier from generator metadata items (newest invocation first).
 */
export function extractActiveModelId(
    generatorMetadatas?: GeneratorMetadataItem[]
): string | undefined {
    if (!generatorMetadatas || !Array.isArray(generatorMetadatas)) {
        return undefined;
    }
    for (let i = generatorMetadatas.length - 1; i >= 0; i--) {
        const item = generatorMetadatas[i];
        const model = item.chatModel?.model;
        if (typeof model === 'string' && model.trim()) {
            return model.trim();
        }
    }
    return undefined;
}

/**
 * Resolve an internal model identifier (e.g. MODEL_PLACEHOLDER_M318) to a human-readable label
 * using clientModelConfigs from GetCascadeModelConfigData.
 */
export function resolveModelLabel(
    modelId: string | undefined,
    configs?: ClientModelConfigItem[]
): string | undefined {
    if (!modelId || !configs || !Array.isArray(configs)) {
        return undefined;
    }
    const matched = configs.find(c => c.modelOrAlias?.model === modelId || c.modelOrAlias?.alias === modelId);
    return matched?.label;
}

/**
 * Inspect active trajectory and its steps on a live Language Server.
 */
export async function inspectActiveTrajectory(
    info: LSInfo,
    workspaceUri?: string,
    signal?: AbortSignal,
    log?: (msg: string) => void
): Promise<{
    candidate: TrajectoryCandidate | null;
    inspection: TrajectoryInspectionResult | null;
}> {
    const resp = await getAllCascadeTrajectories(info, signal);
    const summaries = resp.trajectorySummaries ?? {};

    if (log) {
        logSafeTrajectorySummaries(summaries, log);
    }

    const candidate = selectActiveTrajectory(summaries, workspaceUri);
    if (!candidate) {
        log?.('[Lite] No active trajectory candidate identified');
        return { candidate: null, inspection: null };
    }

    try {
        const stepsResp = await getCascadeTrajectorySteps(info, candidate.cascadeId, signal);
        const steps = stepsResp.steps ?? [];
        const inspection = inspectTrajectorySteps(steps);
        inspection.trajectoryId = candidate.cascadeId;

        // Retrieve generator metadata and model configs if possible (Phase 6)
        try {
            const genMetaResp = await getCascadeTrajectoryGeneratorMetadata(info, candidate.cascadeId, signal);
            const genMetas = genMetaResp.generatorMetadata ?? [];
            const contextLimit = extractContextWindowLimit(genMetas);
            const modelId = extractActiveModelId(genMetas);

            let resolvedLabel: string | undefined = undefined;
            if (modelId) {
                try {
                    const modelConfigsResp = await getCascadeModelConfigData(info, signal);
                    resolvedLabel = resolveModelLabel(modelId, modelConfigsResp.clientModelConfigs);
                } catch {
                    // Non-fatal if model config data cannot be retrieved
                }
            }

            if (inspection.contextAnalysis) {
                inspection.contextAnalysis.trajectoryId = candidate.cascadeId;
                inspection.contextAnalysis.contextLimit = contextLimit;
                inspection.contextAnalysis.modelId = modelId;
                inspection.contextAnalysis.resolvedModelLabel = resolvedLabel;
                if (contextLimit !== undefined) {
                    inspection.contextAnalysis.contextPercent = calculateContextPercent(
                        inspection.contextAnalysis.lastEstimatedInputTokens,
                        contextLimit
                    );
                }
            }
        } catch {
            // Non-fatal if generator metadata is unavailable
        }

        if (log) {
            logSafeStepInspection(candidate.cascadeId, inspection, log);
            if (inspection.observations) {
                logSafeObservations(inspection.observations, log);
                logSafeContextObservations(inspection.observations, log);
            }
            if (inspection.contextAnalysis) {
                logSafeContextAnalysis(inspection.contextAnalysis, log);
            }
        }

        return { candidate, inspection };
    } catch (err) {
        const error = (err as Error).message;
        log?.(`[Lite] Failed to retrieve trajectory steps for ${candidate.cascadeId}: ${error}`);
        return { candidate, inspection: null };
    }
}

/**
 * Extract a structured ContextSnapshot representing current observation values.
 */
export function extractContextSnapshot(
    candidate?: TrajectoryCandidate | null,
    inspection?: TrajectoryInspectionResult | null
): ContextSnapshot {
    const analysis = inspection?.contextAnalysis;
    return {
        trajectoryId: candidate?.cascadeId ?? inspection?.trajectoryId,
        stepIndex: analysis?.maxStepIndex,
        estimatedInputTokens: analysis?.lastEstimatedInputTokens,
        maxContextTokens: analysis?.contextLimit,
        contextPercent: analysis?.contextPercent,
        modelId: analysis?.modelId,
        resolvedModelLabel: analysis?.resolvedModelLabel,
        observationTimestamp: analysis?.lastObservationTimestamp
    };
}

/**
 * Compare two consecutive ContextSnapshots and produce a factual change report.
 * Strictly records observed differences without speculating about unverified causes.
 */
export function compareContextSnapshots(
    prev: ContextSnapshot | undefined | null,
    curr: ContextSnapshot
): ContextChangeReport {
    const prevTokens = prev?.estimatedInputTokens;
    const currTokens = curr.estimatedInputTokens;
    let tokensDelta: number | undefined = undefined;
    let tokensTrend: ContextTokensTrend = 'unknown';

    if (currTokens !== undefined && prevTokens !== undefined) {
        tokensDelta = currTokens - prevTokens;
        if (tokensDelta > 0) {
            tokensTrend = 'increase';
        } else if (tokensDelta < 0) {
            tokensTrend = 'decrease';
        } else {
            tokensTrend = 'same';
        }
    } else if (currTokens !== undefined) {
        tokensTrend = 'unknown';
    }

    const prevPct = prev?.contextPercent;
    const currPct = curr.contextPercent;
    let percentDelta: number | undefined = undefined;
    if (currPct !== undefined && prevPct !== undefined) {
        percentDelta = Math.round((currPct - prevPct) * 10) / 10;
    }

    const prevMax = prev?.maxContextTokens;
    const currMax = curr.maxContextTokens;
    const maxTokensChanged = prevMax !== undefined && currMax !== undefined && prevMax !== currMax;

    const prevModel = prev?.modelId;
    const currModel = curr.modelId;
    const modelIdChanged = prevModel !== undefined && currModel !== undefined && prevModel !== currModel;

    const prevLabel = prev?.resolvedModelLabel;
    const currLabel = curr.resolvedModelLabel;
    const modelLabelChanged = prevLabel !== undefined && currLabel !== undefined && prevLabel !== currLabel;

    const prevTraj = prev?.trajectoryId;
    const currTraj = curr.trajectoryId;
    const trajectoryIdChanged = prevTraj !== undefined && currTraj !== undefined && prevTraj !== currTraj;

    return {
        previousTokens: prevTokens,
        currentTokens: currTokens,
        tokensDelta,
        tokensTrend,
        previousPercent: prevPct,
        currentPercent: currPct,
        percentDelta,
        previousMaxTokens: prevMax,
        currentMaxTokens: currMax,
        maxTokensChanged,
        previousModelId: prevModel,
        currentModelId: currModel,
        modelIdChanged,
        previousModelLabel: prevLabel,
        currentModelLabel: currLabel,
        modelLabelChanged,
        trajectoryIdChanged
    };
}


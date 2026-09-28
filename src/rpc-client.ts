import * as http from 'http';
import * as https from 'https';
import { LSInfo } from './discovery';

export const LANGUAGE_SERVER_SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService';
export const MAX_RPC_RESPONSE_BODY_SIZE = 50 * 1024 * 1024; // 50MB guard limit

export type RpcErrorKind = 'connection' | 'http' | 'parse' | 'timeout' | 'aborted';

/**
 * Custom error class for RPC failures with classification.
 */
export class RpcError extends Error {
    public readonly kind: RpcErrorKind;
    public readonly statusCode?: number;

    constructor(message: string, kind: RpcErrorKind, statusCode?: number) {
        super(message);
        this.name = 'RpcError';
        this.kind = kind;
        this.statusCode = statusCode;
    }
}

export interface RpcOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    maxBodySize?: number;
}

/**
 * Normalize an RPC endpoint path.
 * Prepends the LanguageServerService prefix if not already present.
 */
export function buildRpcPath(endpoint: string): string {
    const trimmed = endpoint.trim();
    if (trimmed.startsWith('/')) {
        return trimmed;
    }
    return `${LANGUAGE_SERVER_SERVICE_PREFIX}/${trimmed}`;
}

/**
 * Construct the full RPC URL for debugging or logging (never logging secrets).
 */
export function buildRpcUrl(info: Pick<LSInfo, 'port' | 'useTls'>, endpoint: string): string {
    const protocol = info.useTls ? 'https:' : 'http:';
    const path = buildRpcPath(endpoint);
    return `${protocol}//127.0.0.1:${info.port}${path}`;
}

/**
 * Build the required Connect-RPC headers.
 */
export function buildRpcHeaders(csrfToken: string, contentLength: number): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrfToken,
        'Content-Length': String(contentLength)
    };
}

/**
 * Return http or https transport based on useTls flag.
 */
export function getRpcTransport(useTls: boolean): typeof https | typeof http {
    return useTls ? https : http;
}

/**
 * Reusable Connect-RPC caller for the Antigravity Language Server.
 *
 * @param info Discovered Language Server connection info (pid, port, csrfToken, useTls)
 * @param endpoint RPC method name or relative path
 * @param requestBody JSON-serializable request payload
 * @param options Additional timeout, signal, or body limit settings
 */
export async function callRpc<TResponse = unknown>(
    info: LSInfo,
    endpoint: string,
    requestBody: unknown = {},
    options: RpcOptions = {}
): Promise<TResponse> {
    const { timeoutMs = 10000, signal, maxBodySize = MAX_RPC_RESPONSE_BODY_SIZE } = options;

    if (signal?.aborted) {
        throw new RpcError('RPC call aborted', 'aborted');
    }

    const postData = typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody ?? {});
    const postBuffer = Buffer.from(postData, 'utf-8');
    const path = buildRpcPath(endpoint);

    const requestOptions: https.RequestOptions = {
        hostname: '127.0.0.1',
        port: info.port,
        path,
        method: 'POST',
        headers: buildRpcHeaders(info.csrfToken, postBuffer.length),
        timeout: timeoutMs,
        rejectUnauthorized: false // Local Antigravity server uses self-signed certificate
    };

    return new Promise<TResponse>((resolve, reject) => {
        let settled = false;

        let onAbort: (() => void) | undefined;
        const cleanupAbort = () => {
            if (onAbort && signal) {
                signal.removeEventListener('abort', onAbort);
                onAbort = undefined;
            }
        };

        const safeResolve = (val: TResponse) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanupAbort();
            resolve(val);
        };

        const safeReject = (err: RpcError) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanupAbort();
            reject(err);
        };

        const transport = getRpcTransport(info.useTls);
        const req = transport.request(requestOptions, (res) => {
            let body = '';
            let receivedBytes = 0;

            res.on('data', (chunk: Buffer | string) => {
                const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
                receivedBytes += chunkBytes;
                if (receivedBytes > maxBodySize) {
                    req.destroy();
                    safeReject(new RpcError(`RPC response exceeded ${maxBodySize} bytes`, 'parse'));
                    return;
                }
                body += chunk;
            });

            res.on('error', (err: Error) => {
                safeReject(new RpcError(`RPC stream error: ${err.message}`, 'connection'));
            });

            res.on('end', () => {
                const statusCode = res.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    const snippet = body.slice(0, 200);
                    safeReject(new RpcError(`RPC HTTP ${statusCode}: ${snippet}`, 'http', statusCode));
                    return;
                }

                try {
                    const parsed = (body.length > 0 ? JSON.parse(body) : {}) as TResponse;
                    safeResolve(parsed);
                } catch (e) {
                    const snippet = body.slice(0, 200);
                    safeReject(new RpcError(`Failed to parse RPC response as JSON: ${(e as Error).message}. Body: ${snippet}`, 'parse'));
                }
            });
        });

        req.on('error', (err: Error) => {
            safeReject(new RpcError(`RPC connection error: ${err.message}`, 'connection'));
        });

        req.on('timeout', () => {
            req.destroy();
            safeReject(new RpcError(`RPC timeout after ${timeoutMs}ms`, 'timeout'));
        });

        if (signal) {
            onAbort = () => {
                req.destroy();
                safeReject(new RpcError('RPC call aborted', 'aborted'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }

        req.write(postBuffer);
        req.end();
    });
}

/**
 * Alias for callRpc matching reference naming conventions.
 */
export const rpcCall = callRpc;

/**
 * Trajectory summary shape returned by GetAllCascadeTrajectories.
 */
export interface TrajectorySummaryItem {
    summary?: string;
    stepCount?: number;
    status?: string;
    lastModifiedTime?: string;
    createdTime?: string;
    trajectoryId?: string;
    workspaces?: Array<{ workspaceFolderAbsoluteUri?: string; [key: string]: unknown }>;
    lastUserInputTime?: string;
    lastUserInputStepIndex?: number;
    trajectoryMetadata?: Record<string, unknown>;
    trajectoryType?: string;
    [key: string]: unknown;
}

export interface GetAllCascadeTrajectoriesResponse {
    trajectorySummaries?: Record<string, TrajectorySummaryItem>;
    [key: string]: unknown;
}

/**
 * Specific helper to call GetAllCascadeTrajectories Connect-RPC endpoint.
 */
export async function getAllCascadeTrajectories(
    info: LSInfo,
    signal?: AbortSignal
): Promise<GetAllCascadeTrajectoriesResponse> {
    return callRpc<GetAllCascadeTrajectoriesResponse>(
        info,
        'GetAllCascadeTrajectories',
        {},
        { signal }
    );
}

/**
 * Request payload for GetCascadeTrajectorySteps.
 */
export interface GetCascadeTrajectoryStepsRequest {
    cascadeId?: string;
    trajectoryId?: string;
    startIndex?: number;
    endIndex?: number;
    [key: string]: unknown;
}

/**
 * Model usage statistics reported by the Language Server.
 */
export interface ModelUsage {
    model?: string;
    inputTokens?: string | number;
    outputTokens?: string | number;
    thinkingOutputTokens?: string | number;
    responseOutputTokens?: string | number;
    cacheReadTokens?: string | number;
    apiProvider?: string;
    responseId?: string;
    [key: string]: unknown;
}

/**
 * Trajectory step metadata.
 */
export interface TrajectoryStepMetadata {
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
    generatorModel?: string;
    modelUsage?: ModelUsage;
    toolCallOutputTokens?: number;
    responseId?: string;
    apiProvider?: string;
    [key: string]: unknown;
}

/**
 * Individual step inside a trajectory.
 */
export interface TrajectoryStep {
    type?: string;
    status?: string;
    metadata?: TrajectoryStepMetadata;
    [key: string]: unknown;
}

/**
 * Response payload for GetCascadeTrajectorySteps.
 */
export interface GetCascadeTrajectoryStepsResponse {
    steps?: TrajectoryStep[];
    [key: string]: unknown;
}

/**
 * Helper to build the normalized request payload for GetCascadeTrajectorySteps.
 * Maps string trajectory/cascade ID to `{ cascadeId: id }` and ensures cascadeId is present.
 */
export function buildGetCascadeTrajectoryStepsRequest(
    trajectoryIdOrRequest: string | GetCascadeTrajectoryStepsRequest
): GetCascadeTrajectoryStepsRequest {
    if (typeof trajectoryIdOrRequest === 'string') {
        const id = trajectoryIdOrRequest.trim();
        return { cascadeId: id };
    }
    const payload: GetCascadeTrajectoryStepsRequest = { ...trajectoryIdOrRequest };
    if (!payload.cascadeId && payload.trajectoryId) {
        payload.cascadeId = payload.trajectoryId;
    }
    return payload;
}

/**
 * Call GetCascadeTrajectorySteps Connect-RPC endpoint.
 *
 * @param info Discovered Language Server connection info
 * @param trajectoryIdOrRequest Cascade ID or request payload object
 * @param signal Optional AbortSignal
 */
export async function getCascadeTrajectorySteps(
    info: LSInfo,
    trajectoryIdOrRequest: string | GetCascadeTrajectoryStepsRequest,
    signal?: AbortSignal
): Promise<GetCascadeTrajectoryStepsResponse> {
    const payload = buildGetCascadeTrajectoryStepsRequest(trajectoryIdOrRequest);
    return callRpc<GetCascadeTrajectoryStepsResponse>(
        info,
        'GetCascadeTrajectorySteps',
        payload,
        { signal }
    );
}

/**
 * Context window metadata reported by GetCascadeTrajectoryGeneratorMetadata.
 */
export interface ContextWindowMetadata {
    estimatedTokensUsed?: number;
    maxContextTokens?: number;
    tokenBreakdown?: {
        groups?: Array<{
            name?: string;
            numTokens?: number;
            tokens?: Array<{ name?: string; numTokens?: number }>;
        }>;
        totalTokens?: number;
    };
    [key: string]: unknown;
}

/**
 * Chat start metadata reported by GetCascadeTrajectoryGeneratorMetadata.
 */
export interface ChatStartMetadata {
    createdAt?: string;
    checkpointIndex?: number;
    timeSinceLastInvocation?: string;
    contextWindowMetadata?: ContextWindowMetadata;
    [key: string]: unknown;
}

/**
 * Chat model metadata inside GeneratorMetadataItem.
 */
export interface GeneratorChatModel {
    model?: string;
    usage?: ModelUsage;
    chatStartMetadata?: ChatStartMetadata;
    completionConfig?: {
        maxTokens?: string | number;
        temperature?: number;
        topK?: string | number;
        topP?: number;
        stopPatterns?: string[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/**
 * Generator metadata item in GetCascadeTrajectoryGeneratorMetadata.
 */
export interface GeneratorMetadataItem {
    stepIndices?: number[];
    chatModel?: GeneratorChatModel;
    [key: string]: unknown;
}

/**
 * Response payload for GetCascadeTrajectoryGeneratorMetadata.
 */
export interface GetCascadeTrajectoryGeneratorMetadataResponse {
    generatorMetadata?: GeneratorMetadataItem[];
    [key: string]: unknown;
}

/**
 * Call GetCascadeTrajectoryGeneratorMetadata Connect-RPC endpoint.
 */
export async function getCascadeTrajectoryGeneratorMetadata(
    info: LSInfo,
    cascadeId: string,
    signal?: AbortSignal
): Promise<GetCascadeTrajectoryGeneratorMetadataResponse> {
    return callRpc<GetCascadeTrajectoryGeneratorMetadataResponse>(
        info,
        'GetCascadeTrajectoryGeneratorMetadata',
        { cascadeId },
        { signal }
    );
}

/**
 * Client model configuration item in GetCascadeModelConfigData.
 */
export interface ClientModelConfigItem {
    label?: string;
    modelOrAlias?: {
        model?: string;
        alias?: string;
        [key: string]: unknown;
    };
    tagTitle?: string;
    tagDescription?: string;
    isRecommended?: boolean;
    quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/**
 * Response payload for GetCascadeModelConfigData.
 */
export interface GetCascadeModelConfigDataResponse {
    clientModelConfigs?: ClientModelConfigItem[];
    clientModelSorts?: unknown[];
    defaultOverrideModelConfig?: unknown;
    [key: string]: unknown;
}

/**
 * Call GetCascadeModelConfigData Connect-RPC endpoint.
 */
export async function getCascadeModelConfigData(
    info: LSInfo,
    signal?: AbortSignal
): Promise<GetCascadeModelConfigDataResponse> {
    return callRpc<GetCascadeModelConfigDataResponse>(
        info,
        'GetCascadeModelConfigData',
        {},
        { signal }
    );
}


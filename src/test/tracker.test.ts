import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    normalizeUri,
    trajectoryMatchesWorkspace,
    selectActiveTrajectory,
    parseTokenValue,
    inspectTrajectorySteps,
    extractModelUsageObservations,
    logSafeTrajectorySummaries,
    logSafeStepInspection,
    logSafeObservations,
    logSafeContextObservations,
    analyzeContextObservations,
    logSafeContextAnalysis,
    calculateContextPercent,
    extractContextWindowLimit,
    extractActiveModelId,
    resolveModelLabel,
    extractContextSnapshot,
    compareContextSnapshots,
    ContextSnapshot,
    ModelUsageObservation
} from '../tracker';
import { TrajectorySummaryItem, TrajectoryStep, GeneratorMetadataItem, ClientModelConfigItem } from '../rpc-client';

describe('Tracker Unit Tests', () => {
    describe('normalizeUri', () => {
        it('normalizes file URIs and Windows drive letters', () => {
            const u1 = normalizeUri('file:///c:/Users/test/workspace');
            const u2 = normalizeUri('file:///C%3A/Users/test/workspace/');
            assert.equal(u1, 'c:/users/test/workspace');
            assert.equal(u2, 'c:/users/test/workspace');
        });

        it('handles vscode-remote URIs', () => {
            const u = normalizeUri('vscode-remote://wsl+Ubuntu/home/user/project/');
            assert.equal(u, '/home/user/project');
        });
    });

    describe('trajectoryMatchesWorkspace', () => {
        it('returns true when workspaceFolderAbsoluteUri matches after normalization', () => {
            const item: TrajectorySummaryItem = {
                workspaces: [
                    { workspaceFolderAbsoluteUri: 'file:///c:/Users/test/Desktop/Antigravity%20Context%20Monitor%20Lite' }
                ]
            };
            const match = trajectoryMatchesWorkspace(item, 'file:///c%3A/Users/test/Desktop/Antigravity Context Monitor Lite/');
            assert.equal(match, true);
        });

        it('returns false when workspaceFolderAbsoluteUri differs or is missing', () => {
            const item: TrajectorySummaryItem = {
                workspaces: [
                    { workspaceFolderAbsoluteUri: 'file:///c:/other/project' }
                ]
            };
            const match = trajectoryMatchesWorkspace(item, 'file:///c:/workspace');
            assert.equal(match, false);
            assert.equal(trajectoryMatchesWorkspace({}, 'file:///c:/workspace'), false);
        });
    });

    describe('selectActiveTrajectory', () => {
        const summaries: Record<string, TrajectorySummaryItem> = {
            'traj-idle-ws': {
                summary: 'Idle in WS',
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-09-28T02:00:00Z',
                workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/ws' }]
            },
            'traj-running-ws': {
                summary: 'Running in WS',
                status: 'CASCADE_RUN_STATUS_RUNNING',
                lastModifiedTime: '2026-09-28T02:30:00Z',
                workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/ws' }]
            },
            'traj-other-ws': {
                summary: 'Other WS',
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: '2026-09-28T03:00:00Z',
                workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/other' }]
            }
        };

        it('prioritizes RUNNING trajectory in current workspace', () => {
            const candidate = selectActiveTrajectory(summaries, 'file:///c:/ws');
            assert.ok(candidate);
            assert.equal(candidate.cascadeId, 'traj-running-ws');
            assert.ok(candidate.reason.includes('RUNNING'));
        });

        it('falls back to most recently modified in workspace when none is running', () => {
            const idleSummaries: Record<string, TrajectorySummaryItem> = {
                'traj-old': {
                    summary: 'Old in WS',
                    status: 'CASCADE_RUN_STATUS_IDLE',
                    lastModifiedTime: '2026-09-28T01:00:00Z',
                    workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/ws' }]
                },
                'traj-new': {
                    summary: 'New in WS',
                    status: 'CASCADE_RUN_STATUS_IDLE',
                    lastModifiedTime: '2026-09-28T03:00:00Z',
                    workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/ws' }]
                }
            };
            const candidate = selectActiveTrajectory(idleSummaries, 'file:///c:/ws');
            assert.ok(candidate);
            assert.equal(candidate.cascadeId, 'traj-new');
        });

        it('returns null on empty summaries', () => {
            assert.equal(selectActiveTrajectory({}), null);
        });
    });

    describe('parseTokenValue', () => {
        it('parses numbers and strings', () => {
            assert.equal(parseTokenValue(123), 123);
            assert.equal(parseTokenValue('456'), 456);
            assert.equal(parseTokenValue('0'), 0);
            assert.equal(parseTokenValue(undefined), 0);
            assert.equal(parseTokenValue('invalid'), 0);
        });
    });

    describe('inspectTrajectorySteps', () => {
        it('extracts checkpoints and modelUsage values accurately', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_USER_INPUT'
                },
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M318',
                            inputTokens: '19268',
                            outputTokens: '143',
                            thinkingOutputTokens: '94',
                            responseOutputTokens: '49',
                            cacheReadTokens: '500'
                        }
                    }
                },
                {
                    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
                    metadata: {
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M50',
                            inputTokens: '1519',
                            outputTokens: '6',
                            responseOutputTokens: '6'
                        }
                    }
                }
            ];

            const res = inspectTrajectorySteps(steps);
            assert.equal(res.totalSteps, 3);
            assert.equal(res.checkpointCount, 1);
            assert.equal(res.modelUsageCheckpointCount, 1);

            assert.equal(res.checkpoints[0].stepIndex, 2);
            assert.equal(res.checkpoints[0].model, 'MODEL_PLACEHOLDER_M50');
            assert.equal(res.checkpoints[0].inputTokens, 1519);
            assert.equal(res.checkpoints[0].outputTokens, 6);
            assert.equal(res.checkpoints[0].responseOutputTokens, 6);

            assert.equal(res.plannerResponseModelUsages.length, 1);
            assert.equal(res.plannerResponseModelUsages[0].model, 'MODEL_PLACEHOLDER_M318');
            assert.equal(res.plannerResponseModelUsages[0].inputTokens, 19268);
            assert.equal(res.plannerResponseModelUsages[0].cacheReadTokens, 500);
        });
    });

    describe('safe diagnostic loggers', () => {
        it('logs summaries and step inspection without leaking sensitive fields', () => {
            const logged: string[] = [];
            const mockLog = (msg: string) => logged.push(msg);

            logSafeTrajectorySummaries({
                'traj-1': {
                    summary: 'Test Trajectory',
                    stepCount: 10,
                    createdTime: '2026-09-28T00:00:00Z',
                    lastModifiedTime: '2026-09-28T01:00:00Z'
                }
            }, mockLog);

            assert.ok(logged.some(l => l.includes('ID: traj-1')));
            assert.ok(logged.some(l => l.includes('summary/title: Test Trajectory')));

            logSafeStepInspection('traj-1', {
                totalSteps: 10,
                checkpointCount: 1,
                modelUsageCheckpointCount: 1,
                checkpoints: [{
                    stepIndex: 5,
                    stepType: 'CORTEX_STEP_TYPE_CHECKPOINT',
                    model: 'MODEL_PLACEHOLDER_M50',
                    inputTokens: 1500,
                    outputTokens: 10,
                    raw: {}
                }],
                plannerResponseModelUsages: []
            }, mockLog);

            assert.ok(logged.some(l => l.includes('Active trajectory identified: traj-1')));
            assert.ok(logged.some(l => l.includes('inputTokens: 1500')));
            assert.ok(logged.some(l => l.includes('outputTokens: 10')));
        });

        it('logs observations in exact format without leaking sensitive information', () => {
            const logged: string[] = [];
            const mockLog = (msg: string) => logged.push(msg);

            const observations: ModelUsageObservation[] = [
                {
                    stepIndex: 154,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    model: 'MODEL_PLACEHOLDER_M318',
                    inputTokens: 5132,
                    outputTokens: 154,
                    cacheReadTokens: 146981,
                    thinkingOutputTokens: 15
                }
            ];

            logSafeObservations(observations, mockLog);

            assert.ok(logged.includes('[Lite] modelUsage observations: 1'));
            assert.ok(logged.includes('[Lite] Observation:'));
            assert.ok(logged.includes('[Lite]   step: 154'));
            assert.ok(logged.includes('[Lite]   type: CORTEX_STEP_TYPE_PLANNER_RESPONSE'));
            assert.ok(logged.includes('[Lite]   model: MODEL_PLACEHOLDER_M318'));
            assert.ok(logged.includes('[Lite]   inputTokens: 5132'));
            assert.ok(logged.includes('[Lite]   outputTokens: 154'));
            assert.ok(logged.includes('[Lite]   cacheReadTokens: 146981'));
            assert.ok(logged.includes('[Lite]   thinkingOutputTokens: 15'));
        });
    });

    describe('extractModelUsageObservations (Phase 4)', () => {
        it('extracts modelUsage from CHECKPOINT step', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
                    metadata: {
                        createdAt: '2026-09-28T04:15:30Z',
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M50',
                            inputTokens: 1512,
                            outputTokens: 5,
                            responseOutputTokens: 5,
                            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                            responseId: 'resp-cp-1'
                        }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 1);
            assert.equal(obs[0].stepIndex, 0);
            assert.equal(obs[0].stepType, 'CORTEX_STEP_TYPE_CHECKPOINT');
            assert.equal(obs[0].timestamp, '2026-09-28T04:15:30Z');
            assert.equal(obs[0].model, 'MODEL_PLACEHOLDER_M50');
            assert.equal(obs[0].inputTokens, 1512);
            assert.equal(obs[0].outputTokens, 5);
            assert.equal(obs[0].responseOutputTokens, 5);
            assert.equal(obs[0].apiProvider, 'API_PROVIDER_GOOGLE_GEMINI');
            assert.equal(obs[0].responseId, 'resp-cp-1');
        });

        it('extracts modelUsage from PLANNER_RESPONSE step', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        createdAt: '2026-09-28T04:16:01Z',
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M318',
                            inputTokens: 5132,
                            outputTokens: 154,
                            responseOutputTokens: 139,
                            cacheReadTokens: 146981,
                            thinkingOutputTokens: 15,
                            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                            responseId: '7-i5ataDONSy2roPyPORsAQ'
                        }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 1);
            assert.equal(obs[0].stepIndex, 0);
            assert.equal(obs[0].stepType, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
            assert.equal(obs[0].timestamp, '2026-09-28T04:16:01Z');
            assert.equal(obs[0].model, 'MODEL_PLACEHOLDER_M318');
            assert.equal(obs[0].inputTokens, 5132);
            assert.equal(obs[0].outputTokens, 154);
            assert.equal(obs[0].responseOutputTokens, 139);
            assert.equal(obs[0].cacheReadTokens, 146981);
            assert.equal(obs[0].thinkingOutputTokens, 15);
            assert.equal(obs[0].apiProvider, 'API_PROVIDER_GOOGLE_GEMINI');
            assert.equal(obs[0].responseId, '7-i5ataDONSy2roPyPORsAQ');
        });

        it('converts numeric strings to number in observations', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M318',
                            inputTokens: '5132',
                            outputTokens: '154',
                            responseOutputTokens: '139',
                            cacheReadTokens: '146981',
                            thinkingOutputTokens: '15'
                        }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 1);
            assert.strictEqual(obs[0].inputTokens, 5132);
            assert.strictEqual(obs[0].outputTokens, 154);
            assert.strictEqual(obs[0].responseOutputTokens, 139);
            assert.strictEqual(obs[0].cacheReadTokens, 146981);
            assert.strictEqual(obs[0].thinkingOutputTokens, 15);
        });

        it('safely handles missing fields without crashing', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
                    metadata: {
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M50'
                        }
                    }
                },
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        modelUsage: {}
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 2);
            assert.equal(obs[0].stepIndex, 0);
            assert.equal(obs[0].model, 'MODEL_PLACEHOLDER_M50');
            assert.equal(obs[0].inputTokens, undefined);
            assert.equal(obs[0].cacheReadTokens, undefined);
            assert.equal(obs[0].timestamp, undefined);
            assert.equal(obs[0].responseId, undefined);

            assert.equal(obs[1].stepIndex, 1);
            assert.equal(obs[1].model, undefined);
            assert.equal(obs[1].inputTokens, undefined);
        });

        it('maintains multiple observations in step order (oldest to newest)', () => {
            const steps: TrajectoryStep[] = [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT' }, // 0
                {
                    type: 'CORTEX_STEP_TYPE_CHECKPOINT', // 1
                    metadata: {
                        modelUsage: { model: 'MODEL_PLACEHOLDER_M50', inputTokens: '100', outputTokens: '5' }
                    }
                },
                { type: 'CORTEX_STEP_TYPE_RUN_COMMAND' }, // 2
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', // 3
                    metadata: {
                        modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: '2000', outputTokens: '50' }
                    }
                },
                { type: 'CORTEX_STEP_TYPE_VIEW_FILE' }, // 4
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', // 5
                    metadata: {
                        modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: '3000', outputTokens: '80' }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 3);
            assert.equal(obs[0].stepIndex, 1);
            assert.equal(obs[0].stepType, 'CORTEX_STEP_TYPE_CHECKPOINT');
            assert.equal(obs[1].stepIndex, 3);
            assert.equal(obs[1].stepType, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
            assert.equal(obs[2].stepIndex, 5);
            assert.equal(obs[2].stepType, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');

            // Check inspectTrajectorySteps integrates observations
            const inspected = inspectTrajectorySteps(steps);
            assert.ok(inspected.observations);
            assert.equal(inspected.observations.length, 3);
            assert.equal(inspected.observations[0].stepIndex, 1);
            assert.equal(inspected.observations[2].stepIndex, 5);
        });

        it('ignores steps without modelUsage or non-target step types', () => {
            const steps: TrajectoryStep[] = [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT' },
                { type: 'CORTEX_STEP_TYPE_CONVERSATION_HISTORY' },
                { type: 'CORTEX_STEP_TYPE_RUN_COMMAND' },
                { type: 'CORTEX_STEP_TYPE_CHECKPOINT' }, // checkpoint without modelUsage
                { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' }, // planner response without modelUsage
                {
                    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                    metadata: {
                        modelUsage: { model: 'MODEL_OTHER' }
                    }
                } // non-target step with modelUsage
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 0);
        });
    });

    describe('Context Estimation & Analysis (Phase 5)', () => {
        it('calculates estimatedInputTokens = inputTokens + cacheReadTokens and sets cacheHit=true', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M318',
                            inputTokens: '2866',
                            cacheReadTokens: '28677',
                            outputTokens: '100'
                        }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 1);
            assert.equal(obs[0].inputTokens, 2866);
            assert.equal(obs[0].cacheReadTokens, 28677);
            assert.equal(obs[0].estimatedInputTokens, 31543);
            assert.equal(obs[0].cacheHit, true);
        });

        it('handles missing cacheReadTokens with estimatedInputTokens = inputTokens and cacheHit=false', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M318',
                            inputTokens: '35078',
                            outputTokens: '100'
                        }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 1);
            assert.equal(obs[0].inputTokens, 35078);
            assert.equal(obs[0].cacheReadTokens, undefined);
            assert.equal(obs[0].estimatedInputTokens, 35078);
            assert.equal(obs[0].cacheHit, false);
        });

        it('handles cacheReadTokens = 0 with estimatedInputTokens = inputTokens and cacheHit=false', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M318',
                            inputTokens: '25000',
                            cacheReadTokens: '0',
                            outputTokens: '50'
                        }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 1);
            assert.equal(obs[0].inputTokens, 25000);
            assert.equal(obs[0].cacheReadTokens, 0);
            assert.equal(obs[0].estimatedInputTokens, 25000);
            assert.equal(obs[0].cacheHit, false);
        });

        it('does not compute estimatedInputTokens for CHECKPOINT steps', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
                    metadata: {
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M50',
                            inputTokens: '1500',
                            outputTokens: '5'
                        }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 1);
            assert.equal(obs[0].inputTokens, 1500);
            assert.equal(obs[0].estimatedInputTokens, undefined);
            assert.equal(obs[0].cacheHit, undefined);
        });

        it('maintains estimatedInputTokens across multiple observations', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', // Step 0: Cache miss
                    metadata: {
                        modelUsage: { inputTokens: '20000' }
                    }
                },
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', // Step 1: Cache hit
                    metadata: {
                        modelUsage: { inputTokens: '4000', cacheReadTokens: '18000' }
                    }
                },
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', // Step 2: Cache hit
                    metadata: {
                        modelUsage: { inputTokens: '5000', cacheReadTokens: '22000' }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 3);
            assert.equal(obs[0].estimatedInputTokens, 20000);
            assert.equal(obs[0].cacheHit, false);

            assert.equal(obs[1].estimatedInputTokens, 22000);
            assert.equal(obs[1].cacheHit, true);

            assert.equal(obs[2].estimatedInputTokens, 27000);
            assert.equal(obs[2].cacheHit, true);
        });

        it('preserves backwards compatibility with all modelUsage fields', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        createdAt: '2026-09-28T04:16:01Z',
                        modelUsage: {
                            model: 'MODEL_PLACEHOLDER_M318',
                            inputTokens: '5000',
                            outputTokens: '150',
                            responseOutputTokens: '100',
                            thinkingOutputTokens: '50',
                            cacheReadTokens: '20000',
                            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                            responseId: 'test-resp-id'
                        }
                    }
                }
            ];

            const obs = extractModelUsageObservations(steps);
            assert.equal(obs.length, 1);
            assert.equal(obs[0].model, 'MODEL_PLACEHOLDER_M318');
            assert.equal(obs[0].inputTokens, 5000);
            assert.equal(obs[0].outputTokens, 150);
            assert.equal(obs[0].responseOutputTokens, 100);
            assert.equal(obs[0].thinkingOutputTokens, 50);
            assert.equal(obs[0].cacheReadTokens, 20000);
            assert.equal(obs[0].apiProvider, 'API_PROVIDER_GOOGLE_GEMINI');
            assert.equal(obs[0].responseId, 'test-resp-id');
            assert.equal(obs[0].estimatedInputTokens, 25000);
            assert.equal(obs[0].cacheHit, true);
        });

        it('logs safe context observations in specified format without sensitive leaks', () => {
            const logged: string[] = [];
            const mockLog = (msg: string) => logged.push(msg);

            const observations: ModelUsageObservation[] = [
                {
                    stepIndex: 34,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    inputTokens: 2866,
                    cacheReadTokens: 28677,
                    estimatedInputTokens: 31543,
                    cacheHit: true
                },
                {
                    stepIndex: 36,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    inputTokens: 35078,
                    cacheReadTokens: 0,
                    estimatedInputTokens: 35078,
                    cacheHit: false
                }
            ];

            logSafeContextObservations(observations, mockLog);

            assert.ok(logged.includes('[Lite] Context input observations: 2'));
            assert.ok(logged.includes('[Lite] Context Observation:'));
            assert.ok(logged.includes('[Lite]   step: 34'));
            assert.ok(logged.includes('[Lite]   inputTokens: 2866'));
            assert.ok(logged.includes('[Lite]   cacheReadTokens: 28677'));
            assert.ok(logged.includes('[Lite]   estimatedInputTokens: 31543'));
            assert.ok(logged.includes('[Lite]   cacheHit: true'));
            assert.ok(logged.includes('[Lite]   step: 36'));
            assert.ok(logged.includes('[Lite]   inputTokens: 35078'));
            assert.ok(logged.includes('[Lite]   cacheReadTokens: 0'));
            assert.ok(logged.includes('[Lite]   estimatedInputTokens: 35078'));
            assert.ok(logged.includes('[Lite]   cacheHit: false'));
        });

        it('correctly calculates statistics in analyzeContextObservations', () => {
            const observations: ModelUsageObservation[] = [
                {
                    stepIndex: 1,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    inputTokens: 20000,
                    estimatedInputTokens: 20000,
                    cacheHit: false
                },
                {
                    stepIndex: 3,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    inputTokens: 4000,
                    cacheReadTokens: 18000,
                    estimatedInputTokens: 22000,
                    cacheHit: true
                },
                {
                    stepIndex: 5,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    inputTokens: 3000,
                    cacheReadTokens: 22096,
                    estimatedInputTokens: 25096,
                    cacheHit: true
                },
                {
                    stepIndex: 7,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    inputTokens: 30000,
                    estimatedInputTokens: 30000,
                    cacheHit: false
                }
            ];

            const result = analyzeContextObservations(observations);
            assert.ok(result);
            assert.equal(result.observationCount, 4);
            assert.equal(result.firstEstimatedInputTokens, 20000);
            assert.equal(result.lastEstimatedInputTokens, 30000);
            assert.equal(result.minEstimatedInputTokens, 20000);
            assert.equal(result.maxEstimatedInputTokens, 30000);
            assert.equal(result.maxStepIndex, 7);
            assert.equal(result.cacheHitCount, 2);
            assert.equal(result.cacheMissCount, 2);
            // Values: [20000, 22000, 25096, 30000]
            // Sum = 97096. Avg = 97096 / 4 = 24274
            assert.equal(result.avgEstimatedInputTokens, 24274);
            // Median of 4 elements: (22000 + 25096) / 2 = 23548
            assert.equal(result.medianEstimatedInputTokens, 23548);

            // Check delta in timeSeries: 22096 - 18000 = 4096
            assert.equal(result.timeSeries[2].cacheReadDelta, 4096);
        });

        it('returns null on analyzeContextObservations with no context observations', () => {
            const result = analyzeContextObservations([]);
            assert.equal(result, null);
        });

        it('inspectTrajectorySteps populates contextAnalysis', () => {
            const steps: TrajectoryStep[] = [
                {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    metadata: {
                        modelUsage: {
                            inputTokens: '1000',
                            cacheReadTokens: '5000'
                        }
                    }
                }
            ];

            const res = inspectTrajectorySteps(steps);
            assert.ok(res.contextAnalysis);
            assert.equal(res.contextAnalysis.observationCount, 1);
            assert.equal(res.contextAnalysis.maxEstimatedInputTokens, 6000);
            assert.equal(res.plannerResponseModelUsages[0].estimatedInputTokens, 6000);
            assert.equal(res.plannerResponseModelUsages[0].cacheHit, true);
        });
    });

    describe('Context Window Upper Limit & Percent Calculation (Phase 6)', () => {
        describe('calculateContextPercent', () => {
            it('calculates expected percentage correctly with standard numbers', () => {
                assert.equal(calculateContextPercent(50000, 200000), 25);
                assert.equal(calculateContextPercent(87142, 256000, 1), 34);
                assert.equal(calculateContextPercent(87142, 256000, 2), 34.04);
            });

            it('returns 0 when current token count is 0', () => {
                assert.equal(calculateContextPercent(0, 256000), 0);
            });

            it('returns undefined when maxTokens is undefined or null', () => {
                assert.equal(calculateContextPercent(50000, undefined), undefined);
                assert.equal(calculateContextPercent(50000, null), undefined);
            });

            it('returns undefined when maxTokens is zero or negative', () => {
                assert.equal(calculateContextPercent(50000, 0), undefined);
                assert.equal(calculateContextPercent(50000, -200000), undefined);
            });

            it('returns undefined when tokens is negative', () => {
                assert.equal(calculateContextPercent(-1000, 200000), undefined);
            });

            it('returns undefined when tokens or maxTokens is NaN or Infinite', () => {
                assert.equal(calculateContextPercent(NaN, 200000), undefined);
                assert.equal(calculateContextPercent(50000, NaN), undefined);
                assert.equal(calculateContextPercent(Infinity, 200000), undefined);
                assert.equal(calculateContextPercent(50000, Infinity), undefined);
                assert.equal(calculateContextPercent(-Infinity, 200000), undefined);
            });

            it('returns undefined on malformed string or object input', () => {
                assert.equal(calculateContextPercent('50000' as any, 200000), undefined);
                assert.equal(calculateContextPercent(50000, '200000' as any), undefined);
                assert.equal(calculateContextPercent({} as any, 200000), undefined);
            });

            it('allows overflow percentages above 100%', () => {
                assert.equal(calculateContextPercent(300000, 200000), 150);
            });
        });

        describe('extractContextWindowLimit', () => {
            it('extracts maxContextTokens from generator metadata items', () => {
                const metadatas: GeneratorMetadataItem[] = [
                    {
                        stepIndices: [1, 2],
                        chatModel: {
                            model: 'MODEL_PLACEHOLDER_M318',
                            chatStartMetadata: {
                                contextWindowMetadata: {
                                    maxContextTokens: 256000
                                }
                            }
                        }
                    }
                ];
                assert.equal(extractContextWindowLimit(metadatas), 256000);
            });

            it('picks latest invocation limit when multiple invocations exist', () => {
                const metadatas: GeneratorMetadataItem[] = [
                    {
                        stepIndices: [1, 2],
                        chatModel: {
                            chatStartMetadata: {
                                contextWindowMetadata: {
                                    maxContextTokens: 128000
                                }
                            }
                        }
                    },
                    {
                        stepIndices: [3, 4],
                        chatModel: {
                            chatStartMetadata: {
                                contextWindowMetadata: {
                                    maxContextTokens: 256000
                                }
                            }
                        }
                    }
                ];
                assert.equal(extractContextWindowLimit(metadatas), 256000);
            });

            it('returns undefined for empty, missing, or invalid generator metadata', () => {
                assert.equal(extractContextWindowLimit([]), undefined);
                assert.equal(extractContextWindowLimit(undefined), undefined);
                assert.equal(extractContextWindowLimit([{ stepIndices: [1] }]), undefined);
                assert.equal(extractContextWindowLimit([{
                    chatModel: {
                        chatStartMetadata: {
                            contextWindowMetadata: { maxContextTokens: 0 }
                        }
                    }
                }]), undefined);
            });
        });

        describe('extractActiveModelId & resolveModelLabel', () => {
            it('extracts latest active model identifier', () => {
                const metadatas: GeneratorMetadataItem[] = [
                    { chatModel: { model: 'MODEL_PLACEHOLDER_M50' } },
                    { chatModel: { model: 'MODEL_PLACEHOLDER_M318' } }
                ];
                assert.equal(extractActiveModelId(metadatas), 'MODEL_PLACEHOLDER_M318');
            });

            it('resolves model ID to human-readable label from clientModelConfigs', () => {
                const configs: ClientModelConfigItem[] = [
                    { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' } },
                    { label: 'Gemini 3.7 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M298' } }
                ];
                assert.equal(resolveModelLabel('MODEL_PLACEHOLDER_M318', configs), 'Gemini 3.8 Flash (High)');
                assert.equal(resolveModelLabel('MODEL_PLACEHOLDER_M298', configs), 'Gemini 3.7 Flash (High)');
                assert.equal(resolveModelLabel('UNKNOWN_MODEL', configs), undefined);
                assert.equal(resolveModelLabel('MODEL_PLACEHOLDER_M318', undefined), undefined);
            });
        });
    });

    describe('Context Observation & Dynamics (Phase 8)', () => {
        it('1. tracks case where context usage increases across observations and snapshots', () => {
            const observations: ModelUsageObservation[] = [
                {
                    stepIndex: 2,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    timestamp: '2026-09-28T05:00:00Z',
                    inputTokens: 15000,
                    cacheReadTokens: 0,
                    estimatedInputTokens: 15000,
                    cacheHit: false
                },
                {
                    stepIndex: 4,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    timestamp: '2026-09-28T05:01:00Z',
                    inputTokens: 3000,
                    cacheReadTokens: 15000,
                    estimatedInputTokens: 18000,
                    cacheHit: true
                },
                {
                    stepIndex: 6,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    timestamp: '2026-09-28T05:02:00Z',
                    inputTokens: 4000,
                    cacheReadTokens: 18000,
                    estimatedInputTokens: 22000,
                    cacheHit: true
                }
            ];

            const analysis = analyzeContextObservations(observations);
            assert.ok(analysis);
            assert.equal(analysis.observationCount, 3);
            assert.equal(analysis.firstEstimatedInputTokens, 15000);
            assert.equal(analysis.lastEstimatedInputTokens, 22000);
            assert.equal(analysis.lastObservationTimestamp, '2026-09-28T05:02:00Z');

            // Time series step-by-step deltas
            assert.equal(analysis.timeSeries[0].estimatedDelta, undefined);
            assert.equal(analysis.timeSeries[1].estimatedDelta, 3000);
            assert.equal(analysis.timeSeries[2].estimatedDelta, 4000);
            assert.equal(analysis.decreaseCount, 0);
            assert.deepEqual(analysis.decreases, []);

            // Consecutive snapshot comparison
            const snap1: ContextSnapshot = {
                trajectoryId: 'traj-123',
                stepIndex: 4,
                estimatedInputTokens: 18000,
                maxContextTokens: 256000,
                contextPercent: 7.0,
                modelId: 'MODEL_PLACEHOLDER_M318',
                resolvedModelLabel: 'Gemini 3.8 Flash (High)',
                observationTimestamp: '2026-09-28T05:01:00Z'
            };
            const snap2: ContextSnapshot = {
                trajectoryId: 'traj-123',
                stepIndex: 6,
                estimatedInputTokens: 22000,
                maxContextTokens: 256000,
                contextPercent: 8.6,
                modelId: 'MODEL_PLACEHOLDER_M318',
                resolvedModelLabel: 'Gemini 3.8 Flash (High)',
                observationTimestamp: '2026-09-28T05:02:00Z'
            };

            const change = compareContextSnapshots(snap1, snap2);
            assert.equal(change.tokensTrend, 'increase');
            assert.equal(change.tokensDelta, 4000);
            assert.equal(change.previousTokens, 18000);
            assert.equal(change.currentTokens, 22000);
            assert.equal(change.percentDelta, 1.6);
            assert.equal(change.maxTokensChanged, false);
            assert.equal(change.modelIdChanged, false);
            assert.equal(change.trajectoryIdChanged, false);
        });

        it('2. tracks case where context usage stays the same across observations and snapshots', () => {
            const observations: ModelUsageObservation[] = [
                {
                    stepIndex: 10,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    timestamp: '2026-09-28T05:10:00Z',
                    inputTokens: 25000,
                    estimatedInputTokens: 25000,
                    cacheHit: false
                },
                {
                    stepIndex: 12,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    timestamp: '2026-09-28T05:11:00Z',
                    inputTokens: 0,
                    cacheReadTokens: 25000,
                    estimatedInputTokens: 25000,
                    cacheHit: true
                }
            ];

            const analysis = analyzeContextObservations(observations);
            assert.ok(analysis);
            assert.equal(analysis.timeSeries[1].estimatedDelta, 0);
            assert.equal(analysis.decreaseCount, 0);

            const snap1: ContextSnapshot = {
                estimatedInputTokens: 25000,
                maxContextTokens: 256000,
                contextPercent: 9.8,
                modelId: 'MODEL_PLACEHOLDER_M318',
                resolvedModelLabel: 'Gemini 3.8 Flash (High)'
            };
            const snap2: ContextSnapshot = {
                ...snap1
            };

            const change = compareContextSnapshots(snap1, snap2);
            assert.equal(change.tokensTrend, 'same');
            assert.equal(change.tokensDelta, 0);
            assert.equal(change.percentDelta, 0);
            assert.equal(change.maxTokensChanged, false);
            assert.equal(change.modelIdChanged, false);
        });

        it('3. detects case where context usage decreases, recording only empirical facts without speculating on cause', () => {
            const observations: ModelUsageObservation[] = [
                {
                    stepIndex: 8,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    timestamp: '2026-09-28T05:08:00Z',
                    inputTokens: 50000,
                    estimatedInputTokens: 50000,
                    cacheHit: false
                },
                {
                    stepIndex: 12,
                    stepType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    timestamp: '2026-09-28T05:12:00Z',
                    inputTokens: 30000,
                    estimatedInputTokens: 30000,
                    cacheHit: false
                }
            ];

            const analysis = analyzeContextObservations(observations);
            assert.ok(analysis);
            assert.equal(analysis.timeSeries[1].estimatedDelta, -20000);
            assert.equal(analysis.decreaseCount, 1);
            assert.ok(analysis.decreases);
            assert.equal(analysis.decreases.length, 1);

            const dec = analysis.decreases[0];
            // Only empirical facts recorded: step indices, tokens, delta, timestamps
            assert.equal(dec.previousStepIndex, 8);
            assert.equal(dec.stepIndex, 12);
            assert.equal(dec.previousTokens, 50000);
            assert.equal(dec.currentTokens, 30000);
            assert.equal(dec.delta, -20000);
            assert.equal(dec.previousTimestamp, '2026-09-28T05:08:00Z');
            assert.equal(dec.timestamp, '2026-09-28T05:12:00Z');

            // Snapshot comparison reflects decrease
            const snap1: ContextSnapshot = {
                stepIndex: 8,
                estimatedInputTokens: 50000,
                maxContextTokens: 256000,
                contextPercent: 19.5
            };
            const snap2: ContextSnapshot = {
                stepIndex: 12,
                estimatedInputTokens: 30000,
                maxContextTokens: 256000,
                contextPercent: 11.7
            };

            const change = compareContextSnapshots(snap1, snap2);
            assert.equal(change.tokensTrend, 'decrease');
            assert.equal(change.tokensDelta, -20000);
            assert.equal(change.percentDelta, -7.8);
        });

        it('4. tracks case where maxContextTokens remains unchanged', () => {
            const metadatas: GeneratorMetadataItem[] = [
                {
                    stepIndices: [1],
                    chatModel: {
                        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
                    }
                },
                {
                    stepIndices: [2],
                    chatModel: {
                        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
                    }
                }
            ];

            assert.equal(extractContextWindowLimit(metadatas), 256000);

            const snap1: ContextSnapshot = { maxContextTokens: 256000, estimatedInputTokens: 50000 };
            const snap2: ContextSnapshot = { maxContextTokens: 256000, estimatedInputTokens: 55000 };

            const change = compareContextSnapshots(snap1, snap2);
            assert.equal(change.maxTokensChanged, false);
            assert.equal(change.previousMaxTokens, 256000);
            assert.equal(change.currentMaxTokens, 256000);
        });

        it('5. tracks case where maxContextTokens changes (e.g. 128k to 256k) and updates context percentage', () => {
            const metadatas: GeneratorMetadataItem[] = [
                {
                    stepIndices: [1],
                    chatModel: {
                        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 128000 } }
                    }
                },
                {
                    stepIndices: [2],
                    chatModel: {
                        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } }
                    }
                }
            ];

            // Picks latest limit
            assert.equal(extractContextWindowLimit(metadatas), 256000);

            const snap1: ContextSnapshot = {
                estimatedInputTokens: 64000,
                maxContextTokens: 128000,
                contextPercent: calculateContextPercent(64000, 128000) // 50.0%
            };
            const snap2: ContextSnapshot = {
                estimatedInputTokens: 64000,
                maxContextTokens: 256000,
                contextPercent: calculateContextPercent(64000, 256000) // 25.0%
            };

            const change = compareContextSnapshots(snap1, snap2);
            assert.equal(change.maxTokensChanged, true);
            assert.equal(change.previousMaxTokens, 128000);
            assert.equal(change.currentMaxTokens, 256000);
            assert.equal(change.percentDelta, -25.0);
            assert.equal(change.currentPercent, 25.0);
        });

        it('6. tracks case where model ID changes and updates resolved model label and status bar', () => {
            const metadatas: GeneratorMetadataItem[] = [
                { chatModel: { model: 'MODEL_PLACEHOLDER_M318' } },
                { chatModel: { model: 'MODEL_PLACEHOLDER_M35' } }
            ];

            const activeModel = extractActiveModelId(metadatas);
            assert.equal(activeModel, 'MODEL_PLACEHOLDER_M35');

            const configs: ClientModelConfigItem[] = [
                { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' } },
                { label: 'Claude Sonnet 4.6 (Thinking)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M35' } }
            ];

            const label = resolveModelLabel(activeModel, configs);
            assert.equal(label, 'Claude Sonnet 4.6 (Thinking)');

            const snap1: ContextSnapshot = {
                modelId: 'MODEL_PLACEHOLDER_M318',
                resolvedModelLabel: 'Gemini 3.8 Flash (High)',
                contextPercent: 35.5
            };
            const snap2: ContextSnapshot = {
                modelId: 'MODEL_PLACEHOLDER_M35',
                resolvedModelLabel: label,
                contextPercent: 35.5
            };

            const change = compareContextSnapshots(snap1, snap2);
            assert.equal(change.modelIdChanged, true);
            assert.equal(change.modelLabelChanged, true);
            assert.equal(change.currentModelLabel, 'Claude Sonnet 4.6 (Thinking)');
        });

        it('7. handles case where model label cannot be obtained and falls back gracefully', () => {
            const configs: ClientModelConfigItem[] = [
                { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' } }
            ];

            // Unknown model ID
            assert.equal(resolveModelLabel('MODEL_UNKNOWN', configs), undefined);
            // Missing configs array
            assert.equal(resolveModelLabel('MODEL_PLACEHOLDER_M318', undefined), undefined);
            assert.equal(resolveModelLabel(undefined, configs), undefined);
        });

        it('8. handles case where contextPercent is undefined', () => {
            // Invalid/missing max tokens
            assert.equal(calculateContextPercent(50000, undefined), undefined);
            assert.equal(calculateContextPercent(50000, null), undefined);
            assert.equal(calculateContextPercent(50000, 0), undefined);
            assert.equal(calculateContextPercent(50000, -100), undefined);

            // Invalid tokens
            assert.equal(calculateContextPercent(-5, 256000), undefined);
            assert.equal(calculateContextPercent(NaN, 256000), undefined);
            assert.equal(calculateContextPercent(Infinity, 256000), undefined);
        });

        it('9. extracts all 6 observation properties in extractContextSnapshot', () => {
            const candidate = {
                cascadeId: 'traj-xyz-789',
                summaryItem: { status: 'CASCADE_RUN_STATUS_RUNNING' },
                reason: 'active workspace'
            };
            const inspection = {
                totalSteps: 10,
                checkpointCount: 2,
                modelUsageCheckpointCount: 2,
                checkpoints: [],
                plannerResponseModelUsages: [],
                contextAnalysis: {
                    trajectoryId: 'traj-xyz-789',
                    observationCount: 5,
                    minEstimatedInputTokens: 10000,
                    maxEstimatedInputTokens: 25000,
                    avgEstimatedInputTokens: 17500,
                    medianEstimatedInputTokens: 17500,
                    firstEstimatedInputTokens: 10000,
                    lastEstimatedInputTokens: 25000,
                    lastObservationTimestamp: '2026-09-28T05:30:00Z',
                    cacheHitCount: 3,
                    cacheMissCount: 2,
                    cacheHitEstimatedTokens: [],
                    cacheMissEstimatedTokens: [],
                    maxStepIndex: 9,
                    timeSeries: [],
                    contextLimit: 256000,
                    contextPercent: 9.8,
                    modelId: 'MODEL_PLACEHOLDER_M318',
                    resolvedModelLabel: 'Gemini 3.8 Flash (High)'
                }
            };

            const snap = extractContextSnapshot(candidate, inspection);
            assert.equal(snap.trajectoryId, 'traj-xyz-789');
            assert.equal(snap.estimatedInputTokens, 25000);
            assert.equal(snap.maxContextTokens, 256000);
            assert.equal(snap.contextPercent, 9.8);
            assert.equal(snap.resolvedModelLabel, 'Gemini 3.8 Flash (High)');
            assert.equal(snap.observationTimestamp, '2026-09-28T05:30:00Z');
        });

        it('10. logs context decreases and trajectory info in logSafeContextAnalysis', () => {
            const logged: string[] = [];
            const mockLog = (msg: string) => logged.push(msg);

            const analysis = {
                trajectoryId: 'traj-log-test',
                observationCount: 2,
                minEstimatedInputTokens: 30000,
                maxEstimatedInputTokens: 50000,
                avgEstimatedInputTokens: 40000,
                medianEstimatedInputTokens: 40000,
                firstEstimatedInputTokens: 50000,
                lastEstimatedInputTokens: 30000,
                lastObservationTimestamp: '2026-09-28T05:15:00Z',
                cacheHitCount: 1,
                cacheMissCount: 1,
                cacheHitEstimatedTokens: [],
                cacheMissEstimatedTokens: [],
                maxStepIndex: 8,
                timeSeries: [
                    { stepIndex: 8, inputTokens: 50000, cacheReadTokens: 0, estimatedInputTokens: 50000, cacheHit: false },
                    { stepIndex: 12, inputTokens: 30000, cacheReadTokens: 0, estimatedInputTokens: 30000, cacheHit: false, estimatedDelta: -20000 }
                ],
                contextLimit: 256000,
                contextPercent: 11.7,
                resolvedModelLabel: 'Gemini 3.8 Flash (High)',
                decreaseCount: 1,
                decreases: [
                    {
                        stepIndex: 12,
                        previousStepIndex: 8,
                        currentTokens: 30000,
                        previousTokens: 50000,
                        delta: -20000,
                        timestamp: '2026-09-28T05:15:00Z',
                        previousTimestamp: '2026-09-28T05:10:00Z'
                    }
                ]
            };

            logSafeContextAnalysis(analysis, mockLog);

            assert.ok(logged.includes('[Lite]   Trajectory ID: traj-log-test'));
            assert.ok(logged.includes('[Lite]   Observation timestamp: 2026-09-28T05:15:00Z'));
            assert.ok(logged.includes('[Lite]   Context decreases observed: 1'));
            assert.ok(logged.some(m => m.includes('step 8 (50000) -> step 12 (30000), delta: -20000')));
        });
    });
});


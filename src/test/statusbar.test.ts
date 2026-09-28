// Setup vscode mock before requiring statusbar
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const originalRequire = Module.prototype.require;

interface MockStatusBarItem {
    id?: string;
    alignment?: number;
    priority?: number;
    command?: string;
    text: string;
    tooltip?: any;
    color?: any;
    visible: boolean;
    show: () => void;
    hide: () => void;
    dispose: () => void;
}

let lastCreatedItem: MockStatusBarItem | null = null;

class MockMarkdownString {
    public value = '';
    public isTrusted = false;
    constructor(val?: string) {
        if (val) this.value = val;
    }
    public appendMarkdown(str: string): void {
        this.value += str;
    }
}

class MockThemeColor {
    constructor(public id: string) {}
}

Module.prototype.require = function (id: string) {
    if (id === 'vscode') {
        return {
            window: {
                createStatusBarItem: (idOrAlignment?: any, alignmentOrPriority?: any, priority?: any) => {
                    const item: MockStatusBarItem = {
                        id: typeof idOrAlignment === 'string' ? idOrAlignment : undefined,
                        alignment: typeof idOrAlignment === 'number' ? idOrAlignment : alignmentOrPriority,
                        priority: typeof alignmentOrPriority === 'number' ? alignmentOrPriority : priority,
                        text: '',
                        visible: false,
                        show() {
                            this.visible = true;
                        },
                        hide() {
                            this.visible = false;
                        },
                        dispose() {
                            this.visible = false;
                        }
                    };
                    lastCreatedItem = item;
                    return item;
                }
            },
            StatusBarAlignment: { Left: 1, Right: 2 },
            MarkdownString: MockMarkdownString,
            ThemeColor: MockThemeColor
        };
    }
    return originalRequire.apply(this, arguments);
};

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    formatStatusBarText,
    DEFAULT_MAX_MODEL_LABEL_LENGTH,
    StatusBarManager
} from '../statusbar';
import { DiscoveryResult } from '../discovery';

describe('StatusBar Unit Tests (Phase 7)', () => {
    describe('formatStatusBarText (Pure Function)', () => {
        it('1. formats contextPercent + modelLabel as "🧠 Context: 70.7% | Gemini 3.8 Flash (High)"', () => {
            const text = formatStatusBarText(70.7, 'Gemini 3.8 Flash (High)');
            assert.equal(text, '🧠 Context: 70.7% | Gemini 3.8 Flash (High)');
        });

        it('1b. supports options object syntax { contextPercent, modelLabel }', () => {
            const text = formatStatusBarText({
                contextPercent: 70.7,
                modelLabel: 'Gemini 3.8 Flash (High)'
            });
            assert.equal(text, '🧠 Context: 70.7% | Gemini 3.8 Flash (High)');
        });

        it('2. formats contextPercent only as "🧠 Context: 70.7%" when modelLabel is undefined', () => {
            const text = formatStatusBarText(70.7);
            assert.equal(text, '🧠 Context: 70.7%');
        });

        it('2b. formats contextPercent only when modelLabel is empty string or only whitespace', () => {
            assert.equal(formatStatusBarText(70.7, ''), '🧠 Context: 70.7%');
            assert.equal(formatStatusBarText(70.7, '   '), '🧠 Context: 70.7%');
        });

        it('3. falls back to "🧠 RPC: OK" when context info is missing (undefined, null, empty options)', () => {
            assert.equal(formatStatusBarText(), '🧠 RPC: OK');
            assert.equal(formatStatusBarText(undefined, 'Gemini 3.8 Flash (High)'), '🧠 RPC: OK');
            assert.equal(formatStatusBarText(null as any, 'Gemini 3.8 Flash (High)'), '🧠 RPC: OK');
            assert.equal(formatStatusBarText({}), '🧠 RPC: OK');
        });

        it('4. displays correctly when percent = 0 ("🧠 Context: 0%")', () => {
            assert.equal(formatStatusBarText(0), '🧠 Context: 0%');
            assert.equal(
                formatStatusBarText(0, 'Gemini 3.8 Flash (High)'),
                '🧠 Context: 0% | Gemini 3.8 Flash (High)'
            );
        });

        it('5. displays correctly when percent = 100 ("🧠 Context: 100%")', () => {
            assert.equal(formatStatusBarText(100), '🧠 Context: 100%');
            assert.equal(
                formatStatusBarText(100, 'Gemini 3.8 Flash (High)'),
                '🧠 Context: 100% | Gemini 3.8 Flash (High)'
            );
        });

        it('6. falls back to "🧠 RPC: OK" on invalid percent (negative, NaN, Infinity, non-number)', () => {
            assert.equal(formatStatusBarText(-1), '🧠 RPC: OK');
            assert.equal(formatStatusBarText(-0.1, 'Gemini 3.8 Flash (High)'), '🧠 RPC: OK');
            assert.equal(formatStatusBarText(NaN), '🧠 RPC: OK');
            assert.equal(formatStatusBarText(Infinity), '🧠 RPC: OK');
            assert.equal(formatStatusBarText(-Infinity), '🧠 RPC: OK');
            assert.equal(formatStatusBarText('70.7' as any), '🧠 RPC: OK');
            assert.equal(formatStatusBarText({ contextPercent: -5 }), '🧠 RPC: OK');
        });

        it('7. safely truncates long model names so the status bar does not break', () => {
            const longModel = 'Gemini 3.8 Flash Experimental Preview (Extreme Extended Mode)';
            const text = formatStatusBarText(70.7, longModel);
            assert.ok(text.startsWith('🧠 Context: 70.7% | '));
            assert.ok(text.endsWith('...'));
            // Check that the model portion does not exceed default max length (35 chars)
            const modelPart = text.replace('🧠 Context: 70.7% | ', '');
            assert.equal(modelPart.length, DEFAULT_MAX_MODEL_LABEL_LENGTH);
            assert.equal(modelPart, longModel.slice(0, DEFAULT_MAX_MODEL_LABEL_LENGTH - 3) + '...');
        });

        it('7b. supports custom maxModelLength in options or parameter', () => {
            const text = formatStatusBarText(70.7, 'Claude 3.7 Sonnet', 10);
            assert.equal(text, '🧠 Context: 70.7% | Claude ...');

            const textOpt = formatStatusBarText({
                contextPercent: 70.7,
                modelLabel: 'Claude 3.7 Sonnet',
                maxModelLength: 10
            });
            assert.equal(textOpt, '🧠 Context: 70.7% | Claude ...');
        });

        it('8. supports overflow context percentages above 100%', () => {
            const text = formatStatusBarText(105.2, 'Gemini 3.8 Flash (High)');
            assert.equal(text, '🧠 Context: 105.2% | Gemini 3.8 Flash (High)');
        });

        it('9. rounds fractional percents to 1 decimal place', () => {
            const text = formatStatusBarText(70.702734, 'Gemini 3.8 Flash (High)');
            assert.equal(text, '🧠 Context: 70.7% | Gemini 3.8 Flash (High)');
        });

        it('10. trims surrounding whitespace from modelLabel', () => {
            const text = formatStatusBarText(70.7, '   Gemini 3.8 Flash (High)   ');
            assert.equal(text, '🧠 Context: 70.7% | Gemini 3.8 Flash (High)');
        });
    });

    describe('StatusBarManager Integration', () => {
        const dummySuccessDiscovery: DiscoveryResult = {
            success: true,
            info: {
                pid: 1234,
                port: 5678,
                csrfToken: 'test-token',
                useTls: true
            },
            timestamp: new Date()
        };

        const dummyFailureDiscovery: DiscoveryResult = {
            success: false,
            error: 'Discovery connection refused',
            failedStep: 'process_discovery',
            timestamp: new Date()
        };

        it('initializes in discovering state', () => {
            const mgr = new StatusBarManager();
            const item = mgr.getItem();
            assert.equal(item.text, '$(sync~spin) RPC: ...');
            assert.ok(item.tooltip);
            mgr.dispose();
        });

        it('updates with contextPercent and modelLabel on successful discovery and RPC', () => {
            const mgr = new StatusBarManager();
            mgr.update({
                discoveryResult: dummySuccessDiscovery,
                rpcSuccess: true,
                trajectoryCount: 5,
                contextPercent: 70.7,
                modelLabel: 'Gemini 3.8 Flash (High)',
                contextLimit: 256000,
                lastEstimatedInputTokens: 180999
            });

            const item = mgr.getItem();
            assert.equal(item.text, '🧠 Context: 70.7% | Gemini 3.8 Flash (High)');
            assert.equal(item.color, undefined);
            assert.ok((item.tooltip as any)?.value?.includes('70.7%'));
            assert.ok((item.tooltip as any)?.value?.includes('180,999 / 256,000'));
            assert.ok((item.tooltip as any)?.value?.includes('Gemini 3.8 Flash (High)'));
            mgr.dispose();
        });

        it('updates with contextAnalysis object from tracker', () => {
            const mgr = new StatusBarManager();
            mgr.update({
                discoveryResult: dummySuccessDiscovery,
                rpcSuccess: true,
                trajectoryCount: 1,
                contextAnalysis: {
                    observationCount: 10,
                    minEstimatedInputTokens: 1000,
                    maxEstimatedInputTokens: 180999,
                    avgEstimatedInputTokens: 90000,
                    medianEstimatedInputTokens: 85000,
                    firstEstimatedInputTokens: 1000,
                    lastEstimatedInputTokens: 180999,
                    cacheHitCount: 8,
                    cacheMissCount: 2,
                    cacheHitEstimatedTokens: [],
                    cacheMissEstimatedTokens: [],
                    maxStepIndex: 10,
                    timeSeries: [],
                    contextLimit: 256000,
                    contextPercent: 70.7,
                    resolvedModelLabel: 'Gemini 3.8 Flash (High)'
                }
            });

            const item = mgr.getItem();
            assert.equal(item.text, '🧠 Context: 70.7% | Gemini 3.8 Flash (High)');
            mgr.dispose();
        });

        it('falls back to "🧠 Context: 70.7%" when modelLabel is unavailable', () => {
            const mgr = new StatusBarManager();
            mgr.update({
                discoveryResult: dummySuccessDiscovery,
                rpcSuccess: true,
                contextPercent: 70.7
            });

            const item = mgr.getItem();
            assert.equal(item.text, '🧠 Context: 70.7%');
            mgr.dispose();
        });

        it('falls back to "🧠 RPC: OK" when contextPercent is not available', () => {
            const mgr = new StatusBarManager();
            mgr.update({
                discoveryResult: dummySuccessDiscovery,
                rpcSuccess: true,
                trajectoryCount: 2
            });

            const item = mgr.getItem();
            assert.equal(item.text, '🧠 RPC: OK');
            mgr.dispose();
        });

        it('shows "🧠 RPC: ?" with error color on RPC failure', () => {
            const mgr = new StatusBarManager();
            mgr.update({
                discoveryResult: dummySuccessDiscovery,
                rpcSuccess: false,
                failureCategory: 'rpc_connection',
                errorMessage: 'ECONNREFUSED'
            });

            const item = mgr.getItem();
            assert.equal(item.text, '🧠 RPC: ?');
            assert.ok(item.color);
            assert.ok((item.tooltip as any)?.value?.includes('RPC connection failure'));
            mgr.dispose();
        });

        it('shows "🧠 RPC: ?" with error color on discovery failure', () => {
            const mgr = new StatusBarManager();
            mgr.update({
                discoveryResult: dummyFailureDiscovery,
                failureCategory: 'discovery'
            });

            const item = mgr.getItem();
            assert.equal(item.text, '🧠 RPC: ?');
            assert.ok(item.color);
            assert.ok((item.tooltip as any)?.value?.includes('Language Server discovery failure'));
            mgr.dispose();
        });

        it('Phase 8: displays trajectory ID and observation timestamp in tooltip', () => {
            const mgr = new StatusBarManager();
            mgr.update({
                discoveryResult: dummySuccessDiscovery,
                rpcSuccess: true,
                contextPercent: 38.6,
                modelLabel: 'Gemini 3.8 Flash (High)',
                trajectoryId: '3007716d-5dfd-4c1f-89e6-7cbc9317a967',
                observationTimestamp: '2026-09-28T05:20:00.000Z'
            });

            const item = mgr.getItem();
            assert.equal(item.text, '🧠 Context: 38.6% | Gemini 3.8 Flash (High)');
            const tooltipStr = (item.tooltip as any)?.value || '';
            assert.ok(tooltipStr.includes('**Trajectory ID:** `3007716d-5dfd-4c1f-89e6-7cbc9317a967`'));
            assert.ok(tooltipStr.includes('**Observation Timestamp:** `2026-09-28T05:20:00.000Z`'));
            mgr.dispose();
        });

        it('Phase 8: updates status bar text when model is switched', () => {
            const mgr = new StatusBarManager();
            mgr.update({
                discoveryResult: dummySuccessDiscovery,
                rpcSuccess: true,
                contextPercent: 25.0,
                modelLabel: 'Gemini 3.8 Flash (High)'
            });
            assert.equal(mgr.getItem().text, '🧠 Context: 25% | Gemini 3.8 Flash (High)');

            // Model switched to Claude Sonnet 4.6 (Thinking)
            mgr.update({
                discoveryResult: dummySuccessDiscovery,
                rpcSuccess: true,
                contextPercent: 25.0,
                modelLabel: 'Claude Sonnet 4.6 (Thinking)'
            });
            assert.equal(mgr.getItem().text, '🧠 Context: 25% | Claude Sonnet 4.6 (Thinking)');
            mgr.dispose();
        });
    });
});

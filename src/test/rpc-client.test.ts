import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as https from 'https';
import {
    buildRpcPath,
    buildRpcUrl,
    buildRpcHeaders,
    getRpcTransport,
    callRpc,
    getAllCascadeTrajectories,
    getCascadeTrajectorySteps,
    buildGetCascadeTrajectoryStepsRequest,
    getCascadeTrajectoryGeneratorMetadata,
    getCascadeModelConfigData,
    RpcError
} from '../rpc-client';

describe('Connect-RPC Client Unit Tests', () => {
    describe('buildRpcPath', () => {
        it('prefixes method name with LanguageServerService', () => {
            const p = buildRpcPath('GetAllCascadeTrajectories');
            assert.equal(p, '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories');
        });

        it('preserves paths that already start with slash', () => {
            const p = buildRpcPath('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories');
            assert.equal(p, '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories');
        });
    });

    describe('buildRpcUrl', () => {
        it('constructs HTTPS URL when useTls is true', () => {
            const url = buildRpcUrl({ port: 60261, useTls: true }, 'GetAllCascadeTrajectories');
            assert.equal(url, 'https://127.0.0.1:60261/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories');
        });

        it('constructs HTTP URL when useTls is false', () => {
            const url = buildRpcUrl({ port: 60262, useTls: false }, 'GetAllCascadeTrajectories');
            assert.equal(url, 'http://127.0.0.1:60262/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories');
        });

        it('handles custom endpoint path', () => {
            const url = buildRpcUrl({ port: 60261, useTls: true }, '/custom.Service/Method');
            assert.equal(url, 'https://127.0.0.1:60261/custom.Service/Method');
        });
    });

    describe('buildRpcHeaders', () => {
        it('includes required Connect-RPC and CSRF headers', () => {
            const headers = buildRpcHeaders('csrf-test-token', 55);
            assert.equal(headers['Content-Type'], 'application/json');
            assert.equal(headers['Connect-Protocol-Version'], '1');
            assert.equal(headers['x-codeium-csrf-token'], 'csrf-test-token');
            assert.equal(headers['Content-Length'], '55');
        });
    });

    describe('getRpcTransport', () => {
        it('selects https for TLS and http for non-TLS', () => {
            assert.equal(getRpcTransport(true).request, https.request);
            assert.equal(getRpcTransport(false).request, http.request);
        });
    });

    describe('callRpc execution & error handling', () => {
        it('successfully parses valid JSON response over HTTP', async () => {
            const server = http.createServer((req, res) => {
                assert.equal(req.method, 'POST');
                assert.equal(req.headers['connect-protocol-version'], '1');
                assert.equal(req.headers['x-codeium-csrf-token'], 'test-token');
                assert.equal(req.headers['content-type'], 'application/json');

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    trajectorySummaries: {
                        'session-1': { summary: 'Chat 1', stepCount: 5 }
                    }
                }));
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                const resp = await callRpc<{ trajectorySummaries: Record<string, { summary: string }> }>({
                    pid: 1000,
                    port: addr.port,
                    csrfToken: 'test-token',
                    useTls: false
                }, 'GetAllCascadeTrajectories');

                assert.ok(resp.trajectorySummaries['session-1']);
                assert.equal(resp.trajectorySummaries['session-1'].summary, 'Chat 1');
            } finally {
                server.close();
            }
        });

        it('handles non-2xx HTTP status codes as RpcError with kind http', async () => {
            const server = http.createServer((_req, res) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 'internal', message: 'Internal Server Error' }));
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                await assert.rejects(async () => {
                    await callRpc({
                        pid: 1000,
                        port: addr.port,
                        csrfToken: 'test-token',
                        useTls: false
                    }, 'GetAllCascadeTrajectories');
                }, (err: RpcError) => {
                    assert.equal(err.kind, 'http');
                    assert.equal(err.statusCode, 500);
                    return true;
                });
            } finally {
                server.close();
            }
        });

        it('handles invalid JSON responses as RpcError with kind parse', async () => {
            const server = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><head><title>Bad Gateway</title></head></html>');
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                await assert.rejects(async () => {
                    await callRpc({
                        pid: 1000,
                        port: addr.port,
                        csrfToken: 'test-token',
                        useTls: false
                    }, 'GetAllCascadeTrajectories');
                }, (err: RpcError) => {
                    assert.equal(err.kind, 'parse');
                    return true;
                });
            } finally {
                server.close();
            }
        });

        it('handles connection refusal on closed port as RpcError with kind connection', async () => {
            await assert.rejects(async () => {
                // Port 1 is reserved and closed on loopback
                await callRpc({
                    pid: 1000,
                    port: 1,
                    csrfToken: 'test-token',
                    useTls: false
                }, 'GetAllCascadeTrajectories', {}, { timeoutMs: 1000 });
            }, (err: RpcError) => {
                assert.equal(err.kind, 'connection');
                return true;
            });
        });

        it('handles request abortion via AbortSignal', async () => {
            const controller = new AbortController();
            controller.abort();

            await assert.rejects(async () => {
                await callRpc({
                    pid: 1000,
                    port: 8080,
                    csrfToken: 'test-token',
                    useTls: false
                }, 'GetAllCascadeTrajectories', {}, { signal: controller.signal });
            }, (err: RpcError) => {
                assert.equal(err.kind, 'aborted');
                return true;
            });
        });

        it('handles request timeout as RpcError with kind timeout', async () => {
            const server = http.createServer((_req, _res) => {
                // Deliberately never respond to trigger timeout
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                await assert.rejects(async () => {
                    await callRpc({
                        pid: 1000,
                        port: addr.port,
                        csrfToken: 'test-token',
                        useTls: false
                    }, 'GetAllCascadeTrajectories', {}, { timeoutMs: 100 });
                }, (err: RpcError) => {
                    assert.equal(err.kind, 'timeout');
                    return true;
                });
            } finally {
                server.close();
            }
        });

        it('getAllCascadeTrajectories helper formats request and returns parsed payload', async () => {
            const server = http.createServer((req, res) => {
                assert.equal(req.url, '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    trajectorySummaries: {
                        'session-xyz': { summary: 'Phase 2 Test', stepCount: 42 }
                    }
                }));
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                const resp = await getAllCascadeTrajectories({
                    pid: 1000,
                    port: addr.port,
                    csrfToken: 'test-token',
                    useTls: false
                });

                assert.ok(resp.trajectorySummaries);
                assert.equal(resp.trajectorySummaries['session-xyz'].stepCount, 42);
                assert.equal(resp.trajectorySummaries['session-xyz'].summary, 'Phase 2 Test');
            } finally {
                server.close();
            }
        });

        it('buildGetCascadeTrajectoryStepsRequest converts string to cascadeId payload', () => {
            const req = buildGetCascadeTrajectoryStepsRequest('traj-12345');
            assert.deepEqual(req, { cascadeId: 'traj-12345' });
        });

        it('buildGetCascadeTrajectoryStepsRequest falls back to trajectoryId if cascadeId omitted', () => {
            const req = buildGetCascadeTrajectoryStepsRequest({ trajectoryId: 'alt-id', startIndex: 5 });
            assert.equal(req.cascadeId, 'alt-id');
            assert.equal(req.startIndex, 5);
        });

        it('getCascadeTrajectorySteps sends correct path and headers and parses steps with modelUsage', async () => {
            let receivedBody = '';
            const server = http.createServer((req, res) => {
                assert.equal(req.method, 'POST');
                assert.equal(req.url, '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps');
                assert.equal(req.headers['connect-protocol-version'], '1');
                assert.equal(req.headers['x-codeium-csrf-token'], 'test-csrf');

                req.on('data', chunk => { receivedBody += chunk; });
                req.on('end', () => {
                    const parsedReq = JSON.parse(receivedBody);
                    assert.equal(parsedReq.cascadeId, 'traj-abc');

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        steps: [
                            {
                                type: 'CORTEX_STEP_TYPE_USER_INPUT',
                                status: 'CORTEX_STEP_STATUS_SUCCESS'
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
                        ]
                    }));
                });
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                const resp = await getCascadeTrajectorySteps({
                    pid: 1000,
                    port: addr.port,
                    csrfToken: 'test-csrf',
                    useTls: false
                }, 'traj-abc');

                assert.ok(resp.steps);
                assert.equal(resp.steps.length, 2);
                assert.equal(resp.steps[0].type, 'CORTEX_STEP_TYPE_USER_INPUT');
                assert.equal(resp.steps[1].type, 'CORTEX_STEP_TYPE_CHECKPOINT');
                assert.equal(resp.steps[1].metadata?.modelUsage?.model, 'MODEL_PLACEHOLDER_M50');
                assert.equal(resp.steps[1].metadata?.modelUsage?.inputTokens, '1519');
            } finally {
                server.close();
            }
        });

        it('getCascadeTrajectorySteps handles missing trajectory (HTTP 500) as RpcError', async () => {
            const server = http.createServer((_req, res) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: 'unknown',
                    message: 'trajectory not found (error ID: test-err-123)'
                }));
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                await assert.rejects(async () => {
                    await getCascadeTrajectorySteps({
                        pid: 1000,
                        port: addr.port,
                        csrfToken: 'test-csrf',
                        useTls: false
                    }, 'non-existent-trajectory-id');
                }, (err: RpcError) => {
                    assert.equal(err.kind, 'http');
                    assert.equal(err.statusCode, 500);
                    assert.ok(err.message.includes('trajectory not found'));
                    return true;
                });
            } finally {
                server.close();
            }
        });

        it('getCascadeTrajectorySteps handles malformed response as RpcError with kind parse', async () => {
            const server = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{ "steps": [ broken json ...');
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                await assert.rejects(async () => {
                    await getCascadeTrajectorySteps({
                        pid: 1000,
                        port: addr.port,
                        csrfToken: 'test-csrf',
                        useTls: false
                    }, 'any-id');
                }, (err: RpcError) => {
                    assert.equal(err.kind, 'parse');
                    return true;
                });
            } finally {
                server.close();
            }
        });

        it('getCascadeTrajectoryGeneratorMetadata sends cascadeId and parses generator metadata', async () => {
            let capturedUrl: string | undefined;
            let capturedBody: string = '';

            const server = http.createServer((req, res) => {
                capturedUrl = req.url;
                let data = '';
                req.on('data', chunk => { data += chunk; });
                req.on('end', () => {
                    capturedBody = data;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        generatorMetadata: [
                            {
                                stepIndices: [1, 2],
                                chatModel: {
                                    model: 'MODEL_PLACEHOLDER_M318',
                                    chatStartMetadata: {
                                        contextWindowMetadata: {
                                            maxContextTokens: 256000,
                                            estimatedTokensUsed: 50000
                                        }
                                    }
                                }
                            }
                        ]
                    }));
                });
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                const res = await getCascadeTrajectoryGeneratorMetadata({
                    pid: 1000,
                    port: addr.port,
                    csrfToken: 'test-csrf',
                    useTls: false
                }, 'test-cascade-id');

                assert.equal(capturedUrl, '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata');
                assert.deepEqual(JSON.parse(capturedBody), { cascadeId: 'test-cascade-id' });
                assert.ok(res.generatorMetadata);
                assert.equal(res.generatorMetadata.length, 1);
                assert.equal(res.generatorMetadata[0].chatModel?.model, 'MODEL_PLACEHOLDER_M318');
                assert.equal(res.generatorMetadata[0].chatModel?.chatStartMetadata?.contextWindowMetadata?.maxContextTokens, 256000);
            } finally {
                server.close();
            }
        });

        it('getCascadeModelConfigData calls GetCascadeModelConfigData and parses model configs', async () => {
            let capturedUrl: string | undefined;

            const server = http.createServer((req, res) => {
                capturedUrl = req.url;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    clientModelConfigs: [
                        {
                            label: 'Gemini 3.8 Flash (High)',
                            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' }
                        }
                    ]
                }));
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            const addr = server.address() as { port: number };

            try {
                const res = await getCascadeModelConfigData({
                    pid: 1000,
                    port: addr.port,
                    csrfToken: 'test-csrf',
                    useTls: false
                });

                assert.equal(capturedUrl, '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData');
                assert.ok(res.clientModelConfigs);
                assert.equal(res.clientModelConfigs.length, 1);
                assert.equal(res.clientModelConfigs[0].label, 'Gemini 3.8 Flash (High)');
                assert.equal(res.clientModelConfigs[0].modelOrAlias?.model, 'MODEL_PLACEHOLDER_M318');
            } finally {
                server.close();
            }
        });
    });
});

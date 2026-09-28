import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildWindowsExePath,
    extractWindowsPid,
    extractCsrfToken,
    extractWorkspaceId,
    selectMatchingProcessLine,
    netstatLineMatchesPid,
    extractPortFromNetstat,
    buildExpectedWorkspaceId
} from '../discovery';

describe('Discovery Unit Tests', () => {
    describe('buildWindowsExePath', () => {
        it('builds absolute path with Windows SystemRoot', () => {
            const exe = buildWindowsExePath('C:\\Windows', 'powershell');
            assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        });

        it('handles trailing slashes properly', () => {
            const exe = buildWindowsExePath('C:\\Windows\\', 'netstat');
            assert.equal(exe, 'C:\\Windows\\System32\\NETSTAT.EXE');
        });

        it('falls back to bare name if SystemRoot is empty', () => {
            const exe = buildWindowsExePath('', 'powershell');
            assert.equal(exe, 'powershell.exe');
        });
    });

    describe('extractWindowsPid', () => {
        it('extracts PID from PowerShell ConvertTo-Csv format', () => {
            const line = '"26252","\\"C:\\\\path\\\\language_server.exe\\" --csrf_token foo"';
            assert.equal(extractWindowsPid(line), 26252);
        });

        it('extracts PID from WMIC format', () => {
            const line = 'Node,"C:\\path\\language_server.exe --csrf_token foo",12345';
            assert.equal(extractWindowsPid(line), 12345);
        });

        it('returns null for header lines and empty input', () => {
            assert.equal(extractWindowsPid(''), null);
            assert.equal(extractWindowsPid('"ProcessId","CommandLine"'), null);
            assert.equal(extractWindowsPid('Node,CommandLine,ProcessId'), null);
        });
    });

    describe('extractCsrfToken', () => {
        it('extracts token after --csrf_token', () => {
            const line = 'exe --csrf_token 30480a91-aeb5-4a99-9867-64fa66ec56f2 --other arg';
            assert.equal(extractCsrfToken(line), '30480a91-aeb5-4a99-9867-64fa66ec56f2');
        });

        it('returns null when --csrf_token is missing', () => {
            const line = 'exe --extension_server_port 1234';
            assert.equal(extractCsrfToken(line), null);
        });
    });

    describe('selectMatchingProcessLine', () => {
        it('prefers new-style shared LS (without --workspace_id)', () => {
            const oldLine = '"2000","language_server_windows_x64.exe --csrf_token abc --workspace_id ws1"';
            const newLine = '"26252","language_server_windows_x64.exe --csrf_token def"';
            const selected = selectMatchingProcessLine([oldLine, newLine]);
            assert.equal(selected, newLine);
        });

        it('matches old-style LS by workspaceUri if available', () => {
            const uri = 'file:///c:/Users/test/project';
            const expectedId = buildExpectedWorkspaceId(uri);
            const line1 = `"1001","language_server.exe --workspace_id ${expectedId}"`;
            const line2 = '"1002","language_server.exe --workspace_id other_id"';
            const selected = selectMatchingProcessLine([line1, line2], uri);
            assert.equal(selected, line1);
        });

        it('returns null on empty candidates', () => {
            assert.equal(selectMatchingProcessLine([]), null);
        });
    });

    describe('netstatLineMatchesPid', () => {
        it('matches exact PID and rejects substring PID', () => {
            const line = '  TCP    127.0.0.1:60261    0.0.0.0:0    LISTENING    26252';
            assert.equal(netstatLineMatchesPid(line, 26252), true);
            assert.equal(netstatLineMatchesPid(line, 252), false);
            assert.equal(netstatLineMatchesPid(line, 6252), false);
        });

        it('rejects non-listening connections', () => {
            const line = '  TCP    127.0.0.1:51017    127.0.0.1:60259    ESTABLISHED    26252';
            assert.equal(netstatLineMatchesPid(line, 26252), false);
        });
    });

    describe('extractPortFromNetstat', () => {
        it('extracts port from loopback IPv4', () => {
            const line = '  TCP    127.0.0.1:60261    0.0.0.0:0    LISTENING    26252';
            assert.equal(extractPortFromNetstat(line), 60261);
        });

        it('extracts port from wildcard 0.0.0.0', () => {
            const line = '  TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    1000';
            assert.equal(extractPortFromNetstat(line), 8080);
        });

        it('extracts port from IPv6 loopback [::1]', () => {
            const line = '  TCP    [::1]:9090    0.0.0.0:0    LISTENING    1000';
            assert.equal(extractPortFromNetstat(line), 9090);
        });

        it('returns null for non-loopback reachable or malformed addresses', () => {
            const line = '  TCP    192.168.1.100:5050    0.0.0.0:0    LISTENING    1000';
            assert.equal(extractPortFromNetstat(line), null);
        });
    });
});

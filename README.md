# Antigravity Context Monitor Lite

A lightweight personal-use VS Code-compatible extension for Antigravity IDE (Windows).

## Current Status: Phase 2 Complete

**Phase 1 Goal:**
Detect the running Antigravity Language Server process on Windows and resolve:
1. Process ID (PID)
2. CSRF Token (`--csrf_token`)
3. Localhost Listening Port
4. HTTPS/TLS Requirement

**Phase 2 Goal:**
Implement a minimal Connect-RPC client to communicate with the discovered Language Server and successfully invoke `GetAllCascadeTrajectories`.

### Status Bar Indicator
- `🧠 RPC: OK` — Language server discovered AND `GetAllCascadeTrajectories` RPC call succeeded.
- `🧠 RPC: ?` — Discovery failed OR RPC connection/parsing failed.
- Tooltip displays rich Markdown diagnostics that clearly distinguish:
  - **Language Server discovery failure** (e.g. process not found, netstat failure)
  - **RPC connection failure** (e.g. socket refused, timeout)
  - **RPC response/parsing failure** (e.g. HTTP non-2xx status, invalid JSON)
- Clicking the status bar item immediately triggers re-discovery and RPC re-verification.

### Architecture
```text
src/
  ├── discovery.ts      # (Phase 1) Process, port, and TLS discovery
  ├── rpc-client.ts     # (Phase 2) Connect-RPC client (callRpc, getAllCascadeTrajectories)
  ├── statusbar.ts      # (Phase 2) Status bar indicator (🧠 RPC: OK / 🧠 RPC: ?) & diagnostics
  ├── extension.ts      # (Phase 2) Lifecycle, polling loop, diagnostic commands
  ├── tracker.ts        # (Phase 3 placeholder) Context window & token usage calculation
  └── test/
      ├── discovery.test.ts  # (Phase 1) Process/port parsing unit tests
      └── rpc-client.test.ts # (Phase 2) RPC URL, headers, transport, JSON parsing & error tests
```

## Development & Testing

### Compile
```bash
npm run compile
```

### Watch Mode
```bash
npm run watch
```

### Run Unit Tests
```bash
npm test
```

### Diagnostic Commands (Command Palette)
- `Antigravity Lite: Refresh Language Server Discovery & RPC` (`antigravity-context-monitor-lite.refresh`)
- `Antigravity Lite: Test RPC (GetAllCascadeTrajectories)` (`antigravity-context-monitor-lite.testRpc`)

Logs in Output Channel (`Antigravity Context Monitor Lite`):
```text
[Lite] Language Server found
[Lite] PID: 26252
[Lite] Port: 60261
[Lite] TLS: true
[Lite] RPC connected
[Lite] GetAllCascadeTrajectories: OK
[Lite] Trajectory count: 2
```
*(CSRF tokens are never logged)*

### Debug in Antigravity IDE / VS Code
Press `F5` (or use the Run & Debug panel and select **Run Extension**). An Extension Development Host window will launch with the extension activated.

# Antigravity Context Monitor Lite

A small personal VS Code extension for observing Antigravity Cascade context usage.

It displays the estimated current context usage and the active model in the VS Code Status Bar.

Example:

```text
🧠 Context: 63.9% | Gemini 3.8 Flash (High)
```

## What it does

- Detects the active Antigravity Cascade trajectory
- Retrieves estimated input token usage
- Retrieves the effective context window limit from Antigravity metadata
- Calculates current context usage percentage
- Resolves the active model ID to a model label
- Displays the result in the VS Code Status Bar
- Observes context usage changes between polling cycles

The main purpose is simple: to make the current Antigravity context usage visible while working, so it is easier to decide when continuing a conversation may no longer be desirable.

## Verified environment

This project was developed and tested on Windows with Antigravity.

At the time of testing:

- Effective context window: 256,000 tokens
- Highest observed context usage: 188,590 tokens (73.7%)
- Context decreases observed: 0
- Automated tests: 110 passed / 0 failed
- Observed sessions: 8
- Total observations: 517

The 256,000-token limit was obtained from Antigravity's own generator metadata rather than hardcoded in the extension.

These observations describe the behavior seen during testing. They do not establish how Antigravity handles context beyond the observed range.

## Important limitations

This project depends on undocumented/internal Antigravity interfaces.

Antigravity updates may change or remove these interfaces and cause the extension to stop working.

The project is primarily a personal technical experiment and is not intended to provide a compatibility or maintenance guarantee.

The observed behavior described above represents the tested environment and should not be interpreted as a guarantee of future Antigravity behavior.

## Platform

- Windows
- VS Code / Antigravity
- TypeScript

## Development

```text
npm install
npm test
npm run compile
```

## License

This project is currently provided without a license.

# Antigravity Context Monitor Lite

A small personal-use extension for **Antigravity** that displays estimated Cascade context usage and the active model in the Status Bar.

Example:

```text
🧠 Context: 63.9% | Gemini 3.8 Flash (High)
```

## About this project

This is a **personal-use project** that I built for my own Antigravity workflow.

It is published on GitHub simply because I thought the implementation and technical investigation might be useful or interesting to others.

This is **not intended to be a maintained or production-ready extension**.

The extension relies on undocumented/internal Antigravity interfaces. If Antigravity or its underlying Gemini-related implementation changes, this extension may stop working at any time.

There is no guarantee of compatibility with future versions of Antigravity.

## What it does

- Detects the active Antigravity Cascade trajectory
- Retrieves estimated input token usage
- Retrieves the effective context window limit from Antigravity metadata
- Calculates current context usage percentage
- Resolves the active model ID to a model label
- Displays the result in the Antigravity Status Bar
- Observes context usage changes between polling cycles

The main purpose is simple: to make the current Antigravity context usage visible while working, so it is easier to decide when continuing a conversation may no longer be desirable.

## Verified environment

This project was developed and tested **only with Antigravity on Windows**.

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

**Antigravity is the only environment in which this extension has been tested.**

It has **not been tested with standard Visual Studio Code or other editors/environments**, and compatibility with them is not guaranteed.

Antigravity updates may change or remove the internal interfaces used by this extension and cause it to stop working.

Changes to the underlying Gemini models or Antigravity's internal implementation may also affect its behavior.

The project is primarily a personal technical experiment and is not intended to provide a compatibility or maintenance guarantee.

No ongoing maintenance or support is promised.

The observed behavior described above represents the tested environment and should not be interpreted as a guarantee of future Antigravity behavior.

## Platform

- Windows
- Antigravity
- TypeScript

**Tested only with Antigravity.**

## Development

```text
npm install
npm test
npm run compile
```

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

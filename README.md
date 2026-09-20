# pi-jev-tool-guard

Context-aware safeguards for [Pi](https://github.com/earendil-works/pi-mono)
tool calls, powered by TypeSafe Jev.

The extension intercepts `bash`, `write`, and `edit` immediately before Pi
executes them. It sends a bounded, redacted view of the current objective,
recent conversation, and pending call to Jev. Low-risk calls continue; risky
calls require confirmation. In headless modes, risky calls are blocked by
default.

![Tool Guard pausing a high-risk shell command and showing Jev's risk assessment before execution](docs/images/tool-guard-confirmation.png)

## Install

From npm:

```bash
pi install npm:pi-jev-tool-guard@0.1.0
```

Or from the Git repository:

```bash
pi install git:github.com/BubbatheVTOG/pi-jev-tool-guard@v0.1.0
```

Set the TypeSafe credential in the environment that starts Pi:

```bash
export TYPESAFE_API_KEY="..."
```

Credentials are never read from or written to Pi settings. If the key is
missing, authentication fails, Jev times out, or its response is invalid, the
default policy **fails open**: the call proceeds and Pi reports that Jev
enforcement is inactive.

## Behavior

Jev evaluates independent risks in one request:

- conflict with the user's objective;
- excessive scope;
- sensitive data or credential exposure;
- destructive changes;
- external, shared, published, or privileged impact;
- difficult recovery;
- overall consequence severity.

The extension owns the control flow and thresholds. Jev returns typed
probabilities; it does not execute tools or generate permission decisions.

A successful risky assessment:

- prompts in TUI and RPC modes;
- blocks in print and JSON modes unless `headlessRisk` is overridden;
- returns a sanitized reason to the agent when denied.

## Commands

```text
/tool-guard status
/tool-guard edit-global
/tool-guard edit-project
```

`status` shows the effective policy and whether each value came from plugin
defaults, global settings, or trusted-project settings. Editing opens only the
`toolGuard` override object, validates it, requests confirmation, and atomically
updates `settings.json` while preserving unrelated Pi settings. Project edits
require a trusted project.

New tool calls read settings immediately; a Pi reload is not required for policy
changes.

## Settings

The plugin contains a complete default policy. Add only the values you want to
override:

```json
{
  "toolGuard": {
    "timeoutMs": 3000,
    "thresholds": {
      "reviewProbability": 0.4
    }
  }
}
```

Built-in defaults:

```json
{
  "toolGuard": {
    "disable": false,
    "enabled": true,
    "protectedTools": ["bash", "write", "edit"],
    "model": "jev-latest",
    "timeoutMs": 2000,
    "evaluatorFailure": "allow",
    "headlessRisk": "block",
    "thresholds": {
      "reviewProbability": 0.35,
      "highRiskProbability": 0.7,
      "severityReview": 1
    },
    "context": {
      "recentMessages": 6,
      "maxCharacters": 12000,
      "redactSecrets": true,
      "includeToolResults": false
    },
    "rules": {
      "protectedPaths": [],
      "allowedPaths": [],
      "alwaysConfirmCommands": [],
      "allowedCommands": []
    },
    "notifications": {
      "showAllowed": false,
      "showEvaluatorFailures": true,
      "showProjectOverride": true
    },
    "projectOverrides": "full"
  }
}
```

Settings merge in this order:

1. plugin defaults;
2. global `settings.json` overrides;
3. trusted-project `.pi/settings.json` overrides.

Set `disable` to `true` to bypass the guard explicitly. A missing or blank API
key no longer disables the plugin; evaluation follows `evaluatorFailure` until a
credential is available. `enabled` remains supported for compatibility.

Nested objects merge by field. Arrays replace instead of append. Unknown keys,
invalid types, duplicate list entries, and invalid threshold relationships are
rejected. With `projectOverrides: "full"`, a trusted project can weaken or
disable global policy; Pi warns when a project override is active. Set it to
`"none"` globally to ignore project policy.

Rule lists have deterministic precedence over Jev:

- `protectedPaths` and `alwaysConfirmCommands` force confirmation;
- `allowedPaths` and `allowedCommands` bypass evaluation;
- confirmation rules win when both match.

Paths match the configured path or its descendants after resolution against the
working directory. Commands match the exact command or the same command followed
by arguments. Rules are not regular expressions or shell glob patterns.

## Privacy and limitations

- Redaction covers common credential fields, environment assignments, bearer
  tokens, GitHub/npm tokens, JWTs, URL credentials, and private keys.
- Redaction reduces exposure but cannot guarantee detection of every secret
  format. Keep `includeToolResults` disabled unless needed.
- Context is character-bounded; oversized tool input retains its beginning and
  end with an explicit truncation marker.
- This extension is a confirmation guard, not an operating-system sandbox.
- The first release protects only Pi's `bash`, `write`, and `edit` tools.
- Explicit allow rules and fail-open policy intentionally reduce protection.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run check
```

Tests are deterministic and mock Jev unless a separate synthetic live smoke test
is run deliberately. No test reads live Pi settings.

## License

MIT

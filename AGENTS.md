# Repository guidance

## Scope

`pi-jev-tool-guard` is a Pi extension that evaluates `bash`, `write`, and `edit` calls with TypeSafe Jev before execution. Keep policy decisions deterministic in this repository; Jev supplies typed probabilities, not final permission decisions.

## Layout

- `src/config.ts` — strict settings parsing, threshold scale, defaults, provenance.
- `src/context.ts` — bounded/redacted Jev state construction.
- `src/evaluator.ts` — TypeSafe SDK boundary and response validation.
- `src/guard.ts` — deterministic rules, bash gates, confirmation/block flow.
- `src/command.ts` — `/tool-guard` status/editor command.
- `tests/` — deterministic Node tests; no live network or API credentials.

## Checks

```bash
npm install
npm run check
npm pack --dry-run
```

Run `npm run check` before committing. Tests must not call live Jev services or read live Pi settings. Construct key-shaped fixtures from harmless fragments so pi-jev-redact cannot remove them from an active provider request.

## Conventions

- Fail closed for malformed guard settings; preserve explicit fail-open evaluator policy.
- Keep Jev state below its 32k context limit; the configured payload cap must leave room for questions and protocol scaffolding.
- Per-tool thresholds replace the base threshold for that tool.
- Explicit deterministic rules run before probabilistic evaluation.
- Never log or commit credentials.

## Release

Run checks and `npm pack --dry-run`, bump package versions without creating an automatic tag, commit with an imperative subject, push `main`, then `npm publish`. Verify with `npm view <package> version`.

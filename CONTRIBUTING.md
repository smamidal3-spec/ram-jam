# Contributing

## Development Setup
1. Install dependencies: `npm install`
2. Start locally: `npm run dev`
3. Run tests: `npm test`

## Contribution Guidelines
- Keep event payloads backward-compatible.
- Add/extend tests for every behavior change.
- Keep utility functions side-effect free when possible.
- Update docs/examples when socket event contracts change.

## Pull Request Checklist
- [ ] Tests pass locally
- [ ] README/docs updated if behavior changed
- [ ] No secrets or API keys committed
- [ ] New code follows existing style conventions

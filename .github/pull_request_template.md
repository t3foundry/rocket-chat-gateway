<!--
Base branch: `develop` for everything except a hotfix, which targets `main`.
A pull request straight from a feature branch into `main` will be closed — see
CONTRIBUTING.md, "Branching model".
-->

## What this changes

<!-- One or two sentences. What behaviour is different after this is merged? -->

## Why

<!-- The problem, not the patch. Link the issue if there is one: "Closes #123". -->

## How to check it

<!-- The steps a reviewer follows to see it working, or the test that covers it. -->

## Checklist

- [ ] Branched from `develop` (or from `main`, if this is a hotfix)
- [ ] Branch name follows `feature/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`, `test/…`, `perf/…`, `ci/…` or `hotfix/…`
- [ ] Title follows Conventional Commits — `feat(rooms): …`, `fix(auth): …`
- [ ] `pnpm run format` · `pnpm run lint` · `pnpm run typecheck` · `pnpm run test` · `pnpm run build` all pass
- [ ] `pnpm run test:e2e` passes against a real Rocket.Chat, and covers the route this touches
- [ ] Code sits in the right layer — no `_id` or `rid` inside `apps/gateway`, no Rocket.Chat shapes above `packages/rc-adapter`
- [ ] Rocket.Chat version differences are handled by runtime detection and fallback, not by branching on the version string
- [ ] No secret, token or session value added to a log line or an error response

## Contract changes

<!--
Delete if this leaves `packages/api-contract` untouched. Otherwise this is a
breaking change for open-rocket-chat-client: say what changed, and link the
client pull request that goes with it.
-->

## Security

<!--
Delete if none. Anything touching sessions, cookies, CORS, uploads or token
handling belongs here — and a vulnerability in released code goes to
SECURITY.md rather than into a public pull request.
-->

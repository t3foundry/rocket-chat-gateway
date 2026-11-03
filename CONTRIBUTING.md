# Contributing

Thanks for helping out. This project is small enough that process should stay light.

## Setup

```bash
pnpm install
pnpm run build
pnpm run rc:up       # Rocket.Chat + MongoDB on localhost:3000
```

Node 24.7+ and pnpm 10 are required. `pnpm run rc:down` tears the stack down; `docker compose -f docker/rocketchat.compose.yml down -v` also drops the database.

## Branching model

This repository follows Git Flow, matching
[open-rocket-chat-client](https://github.com/zscontributor/open-rocket-chat-client) so that a change
spanning both repositories moves through the same steps in each. Two branches are permanent,
everything else is short-lived and deleted once it is merged.

| Branch        | What it is                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`main`**    | Released code, and nothing else. Every commit on it is a version that was tagged and shipped. It moves only when a release or a hotfix is merged into it.     |
| **`develop`** | The integration branch, and the base for all day-to-day work. It is where finished changes accumulate between releases, and it is the branch you branch from. |

Both are protected. **Nobody pushes to them directly and nobody merges their own work into them** —
including maintainers, whose commits go through the same review as everyone else's. Changes arrive by
pull request, and a pull request is merged by a reviewer, not by its author.

If `git push` to `main` or `develop` is rejected, that is the protection doing its job rather than a
problem with your checkout. Move the commits onto a branch and open a pull request:

```bash
git switch -c feature/upload-fallback   # takes your commits with you
git push -u origin feature/upload-fallback
```

### Short-lived branches

| Prefix                          | Branch from | Merge into           | For                                         |
| ------------------------------- | ----------- | -------------------- | ------------------------------------------- |
| `feature/`                      | `develop`   | `develop`            | New behaviour                               |
| `fix/`                          | `develop`   | `develop`            | A bug that can wait for the next release    |
| `refactor/`                     | `develop`   | `develop`            | Restructuring with no behaviour change      |
| `docs/`                         | `develop`   | `develop`            | Documentation only                          |
| `test/`                         | `develop`   | `develop`            | Tests only                                  |
| `perf/`                         | `develop`   | `develop`            | Performance work                            |
| `chore/` `ci/` `build/` `deps/` | `develop`   | `develop`            | Tooling, pipelines, dependency bumps        |
| `release/`                      | `develop`   | `main` and `develop` | Stabilising a version — maintainers only    |
| `hotfix/`                       | `main`      | `main` and `develop` | An urgent fix to something already released |

Name the rest of the branch after the change, not the ticket: `feature/upload-fallback`, not
`feature/ORC-412`. Lowercase, hyphen-separated.

`main` accepts pull requests from `develop`, `release/*` and `hotfix/*` only. One aimed at it from a
feature branch is rejected by [the branch policy check](.github/workflows/branch-policy.yml) before a
reviewer ever sees it — retarget it at `develop` using **Edit** next to the pull request title, which
keeps the commits and any review already given.

A security fix to released code is a `hotfix/`, and it starts privately —
see [SECURITY.md](SECURITY.md) rather than opening a branch and a public pull request that describe
the vulnerability before there is anything to upgrade to.

### Working on a change

```bash
git switch develop
git pull --ff-only origin develop      # always start from the current develop
git switch -c feature/upload-fallback

# ... work, committing as you go ...

git fetch origin
git rebase origin/develop              # keep your branch on top of develop
git push -u origin feature/upload-fallback
```

Rebase your own branch onto `develop` rather than merging `develop` into it — the history that reaches
`develop` is then the change itself, not the change plus a record of every time you synced. Because
your branch is yours alone, force-pushing it after a rebase is fine (`--force-with-lease`, which
refuses if somebody else has pushed to it in the meantime).

### Changes that cross both repositories

`packages/api-contract` is consumed by the client, which resolves it from a sibling checkout. A pull
request that changes the contract needs a matching one in the client repository, opened against that
repository's `develop`, and the two are merged together — the contract branch first, so the client's
CI has something to build against. Link each from the other, and say in the description that it is a
contract change.

### Commits and pull request titles

Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(uploads): fall back to the legacy route on older servers
fix(session): keep the second server when a cookie is reissued
refactor(adapter): move room type mapping out of the REST client
```

Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`. Append `!`
after the type for a breaking change — a contract change is one — and explain it in the body.

The **pull request title matters most**: work merges into `develop` as a single squashed commit whose
subject is that title, so it is the line that ends up in the history and in the release notes. The
individual commits on your branch are yours to keep messy.

## Before opening a pull request

```bash
pnpm run format
pnpm run lint
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run test:e2e
```

CI runs the same commands on every pull request and the checks are required, so running them locally
only saves you a round trip.

`pnpm run test:e2e` drives the Rocket.Chat the Compose file seeds. Four variables override that, and
all four have defaults, so a standard local setup needs none of them:

| Variable             | Default                 | What it is                         |
| -------------------- | ----------------------- | ---------------------------------- |
| `E2E_ROCKETCHAT_URL` | `http://localhost:3000` | The Rocket.Chat under test         |
| `E2E_ADMIN_USERNAME` | `admin`                 | The account the suite signs in as  |
| `E2E_ADMIN_PASSWORD` | `admin-password-123`    | Its password                       |
| `E2E_LOG_LEVEL`      | `warn`                  | Gateway log level during the suite |

## Review and merging

- Target `develop`. The pull request template's checklist is the one a reviewer works through.
- One approving review from a code owner is required, and that approval is dismissed if you push
  again — a review approves a diff, not an intention.
- All conversations must be resolved, and all checks green.
- **The reviewer merges, not the author.** Waiting for someone else to press the button is the whole
  point of the rule; there is no case where merging your own pull request is the quick way through.
- Work is **squash-merged** into `develop`, and the branch is deleted afterwards. Release and hotfix
  branches are merged with a merge commit, so the release stays visible in the history.
- Keep pull requests small enough to review in one sitting. Two reviewable pull requests land sooner
  than one large one.

## Releases

Cutting a release is a maintainer task, recorded here so the branching model reads as a whole.

```bash
# 1. Branch from develop and stabilise there — version bump, changelog, release fixes only
git switch develop && git pull --ff-only origin develop
git switch -c release/0.2.0
pnpm version 0.2.0 --no-git-tag-version && git commit -am "chore(release): 0.2.0"
git push -u origin release/0.2.0

# 2. Pull request release/0.2.0 -> main, reviewed and merged like any other

# 3. Tag the merge commit on main
git switch main && git pull --ff-only origin main
git tag -a v0.2.0 -m "0.2.0" && git push origin v0.2.0

# 4. Merge main back into develop so the bump and any release fixes are not lost
```

Step 4 is the one that gets forgotten. Without it `develop` is missing the release commits and the
next release branch reintroduces bugs that were already fixed.

A **hotfix** is the same shape with `main` as the starting point: branch `hotfix/0.2.1` from `main`,
fix, pull request into `main`, tag, then merge back into `develop`. It exists so an urgent fix can
ship without dragging along whatever is half-finished on `develop`.

Because deployers run the gateway rather than a bundle they downloaded, a release that changes
`packages/api-contract` or any environment variable needs that spelled out in the release notes — the
client version it pairs with, and anything an operator has to change before upgrading.

## Where code belongs

The layering is the point of the repository, so please keep changes in the right place:

- **`packages/rc-rest-client`, `packages/rc-realtime-client`** — speak Rocket.Chat's wire format. They keep its warts (`_id`, `rid`, single-letter room types) rather than hiding them.
- **`packages/rc-adapter`** — the only place that translates Rocket.Chat records into domain models.
- **`packages/api-contract`** — the shared schemas. Changing one is a breaking change for the client repo; say so in the PR.
- **`apps/gateway`** — HTTP and WebSocket surface, sessions, and orchestration. It should not reach into Rocket.Chat's shapes directly.

If you find yourself writing `message._id` inside `apps/gateway`, something belongs one layer down.

## Handling Rocket.Chat version differences

Detect at runtime, cache per server, and fall back — do not branch on the version string. Rocket.Chat backports changes, so the version is not a reliable signal for what a deployment actually supports. `UploadsResource` is the worked example: it tries the modern route, recognises "this server has no such endpoint", and remembers the answer.

When a server genuinely cannot do something, surface `unsupported_by_server`.

## Tests

Unit tests cover the adapter, where the interesting logic lives; they assert against the contract's zod schemas so drift is caught immediately.

End-to-end tests drive a real Rocket.Chat. Please add to them when you touch a route — a mocked test of an upstream we do not control mostly restates our own assumptions, and those assumptions are what tends to be wrong.

## Reporting bugs

Include the Rocket.Chat version (`GET /api/info` on your server), the gateway's error `code`, and the `upstream` field if present. A failing e2e test is the most useful bug report there is.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the MIT licence.

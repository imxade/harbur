# Harbur

Harbur is a GitHub-style collaboration workspace suitable for non-technical users with simple download and upload workflows, and it runs stateless and stores its durable data in Google Drive. The idea came during the GitHub outage in 2026. The question was: how usable can repository collaboration feel when the app has no database, no long-running backend, and no private infrastructure beyond a serverless deployment and an owner Drive account.

The result is a small project workspace for publishing code snapshots, reading README pages, discussing issues, reviewing pull requests, and managing access from one web UI. It is not meant to replace GitHub or native Git hosting. Instead, it reduces some Git workflow friction for small teams and personal projects by treating repositories as portable ZIP snapshots and routing code changes through pull requests. Every PR binds its creation-time base ZIP to a complete proposal ZIP. The browser displays a diff against the current repository; a merge is rejected if that repository has changed since the PR was created.

Projects can start from a local folder upload or a public GitHub mirror. Visitors can read README pages and download repository ZIPs without signing in; PR detail pages can download the complete proposal ZIP for testing before merge. When a PR is merged, Harbur keeps the previous repository ZIP as an immutable snapshot and promotes an exact Drive-side copy of the proposal ZIP. Authenticated contributors can open issues and pull requests, review browser-computed diff hunks with line numbers, comment with mentions, watch activity, and merge changes.

The Drive-backed design avoids putting large mutable state in one shared file. High-activity collaboration events such as comments, reviews, issue updates, and PR changes are written as append-style records and later folded into compact indexes and thread documents. This avoids large blocking writes even without request serialization or a database. README sidecars, artifact references, repository indexes, and optional backup Drive mirrors keep the app usable while still accepting Google Drive's speed and API limits. Diff payloads are never persisted.

Teams that need their own repository publishing space without managing their own infra can host Harbur on free or low-cost serverless platforms and configure their own owner Drive. This can also be used to avoid a single point of failure with drive backups and GitHub mirrors.

![Harbur app showcase](assets/showcase-grid.png)

## Overview

The sections below document Harbur's architecture, user experience, storage model, API contracts, workflows, security, operations, and tests. Known differences between the product description, diagrams, and current behavior are tracked with the related maintenance notes.

The system is best understood at three levels:

1. Harbur is a small GitHub-like collaboration UI for ZIP snapshots.
2. It is a stateless TanStack Start application whose durable store is one owner-controlled Google Drive.
3. The browser performs large byte operations, while server functions authorize operations and commit small, structured metadata documents.

### Contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Technology and dependency choices](#2-technology-and-dependency-choices)
3. [Codebase map](#3-codebase-map)
4. [Domain model and invariants](#4-domain-model-and-invariants)
5. [Settings and constants](#5-settings-and-constants)
6. [Actual Google Drive storage layout](#6-actual-google-drive-storage-layout)
7. [State loading and client merge semantics](#7-state-loading-and-client-merge-semantics)
8. [Authentication and security model](#8-authentication-and-security-model)
9. [Routes and page behavior](#9-routes-and-page-behavior)
10. [Server-function API inventory](#10-server-function-api-inventory)
11. [End-to-end workflows](#11-end-to-end-workflows)
12. [Concurrency, consistency, and failure model](#12-concurrency-consistency-and-failure-model)
13. [PR auto-clean](#13-pr-auto-clean)
14. [Timing and observability](#14-timing-and-observability)
15. [Integration consumer contract](#15-integration-consumer-contract)
16. [Installation and Google Cloud setup](#16-installation-and-google-cloud-setup)
17. [Suggested development order](#17-suggested-development-order)
18. [Test coverage](#18-test-coverage)
19. [Decision ledger and rationale](#19-decision-ledger-and-rationale)
20. [Known discrepancies and issues](#20-known-discrepancies-and-issues)
21. [Production hardening opportunities](#21-production-hardening-opportunities-not-current-behavior)
22. [Maintenance checklist](#22-maintenance-checklist)

### Product goals

- Publish a local folder as a repository without installing Git.
- Mirror a public GitHub repository from the browser.
- Let anonymous visitors browse public repositories, READMEs, issues, PRs, and ZIPs.
- Let authenticated users create and discuss issues and PRs.
- Let maintainers review browser-computed current-base diffs and promote exact proposal ZIPs.
- Keep OAuth secrets and Drive credentials server-side even though archive bytes move directly between browser and Drive.
- Avoid a database, request serialization service, resident worker, and scheduled daemon.
- Keep repository artifacts portable and backupable.
- Make common reads cheap relative to downloading and extracting entire repository archives.

### Product non-goals

- Harbur is not a Git remote, object database, or replacement for Git history.
- It has no branches, commits, rebases, tags, clone, push, or Git-native conflict resolution.
- It does not merge or rebase three trees. A PR is a complete desired folder state, and merge promotes it only while its creation-time base remains current.
- It does not host arbitrary private infrastructure or a conventional relational database.
- It does not proxy normal ZIP uploads through the app server.
- It does not register a service worker.
- It does not allow arbitrary HTML in repository READMEs.

## 1. Architecture at a glance

![Harbur low-level design and Drive-only internals](assets/harbur-low-level-design.svg)

![Harbur end-to-end sequences](assets/harbur-end-to-end-sequence.svg)

The responsibility split is deliberate:

| Layer | Owns |
| --- | --- |
| Browser | React UI, theme, route state, folder selection, `.gitignore` filtering, file reads, content fingerprints, bounded one-off ZIP creation/extraction, PR diff calculation, GitHub public fetches, direct Drive upload PUTs, temporary Drive media fetches, and a bounded changed-file display-diff cache |
| TanStack Start server | Session cookies, Google code exchange, identity verification, role refresh, authorization, owner/backup access tokens, HMAC upload/download tickets, quota checks, Drive envelope/checksum verification, Drive-side artifact copy, structured-state commits, append compaction, filtered state serialization, integration HTTP redirects |
| Owner Drive | Canonical global state, repository manifests, indexes, thread documents, append records, current and historical ZIP snapshots, PR ZIPs, staged upload/download folders |
| Backup Drive | Recreated restorable copy of app state and artifacts, with credentials and backup-target recursion removed |

### 1.1 Central architectural rule

All ordinary application modules are isomorphic by default because this is TanStack Start. Secret-bearing or Drive-mutating work must stay behind `createServerFn` handlers or server HTTP route handlers. Client ZIP workflows are explicitly client-only. Route components contain no Drive credentials. Archive bytes move only between the browser and Google Drive through server-created, origin-bound transfer URLs; they are never uploaded to or downloaded through the application backend.

## 2. Technology and dependency choices

### 2.1 Runtime and framework

- TypeScript, ES modules, strict mode, target ES2022.
- React 19.2.
- TanStack React Router and TanStack React Start, installed with the `latest` range in the current package.
- Vite 8 with Nitro 3 nightly as the production server runtime.
- Node 22 in Netlify configuration, Node 24 in Nix and CI. Standardize on Node 24 for local development and deployment because CI is the strongest compatibility signal.
- React Compiler through `@vitejs/plugin-react` plus the Rolldown Babel adapter.

### 2.2 UI and content

- Tailwind CSS 4 through the Vite plugin.
- daisyUI 5 with `dracula` as default/preferred-dark theme and `cupcake` as light theme.
- Lucide React icons.
- `react-markdown` with GFM and math plugins.
- KaTeX for math.
- Excalidraw source diagrams exported to static SVG during development/build.
- `diff`/jsdiff for unified, three-line-context PR hunks.

### 2.3 Data and archive utilities

- Zod 4 for runtime input/settings/integration validation.
- `fflate` for async ZIP and unzip.
- `ignore` for root `.gitignore` filtering.
- Native Web Crypto / Node Crypto for UUIDs, SHA-256, HMAC, and timing-safe comparison.

### 2.4 Tooling

- Biome for format/lint: tabs, double quotes, omitted semicolons.
- Vitest with jsdom available.
- Excalidraw source diagrams exported to committed SVG through a jsdom-based Node script.
- Nix shell includes Node 24, `act`, and zsh.
- Apache License 2.0.

### 2.5 Vite plugin order

Keep the plugins in this order unless deliberately migrating framework versions:

1. TanStack devtools Vite plugin.
2. TanStack Start plugin.
3. Nitro Vite plugin.
4. React Vite plugin.
5. Rolldown Babel with React Compiler preset.
6. Tailwind Vite plugin.

Alias `daisyui` to `daisyui/index.js`.

## 3. Codebase map

```text
src/
  router.tsx                         router factory and type registration
  routeTree.gen.ts                   generated; never hand-edit
  styles.css                         Tailwind, typography, daisyUI themes
  routes/
    __root.tsx                       document shell, theme bootstrap, providers
    index.tsx                        discovery/search/admin repository creation
    $owner.tsx                       owner repository listing
    repo.$owner.$repo*.tsx           overview/issues/PR/settings route adapters
    settings.tsx                     account and admin settings
    api.integrations.v1.*.ts         public/private deployment integration API
  components/
    AppShellProvider.tsx             client state coordinator and action facade
    Header.tsx                       identity, quota, notifications, theme, auth
    ReadmeRenderer.tsx               safe GFM/math/code/asset rendering
    RepositoryCard.tsx               repository discovery card
    LinkifiedText.tsx                safe plain-text HTTP(S) links
    app-pages/*                      route-level panels and shared thread/diff UI
  lib/
    app-config.ts                    every constant, filename, TTL, URL, default
    types.ts                         Zod-backed core contracts
    server-functions.ts              authenticated server boundary
    drive-state.ts                   state engine and domain mutations
    google-drive.ts                  low-level Drive REST adapter
    google-auth-client.ts            browser GIS popup code flow
    client-zip-workflows.ts          archive orchestration in the browser
    upload-client.ts                 folder filtering, metadata, upload transfer
    zip.ts                           fflate adapter
    github.ts                        public GitHub snapshot fetch
    integration-server.ts            integration auth/list/events/exact archive
    search.ts                        summaries, owner groups, fuzzy ranking
    timing.ts                        server span timing
    auth/, issues/, pulls/, ...      pure domain rules
tests/unit/                           32 deterministic behavioral tests
docs/diagrams/*.excalidraw            editable architecture diagrams
assets/*.svg                          generated diagram outputs
```

## 4. Domain model and invariants

### 4.1 Actor

```ts
type Actor = {
  id: string
  email: string
  role: "anonymous" | "user" | "admin"
}
```

Anonymous is represented by the fixed identity `anonymous@harbur.local`. Authenticated email is the durable principal. A mutable Name/ownerName is only a public handle and route/display value.

### 4.2 Repository policy

```ts
type RepositoryPolicy = {
  issuesEnabled: boolean
  prsEnabled: boolean
  allowUserCloseOwnIssues: boolean
  requiredStatusForMerge: "none" | "reviewed"
}
```

There are intentionally only four stored policy controls. Other collaboration rules are fixed product behavior.

### 4.3 Repository manifest

```ts
type RepositoryManifest = {
  schema: "harbur.repository.v1"
  id: string                       // `${owner}/${name}`
  owner: string                    // mutable public Name
  name: string
  description?: string
  defaultBranch: string            // new repositories: "main"
  vcs: "git" | "fossil" | "folder"
  visibility: "public" | "private"
  rootFolderId: string
  policy: RepositoryPolicy
  maintainers: Array<{
    userId: string
    email: string
    permissions: Array<"triage" | "merge" | "settings">
  }>
  access: Array<{ email: string; addedAt: string; addedBy: string }>
  githubMirror?: {
    type: "github"
    owner: string
    repo: string
    branch: string
    htmlUrl: string
    zipUrl: string
    lastSyncedAt?: string
    lastSyncStatus?: "ok" | "failed"
    lastSyncError?: string
  }
  labels: Array<{ id: string; name: string; color: `#${string}`; description?: string }>
  archived: boolean
  createdAt: string
  updatedAt: string
}
```

Repository names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`. The built-in labels are `bug/#d73a49`, `enhancement/#2ea44f`, and `question/#0366d6`.

### 4.4 User profile and Name

```ts
type UserProfile = {
  email: string
  ownerName: string
  createdAt: string
  updatedAt: string
}
```

Names are trimmed, internal whitespace is collapsed, length is 1–64, the first character is alphanumeric, and remaining characters may be letters, digits, dot, underscore, hyphen, or space. Names are unique case-insensitively. A new profile receives the configured base owner name, then `-2`, `-3`, and so on if needed.

Changing a Name remaps repositories for which that email has `settings` permission. It updates repository IDs/routes, in-memory keyed maps, watches, activities, snapshots, and integration event repository IDs. Email authorship in existing messages is not rewritten.

### 4.5 Repository files and hashes

```ts
type RepositoryFile = {
  path: string
  content: Uint8Array | string
  encoding?: "utf8" | "base64"
  size: number
  contentHash?: string
  modifiedAt?: string
}
```

The fast per-file content fingerprint is 32-bit FNV-1a, returned as eight lowercase hexadecimal digits. It detects changes for PR UX and metadata validation; it is not the immutable snapshot revision. Snapshot revisions are full SHA-256 digests of ZIP bytes.

Files containing NUL or invalid UTF-8 are represented as base64. Text detection uses fatal UTF-8 decoding.

### 4.6 Path safety

Normalize backslashes to slashes, strip leading slashes, and collapse duplicate slashes. Reject empty paths, NUL, leading/interior/trailing `..`. Exclude VCS segments `.git`, `.hg`, `.svn`, `_FOSSIL_`, `.fslckout`, `.fossil-settings`, and `CVS`.

Repository exports additionally exclude any path containing `issues`, `pulls`, `activity`, `feeds`, `audit`, `settings`, or `credentials` as a segment.

Folder selection removes a common first directory when every browser path has at least two segments and the same first segment. If a root `.gitignore` exists, concatenate root `.gitignore` texts and filter candidates with the `ignore` package. VCS metadata is silently excluded rather than failing the upload.

### 4.7 Issue

```ts
type IssueRecord = {
  id: string                       // `${repoId}:issue:issue-${uuid}`
  number: number                   // derived, not durable identity
  authorEmail: string
  title: string
  body: string
  state: "open" | "closed"
  labels: string[]
  comments: ThreadComment[]
  createdAt: string
  updatedAt: string
  editedAt?: string
}
```

Numbers are reassigned deterministically by sorting records by `createdAt`, then `id`, and using one-based array position. All labels must exist in the manifest.

### 4.8 Pull request

```ts
type PullRequest = {
  id: string                       // `${repoId}:pull:pull-${uuid}`
  number: number
  authorEmail: string
  title: string
  body: string
  state: "open" | "closed" | "merged"
  baseRepositoryZipFileId?: string
  proposalZipSha256?: string
  reviewedBy?: string
  reviewedBaseRepositoryZipFileId?: string
  reviewedProposalZipFileId?: string
  createdAt: string
  updatedAt: string
  editedAt?: string
  comments: ThreadComment[]
}
```

PR state persists only artifact identity/checksum and review metadata. The full proposal ZIP is the proposed repository tree. ZIPs and complete extracted base/proposal file arrays are processed transiently; only changed-file display data is retained in the bounded browser diff cache. None of it is part of a server-function request or Drive JSON document. Legacy records containing diff/file fields are stripped when loaded and rewritten during compaction; they cannot be merged because they lack immutable base/proposal bindings.

### 4.9 Activity, notifications, snapshots, and events

Activity kinds are `repo.created`, `issue.created`, `issue.closed`, `issue.reopened`, `issue.commented`, `pr.created`, `pr.closed`, `pr.commented`, `pr.merged`, `repo.watched`, `repo.deleted`, `repo.synced`, and `settings.updated`.

Mention notifications contain repository, recipient, actor, source ID, text, timestamp, and read flag. Watched activity is not copied into notification records in the current implementation; the header derives read-only activity items by combining current watch IDs with loaded activity records.

Each canonical repository ZIP can have an immutable snapshot record:

```ts
type RepositorySnapshot = {
  revision: string                 // SHA-256, same as sha256
  sha256: string
  archiveBytes: number
  driveFileId: string
  createdAt: string
  source: "repository.created" | "repository.synced" | "pull_request.merged"
  pullRequestNumber?: number
}
```

Appending a snapshot also appends a monotonically increasing `repository.snapshot` integration event and increments `integrationNextCursor`.

## 5. Settings and constants

The complete creation defaults are:

```json
{
  "schema": "harbur.settings.v1",
  "ownerName": "harbur-<8-random-chars>",
  "allowPublicGitMirrors": false,
  "githubMirrorSyncIntervalHours": 24,
  "defaultRepoVisibility": "public",
  "defaultRepoPolicy": {
    "issuesEnabled": true,
    "prsEnabled": true,
    "allowUserCloseOwnIssues": true,
    "requiredStatusForMerge": "none"
  },
  "prAutoCleanDays": 0,
  "backupSyncIntervalHours": 24,
  "downloadCleanupDelayMs": 0,
  "uploadLimits": {
    "maxRepoUploadBytes": 2147483648,
    "maxPrUploadBytes": 536870912,
    "maxSingleFileBytes": 104857600,
    "maxFilesPerUpload": 20000
  },
  "backupTargets": []
}
```

Other fixed constants:

| Constant | Value/purpose |
| --- | --- |
| ZIP compression | fflate level 3 |
| Upload ticket TTL | 2 hours |
| Upload stale grace | 1 hour after ticket TTL |
| Upload sweep cap | 10 folders/request |
| Download cleanup grace | 1 hour after configured delay |
| Download sweep cap | 10 folders/request |
| Temporary download-link rate | 30 per actor/address per 10 minutes |
| Drive quota safety margin | 10 MiB |
| Append compaction threshold | 5 append records |
| README sidecars | at most 20 image files and 2 MiB total |
| ZIP extraction ratio | at most 100:1 per file, plus configured file/count/byte limits |
| Open PRs per actor/repository | 25 |
| Upload-session rate | 10 per actor per 10 minutes |
| Drive exact search page | 10 |
| Drive prefix page | 1000, paginated |
| Google access-token cache | refresh if less than 60 seconds remains |
| Session lifetime | 400 days |
| Google popup timeout | 60 seconds |
| GitHub blob concurrency | 8 |
| Direct Drive download guard | 256 MiB default for server-side snapshot verification |

Admin settings updates cannot replace `ownerName` or `backupTargets`; the state engine preserves their current values. Only `maxFilesPerUpload` is exposed in the current settings UI, although the other byte limits exist in stored settings.

## 6. Actual Google Drive storage layout

### 6.1 Owner Drive

```text
Google Drive appDataFolder/
  harbur.appdata.v1.json

Google Drive My Drive/
  Harbur/                                      rootFolder
    upload-<uuid>-<label>/                     temporary upload stage
    download-<uuid>-<label>/                   temporary download stage
    <repository stage/root folder>/
      harbur.repository.json                   manifest
      harbur.repository.zip                    current ZIP
      harbur.repository-state.v1.<rootId>.json compact index
      harbur.repository-thread.v1.<rootId>.<uuid>.json
      harbur.repository-append.v1.<rootId>.<appendId>.json
      pull-<uuid>/
        pull-<uuid>.zip                        complete proposal archive
      snapshot artifacts retained by file id as needed
```

The current repository folder begins life as an `upload-*` folder and is used as the repository root after successful commit; the folder name is not subsequently renamed by the current code.

### 6.2 Global app-data document

The app-data document currently stores:

- schema, bootstrap config, settings, and root folder metadata;
- the full repository manifest registry;
- immutable snapshot metadata and integration events/cursor;
- watches, users, mention notifications;
- only non-repository/global activity;
- backup refresh-token credentials.

Runtime-only fields such as Drive version, loaded-ID markers, detailed issue/PR maps, repository file maps, and quota are not serialized. Repository activity lives in repository indexes.

This means global app-data is still a shared versioned document for user profiles, watches, notifications, settings, backup status, repository registry, and integration history.

### 6.3 Repository index

The repository-state document contains file metadata without ordinary file content, README/image sidecars, canonical ZIP ID, issue summaries without comments, PR summaries containing artifact references but no diff or file payload, PR ZIP ID map, and repository activity.

### 6.4 Thread documents and append records

Thread documents contain a complete issue or PR detail after compaction. High-frequency mutations first create separate append JSON files. Valid append kinds are creation, comment, title edit, message edit, issue-state change, PR review, and PR close.

On load, the engine:

1. loads the repository index and every valid append file in parallel;
2. sorts appends by creation time then ID;
3. folds them idempotently into issue/PR maps, activity, notifications, and PR ZIP IDs;
4. loads only requested thread documents unless a mutation/backup asks for all;
5. reapplies appends over hydrated details;
6. if at least five append files exist, hydrates affected threads, saves full thread documents, saves a new versioned index, then best-effort deletes append files; legacy diff-bearing PR documents force this migration immediately;
7. optionally prunes old PRs.

Malformed append files are ignored. An unreadable/incompatible global, repository, or requested thread document fails closed. Bootstrap occurs only when global app-data is missing.

## 7. State loading and client merge semantics

### 7.1 Shell load

`getDriveState` accepts anonymous sessions. It refreshes an owner Drive token, loads global app-data with `includeRepositoryDetails: false`, optionally creates a profile for a signed-in email, attaches quota when available, filters by visibility, strips backup credentials, and returns shell metadata.

### 7.2 Repository detail load

`getRepositoryDriveState` accepts repository ID, optional root-folder hint, and optional selected issue/PR number. The hint lets repository index/append loading start while global state loads. After global state identifies the canonical manifest, visibility is enforced. Selected thread detail alone is hydrated. A selected PR then causes the browser to fetch and safely extract the current repository ZIP and complete proposal ZIP.

### 7.3 Browser state merge

The app shell must merge route-scoped state without erasing richer data already loaded:

- Replace shell/global fields with incoming values.
- Merge repository file and README maps only for IDs marked as loaded.
- Merge thread arrays by stable ID and timestamp.
- Preserve current comments when an incoming summary did not load that thread.
- Re-sort and renumber threads deterministically.
- Union loaded markers and repository storage versions.
- Deduplicate activity by ID; replace each incoming user’s notification list.

The only archive-derived cache is a bounded in-memory PR display-diff map. Each entry contains changed-file metadata and the before/after content needed by the renderer, keyed by current repository ZIP ID plus proposal ZIP ID. A base or proposal change invalidates it. ZIP `Blob`s and complete extracted repository/base/proposal arrays are never cached there, and the diff cache never enters serialized app state.

## 8. Authentication and security model

### 8.1 Environment variables

| Variable | Required | Use |
| --- | --- | --- |
| `GOOGLE_DRIVE_CLIENT_ID` | Yes for auth/Drive | Browser-safe OAuth client ID |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Yes | OAuth exchange and HMAC/session secret material |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | Yes for storage | Owner Drive refresh token, server only |
| `GOOGLE_DRIVE_BROWSER_API_KEY` | Yes for ZIP download/PR workflows | Referrer-restricted Drive API key for temporary public media copies |
| `APP_ADMIN_EMAILS` | Operationally required | Comma-separated exact admin allowlist |
| `INTEGRATION_READ_TOKEN` | Optional | 32–512 character deployment integration Bearer token |
| `HARBUR_TIMING` | Optional | `1` logs all timing spans; slow spans log regardless |

Never include actual values in documentation, client bundles, state responses, or logs.

### 8.2 Google authorization-code flow

The browser dynamically loads Google Identity Services and opens a popup code client. Login asks for `openid email`; Drive connection asks for `openid email drive.file drive.appdata`, includes already-granted scopes, and forces account selection. The browser submits `{code, redirectUri: window.location.origin}`.

The server requires request Origin to match the submitted redirect URI when an Origin header exists, exchanges the code with the secret, and for login verifies the ID token through Google tokeninfo. It checks audience, subject, email, and verified-email status.

Owner/backup connection also requires a refresh token and reads the account email from Google userinfo. In development owner connection writes a quoted value to `.env.local`; in production it updates only the current process and tells the operator to persist the secret in deployment configuration.

### 8.3 Session

The app uses a TanStack Start encrypted HttpOnly cookie. Development name is `harbur_session`; production name is `__Host-harbur_session`. It is `SameSite=Lax`, `Path=/`, secure in production, and has no Domain. The encryption password derives from the Google client secret. Role is recalculated from `APP_ADMIN_EMAILS` on every protected or optional actor read, so allowlist changes take effect without re-login.

### 8.4 Visibility and serialization

A public repository is visible to everyone. A private repository is visible to admins, any maintainer email, and explicit access grants. Filtering removes hidden manifests and all keyed repository details, activity, loaded markers, and stale notifications. Anonymous actors receive no watches or notifications. Authenticated actors receive only their own. `backupCredentials` is always returned as `{}`. The users map is reduced to identities relevant to visible content.

### 8.5 Upload tickets

Upload tickets are `base64url(JSON).base64url(HMAC-SHA256)` signed with the server secret. Payloads bind kind, actor email, staged folder, byte length, origin, expiry, and when applicable repository/root ID, PR number, and base repository ZIP ID. Verification uses timing-safe signature comparison, Zod parsing, expiry, origin, actor, kind, and request-specific identity checks.

Completion independently verifies Drive file name, exact size, parent folder, permissions, policy, and current base ZIP ID. Repository and mirror metadata is path/limit validated. PR completion accepts no diff or file metadata. Merge accepts no archive metadata and promotes only a Drive-side copy of the stored proposal after strict base, checksum, permission, and review-artifact checks.

### 8.6 Download tickets

Downloads copy a canonical private artifact into a temporary folder, grant `anyone/reader` with discovery disabled, and return a Drive media URL containing only the browser API key plus an HMAC cleanup ticket. The cleanup ticket binds actor identity, copied file, folder, permission, origin, and expiry. Cleanup is scheduled immediately after `fetch()` starts—even if fetch later fails—and a later request sweeps abandoned folders.

### 8.7 Permission matrix

| Action | Anonymous | Signed-in user | Private grant | Maintainer permission | Admin |
| --- | ---: | ---: | ---: | ---: | ---: |
| View public repo/threads/download ZIP | Yes | Yes | Yes | Yes | Yes |
| View private repo | No | No | Yes | Yes | Yes |
| Create/comment issue or PR if enabled | No | Visible repos | Yes | Yes | Yes |
| Edit own message | No | Yes | Yes | Yes | Yes |
| Edit thread title | No | Own only | Yes | Any maintainer email | Yes only if separately authorized by repo relationship |
| Close/reopen own issue | No | If policy permits | Yes | `triage` or owner | Same caveat as above |
| Close own PR | No | Yes | Yes | `triage` or owner | Same caveat as above |
| Review PR | No | No | Yes | `merge` or owner; not author | Same caveat as above |
| Merge PR | No | No | Yes | `merge` or owner | Same caveat as above |
| Change repository settings | No | No | No | `settings` | Only if also repository owner |
| Create/delete repository, global/backup settings | No | No | No | No | Yes |

Important: admin is a global role but `canOwnRepository` and repository maintainer checks do not automatically treat admin as repository owner. The UI similarly shows repository settings only to `settings` maintainers.

## 9. Routes and page behavior

### 9.1 Router defaults

Enable scroll restoration, intent preloading, and zero preload stale time. The not-found page is a centered alert. The generated route tree is excluded from formatting/search and is read-only in editor settings.

### 9.2 Root document and shell

The document title is `Harbur | Drive-backed code collaboration`. Before hydration, an inline script reads `Harbur-theme`; only `cupcake` and `dracula` are accepted, defaulting to `dracula`. The shell wraps all route content in the app provider and sticky header and renders TanStack Scripts. No service worker is registered.

### 9.3 Header

The sticky header contains home brand, signed-in Name and role on larger screens, admin quota indicator, notifications, theme toggle, source GitHub link, settings link, and sign-in/sign-out.

The notification dropdown shows at most ten newest combined mention and watched-activity items. Mention items retain unread styling. Clicking an item closes the menu and marks all mention notifications read. Routes are inferred first from source IDs and loaded threads, then from `issue #N`/`PR #N` text, else repository overview.

### 9.4 `/`

- Loads shell state and shows owner configuration/loading/errors.
- Admins see repository creation by public GitHub URL or Chromium folder input (`webkitdirectory`). GitHub input wins if both are provided.
- Folder inspection shows accepted count/bytes after normalization, VCS exclusion, and root `.gitignore` filtering.
- Client quota preflight includes the 10 MiB safety margin.
- Search query lives in `?q=` and updates with replace navigation.
- Blank query shows alphabetic owner cards with repository count and latest update.
- Nonblank query shows weighted fuzzy results.

Search scoring takes the maximum of name ×100, repository name ×90, owner ×80, description ×60, GitHub URL ×40, or combined search text ×30. Exact, prefix, substring, all-word, and subsequence matches score 1, .9, .75, .65, or at least .15 respectively. Sort by score, newest update, then name.

### 9.5 `/$owner`

Shows alphabetically sorted visible repositories for an exact mutable owner Name and a link back to all owners.

### 9.6 `/repo/$owner/$repo` and subroutes

The shared repository page resolves the manifest from already-filtered shell state, lazily loads detail, and displays “not found or private” with sign-in for anonymous users. Header actions are Watch, ZIP, optional GitHub source, and admin-only Delete. Tabs are Overview, Issues, Pulls, and owner-only Settings. Counts show open issues and open PRs.

The repository header currently always says “Public repository” even for private manifests. This is a known UI bug.

### 9.7 Overview/README

Use a root `README.md` sidecar or show a fallback heading. Render GFM and KaTeX; do not enable raw HTML or execute diagram code. Fenced diagram text remains a normal code block. Only safe relative images below root `assets/` are rewritten to `data:` URLs; supported formats are PNG, JPEG, GIF, WebP, SVG, and AVIF. External/other image URLs pass through React Markdown behavior. Harbur-owned architecture diagrams are maintained as Excalidraw sources and exported to SVG.

### 9.8 Issues

The list switches between open and closed. The creation form requires sign-in, enabled issues, title/body, and valid labels. Detail pages display an editable title, state, author Name/time, chat-style original body/comments, inline URL linking, mention highlighting, comment form, and close/reopen.

Only an author can edit their own body/comment. Title editing is broader: author, any maintainer, or access grant. Issue state changes require triage/owner/access, or the author when self-close is enabled. Existing issues remain commentable even when new issues are disabled; the transition helper, however, rejects state changes when issues are disabled.

### 9.9 Pull requests

The list switches open versus closed, where “closed” includes merged. New PR requires sign-in, enabled PRs, title/body, and a full folder selection. Creation is intentionally detached from the form after submission: the form resets and shows per-draft creating/failed status.

PR detail contains title/thread, review identity, actions, and one collapsed diff card per changed file. The browser downloads the current repository and proposal artifacts, validates bounded ZIP structure and optional Drive SHA-256, computes byte-exact changes locally, and only calculates a text patch when its card is expanded. Text uses jsdiff `structuredPatch` with three lines of context and old/new line numbers. Invalid UTF-8/binary shows “Binary file changed”; oversized text diffs are refused. If another PR updates the repository, reopening this PR recalculates its display diff against that new base while merge remains blocked.

The preview download exists only for an open PR and rebuilds the complete proposal ZIP locally without mutation. Review requires merge capability and a reviewer other than the author; the review record binds both artifact IDs. Close is server-enforced for author or triage capability, although the current UI enables Close for every signed-in user and relies on the server error. Merge requires capability, open state, enabled PRs, an unchanged base repository, and optional independent artifact-bound review.

### 9.10 Repository settings

Only `settings` maintainers see the tab. Controls: repository name, issues, PRs, author self-close, merge requirement, description, visibility, and newline/comma-separated private grants. Grants accept a registered email or exact case-insensitive Name. Unknown/unregistered values fail. Renaming navigates to the new route after save.

### 9.11 Global settings

Anonymous/non-ready users are prompted to sign in. An authenticated user can change only their Name. Admin-only areas show owner Drive usage; public GitHub mirror toggle/interval; defaults for new repository visibility and policy; PR cleanup days; backup interval; download cleanup delay; max files; and backup Drive connect/disconnect/delete.

Owner Drive can be connected from a dedicated admin screen when credentials are missing. Disconnecting a backup leaves remote content. Deleting a backup deletes its Harbur root and app-data, then disconnects.

### 9.12 HTTP integration routes

| Method/path | Auth | Result |
| --- | --- | --- |
| `GET /api/integrations/v1/capabilities` | None | Version, configured flag, SHA-256 immutable ZIP capability, integer polling cursor |
| `GET /api/integrations/v1/repositories` | Optional Bearer | Public list without token; public + private with exact valid token |
| `GET /api/integrations/v1/events?after=0&limit=50` | Required Bearer | Snapshot events, next cursor, hasMore; limit 1–100 |
| `GET /api/integrations/v1/repositories/$owner/$repo/snapshots/$revision` | Public repo: none; private: Bearer | Temporary redirect to an exact Drive-side snapshot copy |

Repository responses do not expose canonical Drive IDs. Snapshot download validates owner (1–100, no slash/backslash/NUL), repository name, and 64-lowercase-hex revision, creates a temporary Drive-side copy, and returns a 307 redirect with Content-Disposition, ETag, `X-Content-SHA256`, and `Vary: Authorization`. The application backend never reads the ZIP body. Public redirects cache for one year immutable; private responses are no-store.

Errors are JSON. Invalid input is 400, missing/invalid credential 401, missing resource 404, unconfigured storage/admin 503, Drive auth/verification failure 502, and unexpected failure 500 without internal details.

## 10. Server-function API inventory

All mutations use POST; reads use GET.

| Function | Input/behavior |
| --- | --- |
| `getAuthConfig` | Returns browser-safe Google client ID |
| `getSessionState` | Returns session user with freshly computed role |
| `getDriveState` | Returns filtered shell state and quota |
| `getRepositoryDriveState` | Repository ID/root hint and optional issue/PR number; returns filtered scoped detail |
| `loginWithGoogle` / `logoutSession` | Exchange popup code/create cookie; clear cookie |
| `connectOwnerDriveServer` | Admin code exchange; initializes owner state; development `.env.local` persistence |
| `beginZipUploadServer` | Starts repository, PR, or GitHub sync stage and returns signed ticket + upload URL |
| `cancelZipUploadServer` | Deletes matching actor’s staged folder |
| `completeRepositoryUploadServer` | Admin verifies repository ticket and commits manifest/index/snapshot |
| `completePullRequestUploadServer` | Commits complete proposal artifact reference and append record; accepts no diff/files |
| `completeGitHubMirrorSyncUploadServer` | Admin replaces mirrored snapshot if base ID still matches |
| `mergePullRequestServer` | Authorizes an exact Drive-side proposal copy; accepts no ZIP, diff, or file metadata |
| `watchRepositoryServer` | Updates signed-in actor’s watch set |
| `markNotificationsReadServer` | Marks all actor mention notifications read |
| `deleteRepositoryServer` | Admin deletes Drive folder and references |
| `updateSettingsServer` | Admin global settings update |
| `updateUserNameServer` | Signed-in Name update and repository key remap |
| `connect/disconnect/deleteBackupDriveServer` | Admin backup lifecycle |
| `updateRepositoryAccessServer` | Repository owner updates name/description/visibility/policy/grants |
| Issue functions | Create, comment, edit title, edit own message, transition state |
| PR functions | Comment, edit title, edit own message, review, close, merge |
| `createRepositoryZipDownloadLinkServer` | Optional actor; visibility check; temporary Drive media copy |
| `createPullRequestZipDownloadLinkServer` | Optional actor; returns complete proposal ZIP temporary copy |
| `createPullRequestBaseZipDownloadLinkServer` | Optional actor; returns immutable PR base ZIP temporary copy |
| `revokeZipDownloadLinkServer` | Validates cleanup ticket, removes permission/file/folder |

Repository writes use a shared three-attempt conflict loop. Each attempt refreshes the Drive token, reloads repository state with only necessary thread detail, rechecks visibility, applies the mutation, and retries only known version conflicts.

## 11. End-to-end workflows

### 11.1 Application initialization

1. Fetch browser-safe auth config.
2. If no client ID, mark auth not configured but still attempt public Drive shell load.
3. Preload GIS, load session, and derive anonymous or authenticated actor.
4. Load visible shell state. A missing owner refresh token becomes `owner-not-configured` for the admin settings flow.
5. If the actor is admin and a GitHub mirror is due, dynamically load ZIP workflows and refresh due mirrors sequentially once per app-shell mount.

### 11.2 Local repository creation

1. Admin selects folder; browser normalizes root, filters `.gitignore` and VCS metadata, enforces count/size limits, reads files, computes FNV hashes, and records modification times.
2. Include content sidecars only for root README and capped root asset images.
3. Build a level-3 ZIP and preflight Drive quota plus 10 MiB.
4. Ask server to begin `repository` upload with name, exact ZIP size, and origin.
5. Server rechecks admin/name/duplicate/quota, creates an `upload-*` folder and resumable upload session, and signs a two-hour ticket.
6. Browser PUTs ZIP directly to the upload URL with XHR progress.
7. Browser calls completion with Drive file ID, ticket, description, and metadata—not ZIP bytes.
8. Server verifies ticket, file metadata, paths, duplicates, limits, hashes for supplied sidecars, and optional GitHub permission.
9. Create manifest with creator as triage/merge/settings maintainer, save manifest and repository index, record Google Drive's SHA-256 checksum metadata as the immutable snapshot revision, append the integration event, and save global app-data. The application server does not read or hash ZIP bytes.
10. On failure, delete staged/repository folder best-effort. On success, return metadata without full repository file contents.

### 11.3 Public GitHub mirror creation and refresh

Parse only `https://github.com/owner/repo` variants, optionally ending `.git` or additional path. Browser calls repository API, branch API, recursive tree API, rejects truncated trees, and fetches blobs with concurrency eight. Try immutable raw URL at commit SHA; fall back to Git blob base64. Do not apply `.gitignore` to GitHub snapshots. Package through the same repository upload flow.

Refresh runs only in admin sessions and only when configured interval is positive and due. This is an intentional trust boundary, not general visitor-triggered maintenance: the browser constructs the archive and the backend deliberately never reads it, so granting an anonymous visitor an owner-Drive upload/completion capability would let a modified client substitute arbitrary repository bytes that the backend could not verify. Supporting safe refresh on any visit would require a trusted scheduled worker or a verifiable artifact source that can transfer directly to Drive without the archive crossing Harbur's backend. The current refresh is pinned to the current repository ZIP ID. Commit updates mirror timestamps/status, repository update time, snapshot/event, and `repo.synced` activity. One failed mirror stops the current sequential refresh loop and surfaces an app-shell error.

### 11.4 Repository download

1. Browser asks server for a download link; authentication is optional but private visibility is enforced.
2. Server sweeps up to ten stale download folders, creates a `download-*` folder, copies the canonical ZIP, grants nondiscoverable anyone-reader, and returns API-key media URL plus HMAC cleanup ticket.
3. Browser starts fetch, immediately schedules cleanup after configured delay, reads Blob, creates an object URL, clicks a download anchor, and revokes the object URL.
4. Cleanup revokes permission and deletes copied file/folder. Missed cleanup waits for a future sweep.

### 11.5 Issue mutation

Creation/comments/edits/transitions create UUID append records instead of rewriting the repository index. Issue and PR creation can therefore proceed concurrently across clients; repository creation uses independent new folders. Display numbers are assigned deterministically when appends are folded. Comment submission also renders a local bubble immediately as `Sending…`; only the returned append-backed comment becomes `Stored · visible to others`, while a failed write remains marked local/not stored. Notification additions are separately merged into global state with up to three conflict retries; failure is intentionally swallowed after the append succeeds, so collaboration data remains durable even if notification delivery is missed.

### 11.6 Pull request creation

1. Download/extract the current repository ZIP for this operation; do not retain the ZIP or its complete extracted file array in the PR cache.
2. Prepare selected proposed folder with the same local filtering and PR limits.
3. Diff the complete path union byte-for-byte in the browser.
4. Remove unchanged entries and reject no-op PR.
5. Build a complete proposal ZIP containing the entire selected repository tree.
6. Begin a `pull-request` stage pinned to current repository ZIP ID; upload the ZIP directly from browser to Drive.
7. Server verifies only the Drive envelope, base freshness, PR policy, and bounded title/body. No diff, diff ID, base files, proposal files, or ZIP bytes enter the RPC.
8. Create `pull-<uuid>` folder, move/rename the proposal to `pull-<uuid>.zip`, persist its base artifact ID and Drive SHA-256, append `pull.created`, persist mention additions, and delete the empty stage.

### 11.7 PR review display

Selected detail loads only its thread document, then the browser downloads/extracts the current repository ZIP and complete proposal ZIP with file-count, compressed-size, expanded-size, per-file-size, compression-ratio, path, duplicate/collision, encryption, symlink, method, and header consistency checks. It retains only changed-file display data in a bounded browser-memory cache. When the current repository ZIP ID changes, the cached entry is invalid and the diff is recalculated. The backend and Drive JSON never receive the diff.

### 11.8 PR archive downloads

For an open PR, the `Proposal ZIP` button fetches the complete stored proposal directly from a temporary Drive copy for testing. After merge, the same control becomes `Pre-merge ZIP` and fetches the PR's creation-time base artifact, which is the repository ZIP from immediately before that merge because stale-base merges are rejected. Closed, unmerged PRs do not expose this control. No archive is rebuilt or cached.

### 11.9 Merge

1. Client verifies that the current repository artifact ID still equals the PR creation-time base ID.
2. Client sends only repository identity and PR number. There is no merge upload or merge ticket.
3. Server reloads full selected PR detail and checks open state, PR enabled, repository not archived, merge permission, strict base equality, proposal presence/checksum, and any artifact-bound review rule.
4. Server asks Google Drive to copy the stored proposal ZIP into a staging folder. ZIP bytes do not pass through browser or backend during promotion.
5. Move the exact copied ZIP into the repository folder as `harbur.repository.zip`.
6. Append immutable snapshot/event metadata with source `pull_request.merged`, mark PR merged, update manifest timestamp in global state, and append activity.
7. Save versioned repository index, then global app-data. Delete the old ZIP only if no snapshot record references it; normally the pre-merge canonical ZIP is retained as historical snapshot storage.
8. Delete the stage folder. The browser then downloads the new canonical repository ZIP directly from Drive for UI hydration without retaining it in the PR diff cache. Persisted repository file metadata is intentionally empty because the server does not inspect archive entries.

### 11.10 Repository rename and Name change

Repository settings rename updates the manifest object in the global registry and remaps keyed in-memory/global structures before saving repository/global state. It does not rename existing issue/PR stable IDs or rewrite their text. The current mutation also does not rewrite the physical `harbur.repository.json` manifest file, so that creation-time portable manifest can become stale.

Name change identifies every repository owned by the actor via `settings` maintainer permission, changes owner/id, remaps global keys/events/watches/activity, saves each affected repository state, then global state. This multi-document operation is not transactional.

### 11.11 Delete repository

Admin deletes the repository root folder first, then removes manifest, file/README/ZIP maps, snapshots/events, issue/PR maps and PR ZIP references, loaded markers, all watches/notifications for the repository, and repository activity. A `repo.deleted` global activity record remains under the deleted repository ID.

### 11.12 Backup

Connecting a backup persists target + encrypted-state-held refresh credential in owner app-data with pending status, then launches initial mirror asynchronously. Due backup sync also launches after successful writes, gated by interval and persisted timestamps; no scheduler exists.

A mirror deletes the previous target root, ensures a fresh `Harbur` root, recreates each repository folder/manifest/index/thread state, copies current ZIPs, historical snapshot ZIPs, and PR ZIPs, and writes backup app-data. Cross-account artifact copy temporarily grants anyone-reader on the source and always revokes it. Backup state removes backup credentials and backup targets to prevent secret leakage/recursive backups. Failures update status best-effort and do not roll back the primary mutation.

## 12. Concurrency, consistency, and failure model

- Global and repository JSON saves use the Drive `version` observed on load as optimistic concurrency control.
- Drive adapter detects a changed version before upload and throws a conflict.
- Repository server writes retry known storage conflicts three times from fresh state.
- Notification and backup-status saves also retry conflicts three times.
- High-frequency thread operations avoid repository-index contention through distinct UUID append files.
- Simultaneous issue and PR creations use distinct append files and unique stable IDs; they do not block on a shared issue/PR document. Repository creations use separate new Drive folders, with the global manifest save protected by Drive-version conflict retry.
- Append fold is idempotent by stable entity/comment/activity/notification IDs.
- Compaction is best-effort: failure returns the fully materialized state and leaves append records for a future load.
- Cleanup, backup triggers, notification delivery after a durable append, and obsolete artifact deletion are best-effort.
- Staged PR/sync commits and PR promotion use canonical ZIP ID as compare-and-swap. An open PR's displayed diff is recalculated against the current repository after another merge, but there is no content-level rebase/conflict resolver; a stale PR must still be recreated before merge.
- Repository creation, rename, Name remap, merge, and backup span multiple Drive files and are not atomic transactions. Cleanup reduces debris but cannot provide database-grade atomicity.
- Unreadable existing state fails closed rather than silently resetting data.

## 13. PR auto-clean

When `prAutoCleanDays > 0`, repository load finds PRs whose `createdAt` is before the cutoff regardless of open/closed/merged state. It removes them from the index, PR ZIP map, matching activity IDs, thread docs, append records, and proposal ZIP files after successfully saving the new index. Historical repository snapshots retained in `repositorySnapshots` are not removed by this routine.

## 14. Timing and observability

Server timing uses AsyncLocalStorage when available. `timedWithBreakdown` creates a parent span and collects nested spans; ordinary `timed` joins the active context or logs standalone. Details are scrubbed only by callers choosing fields; never add secrets. Spans log when `HARBUR_TIMING=1` or duration is at least 1000 ms. Prefix is `[harbur:timing]`.

The Drive adapter retries fetch responses with status 429, 500, 502, 503, or 504 up to three attempts using exponential delay `200 * 2^attempt + random(0..99)` ms. Other HTTP failures surface immediately with parsed Google error detail.

## 15. Integration consumer contract

Generate a token with at least 32 random characters. Consumers should encrypt it, pass `Authorization: Bearer <token>`, poll events in ascending cursor order, process each page fully before persisting `nextCursor`, and fetch the exact revision from the event rather than “latest.” Rotating/removing the environment token immediately revokes private/event access.

Example shapes:

```json
{
  "repositories": [{
    "id": "alice/demo",
    "owner": "alice",
    "name": "demo",
    "description": null,
    "visibility": "public",
    "defaultBranch": "main",
    "updatedAt": "<ISO-8601>",
    "latestSnapshot": {
      "revision": "<64 hex>",
      "sha256": "<same 64 hex>",
      "archiveBytes": 123,
      "createdAt": "<ISO-8601>",
      "source": "repository.created",
      "pullRequestNumber": null
    }
  }]
}
```

```json
{
  "events": [{
    "cursor": 1,
    "id": "alice/demo:<revision>:1",
    "type": "repository.snapshot",
    "repositoryId": "alice/demo",
    "revision": "<revision>",
    "createdAt": "<ISO-8601>"
  }],
  "nextCursor": 1,
  "hasMore": false
}
```

On first integration load, repositories missing snapshot metadata are loaded and backfilled from current canonical ZIPs.

## 16. Installation and Google Cloud setup

### 16.1 Local prerequisites

- Node 24 and npm.
- A Google Cloud project and Google account for the owner Drive.
- A Chromium-derived browser for the folder picker attribute used by the UI.

### 16.2 Install and run

```bash
npm ci
cp .env.example .env
# fill only server environment values
npm run dev
```

Development runs Vite on port 3000. `predev` formats the repository and regenerates diagrams, so it mutates formatting/assets before the server starts. Use `npx vite dev --port 3000` if a non-mutating startup is needed during investigation.

### 16.3 Google Cloud configuration

1. Enable Google Drive API.
2. Configure OAuth consent with OpenID/email plus `drive.file` and `drive.appdata` scopes.
3. Create a Web OAuth client.
4. Register `http://localhost:3000` and every deployed origin as both JavaScript origins and redirect URIs, without trailing slash for the redirect value.
5. Put client ID, client secret, and exact admin emails in server environment.
6. Sign in as an admin, open Settings, connect owner Drive, and approve offline access.
7. In development copy the generated refresh token from `.env.local` to the desired secret store. In production persist it in the deployment environment.
8. Create a separate browser API key restricted to Websites, every app origin/referrer wildcard, and only Google Drive API. This key authorizes API usage, not access to private Drive files.
9. Optionally set a 32–512 character integration token.

### 16.4 Commands

| Command | Behavior |
| --- | --- |
| `npm run dev` | format, regenerate diagrams, start port 3000 |
| `npm run build` | regenerate diagrams and build Nitro output |
| `npm run preview` | preview built app |
| `npm run check` | `tsc --noEmit` |
| `npm run lint` | Biome check |
| `npm run format` | Biome write |
| `npm test` | 35 unit tests |
| `npm run diagrams:build` | all `.excalidraw` to same-basename `assets/*.svg` |
| `npm run audit` | fail npm audit at high severity |

### 16.5 Deployment

Netlify builds with `npm run build`, publishes `dist`, and requests Node 22, while current Nitro actually writes `.output`. This mismatch should be validated/fixed before relying on Netlify. The generated Nitro preset is `node-server`; preview uses `npx vite preview`. CI runs checkout, Node 24, `npm ci`, check, lint, test, and build on PR or manual dispatch.

## 17. Suggested development order

When making substantial architectural changes, working through the layers in this order keeps each stage independently testable:

1. Scaffold React 19 + TanStack Start/Router + Vite/Nitro, root shell, route tree, Tailwind/daisyUI, and two-theme bootstrap.
2. Define constants and Zod contracts exactly as above.
3. Implement pure path, repository, issue, PR, search, mention, and quota utilities with unit tests.
4. Implement fflate ZIP adapter and browser upload preparation, including root stripping, `.gitignore`, binary encoding, FNV hashes, sidecars, progress, and XHR resumable PUT.
5. Implement Google Drive REST adapter: authenticated JSON requests, retries, exact/prefix queries, media reads, multipart/versioned JSON save, folder/copy/move/delete, resumable sessions, permissions, quota.
6. Implement global/repository/thread/append serialization and load/materialize/compact logic.
7. Implement domain mutations as append-first operations, then snapshot replacement, repository settings/remap, delete, backup, and cleanup.
8. Implement server authentication/session, token cache, visibility filtering, HMAC tickets, validated server functions, and conflict retry wrapper.
9. Implement AppShellProvider initialization, scoped state merge, dynamic ZIP workflow import, caches, and public action facade.
10. Build discovery, owner, repository shell, README, issue, PR, settings, header, and notification UI.
11. Implement browser GitHub snapshot fetch and interval-gated mirror sync.
12. Implement integration HTTP routes and exact snapshot verification.
13. Add backup mirroring and timing spans.
14. Finish assets, manifest, CI, Nix, Netlify configuration, tests, and diagrams.

### 17.1 Minimum acceptance scenarios

- Anonymous user sees public but not private repositories and can download public ZIP.
- Revoked private access also removes relevant returned notifications.
- Admin creates repository from local folder with ignored/VCS files absent.
- GitHub import uses tree/raw/blob APIs, rejects truncated trees, and honors feature toggle.
- ZIP bodies never pass through application server requests or responses; direct browser/Drive transfer and Drive-side copies are used.
- Tampered/expired/wrong-origin/wrong-actor ticket fails.
- Changed Drive parent/name/size/checksum, unsafe or resource-exhausting client ZIP, or stale base ZIP fails.
- Issue and PR append records survive concurrent distinct writes and compact after five.
- PR completion and merge RPCs contain no diff, diff ID, base/proposal files, or ZIP body.
- Author cannot review own PR; reviewed policy requires another merge-capable user.
- Merge promotes the exact stored proposal through a Drive-side copy and retains the referenced old ZIP.
- Download cleanup schedules on both success and failure.
- Backup contains artifacts and restorable state but no backup credentials or targets.
- Name change remaps owned routes while email authorship remains stable.
- Integration private list/events require exact timing-safe Bearer token.
- Exact snapshot route redirects to a temporary Drive-side copy without proxying bytes.

## 18. Test coverage

The unit tests cover:

- conservative settings defaults and limited repository policy schema;
- exact normalized admin allowlist;
- unsafe/VCS/app-metadata path behavior, bounded ZIP extraction, and repository-name validation;
- GitHub mirror metadata/name inference/default policy;
- root `.gitignore` counts/archive filtering;
- bounded detached download cleanup and credential-free media URLs;
- repository fuzzy search;
- issue ownership transitions;
- client-only PR diffing, immutable proposal behavior, permission/review rules, private grants, binary hashes;
- mention resolution including self-mentions;
- GitHub API/raw fetch and blob fallback;
- staged repository/PR browser ZIP workflows, direct Drive-side merge copy, and base-ZIP pinning;
- changed-file-only PR diff caching, current-base invalidation/recalculation, and no ZIP/full-snapshot cache;
- quota rejection before Drive session creation;
- monotonic exact-revision integration events and constant-time credential checks.

Baseline on 2026-08-14: 35 unit tests, TypeScript, lint, production build, and high-severity dependency audit pass.

## 19. Decision ledger and rationale

| Decision | Reason and consequence |
| --- | --- |
| ZIP snapshots instead of Git | Accessible folder workflow and portable artifacts; loses Git history and conflict semantics |
| Google Drive as only durable store | Minimal infrastructure and user ownership; accepts API latency, quota, and multi-file consistency limits |
| Browser owns ZIP extraction/diff | Keeps archive bytes and untrusted diff data away from the backend; requires bounded extraction and a capable browser |
| Drive-side exact proposal promotion | A malicious merge request cannot substitute different bytes or metadata; stale bases are rejected rather than rebased |
| Server-created direct upload URL | Keeps Drive tokens secret while bypassing app-server archive transfer |
| Temporary public download copy | Enables browser CORS/media fetch without exposing canonical files/tokens; creates cleanup complexity and requires restricted API key |
| Append files for thread writes | Reduces hot shared-index conflicts; reads must fold and periodically compact |
| Versioned JSON saves | Lightweight optimistic concurrency using Drive-native version metadata |
| Base ZIP ID pinning | Recalculates review display against the current base but rejects stale merge/mirror output without pretending to rebase |
| FNV-1a per-file and SHA-256 archive | Cheap browser diffs plus cryptographic immutable revisions |
| Email stable, Name mutable | Reliable authorization/authorship with user-friendly URLs and mentions; renames require key remap |
| Route-scoped hydration and memory-only diff cache | Keeps diff data client-only; selected PR review downloads both complete artifacts |
| Traffic-triggered maintenance | Backup refresh follows trusted writes, GitHub refresh follows due admin sessions, and cleanup follows transfer traffic; no scheduler is assumed |
| Strict README rendering | Supports rich docs while avoiding raw HTML and executable diagram code; project diagrams use Excalidraw SVG exports |
| Exact admin allowlist | Simple, auditable global role with no wildcard surprises |
| Integration event polling | Durable monotonic consumption without webhook delivery infrastructure |
| No service worker | Avoids stale authenticated application/state behavior and hidden cache complexity |

## 20. Known discrepancies and issues

The following product-description, diagram, configuration, and runtime details do not fully align with the current code:

1. There is no checked-in `/api/repo/$owner/$repo/archive.zip` server route. Repository downloads work through a TanStack server function and browser Blob flow.
2. There are no separate `harbur.user-state.v1.*.json` files. Users, watches, and notifications are stored in global `harbur.appdata.v1.json`.
3. Repository discovery uses the manifests serialized in global app-data; current load code does not scan repository folders/manifests to rebuild the registry.
4. Watched activity is derived in the header from watches + loaded activity, not delivered into per-user notification documents.
5. The repository stage/root folder is not renamed to an owner/repository label during commit.
6. Global app-data still changes for repository registry, notifications, user state, watch state, snapshot events, and settings; only high-frequency thread records use append files.
7. The repository header label is hard-coded to “Public repository” even for a visible private repository.
8. Repository settings and merge privileges do not automatically follow global admin role; admins need repository relationship except for explicitly admin-gated actions such as delete.
9. PR Close is visually enabled for every signed-in actor but server permission may reject it.
10. `tsconfig.json` enables `verbatimModuleSyntax`, despite current TanStack guidance warning against it. The checked-in project nevertheless typechecks/builds.
11. Current TanStack build warns that `createServerFn().inputValidator()` is deprecated in favor of `.validator()`.
12. Vitest prints `ReferenceError: module is not defined` from React plus a delayed-close warning, yet reports all tests passing and exits successfully.
13. `predev` runs the formatter, so starting development can modify source formatting.
14. Netlify says publish `dist`, while the current Nitro build outputs `.output`; deployment needs explicit confirmation.
15. Snapshot metadata/events live in one global document and grow without pruning.
16. Names may contain spaces and are placed into URL path params; all navigation must preserve router encoding.
17. Repository settings and owner-Name changes update the manifest objects stored in global app-data but do not rewrite existing `harbur.repository.json` files, so portable manifests can retain creation-time owner/name/access/policy values.

## 21. Production hardening opportunities (not current behavior)

These changes are not currently implemented, but are useful candidates for future work:

- Migrate `inputValidator` to `validator` and align TypeScript settings with the installed TanStack version.
- Add the documented public archive route or remove it from public claims.
- Decide between global user state and per-user documents, then make code/docs/diagrams consistent.
- Add explicit repository-registry recovery from manifests.
- Resolve the Netlify output directory and Node version mismatch.
- Cap/prune integration events and snapshots with a retention contract.
- Strengthen cross-document rename/merge recovery with operation journals.
- Fix test-process shutdown noise and add route/server integration tests.
- Add accessibility and multi-browser testing for folder upload.

## 22. Maintenance checklist

Before releasing architectural or workflow changes, verify that:

- the UI, route set, permissions, defaults, and failure messages remain consistent;
- secrets never enter browser-readable state;
- direct Drive upload/download mechanics retain ticket, origin, quota, and metadata checks;
- state documents and filenames are schema-compatible;
- append folding, numbering, compaction, stale-base rejection, and conflict retries behave deterministically;
- repository creation, GitHub sync, preview, merge, immutable snapshots, integration events, and backup preserve their archive and metadata relationships;
- anonymous/private filtering is enforced on the server, not only hidden in React;
- all acceptance scenarios and the 32 existing behavioral tests pass;
- no service worker is registered;
- documentation distinguishes current behavior from aspirational changes.

Keep this README aligned with product behavior whenever architecture, workflows, or operational requirements change.

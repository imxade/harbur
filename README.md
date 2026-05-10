# Harbur

Harbur is a lightweight GitHub-style workspace that can run on stateless hosting such as Vercel while using Google Drive as its only durable store without any other services. It is also useful for teams that do not want Git workflow friction, because repository publishing is not tied to any VCS. Teams can publish code snapshots, read project README pages, discuss issues, review pull requests, and manage access from one web UI without running Git servers, managing a CLI workflow, browsing Drive folders, or sharing folder IDs.

Projects can start from a local folder upload or, when enabled by an admin, a public GitHub mirror. Visitors can read public README pages and download public repository or pre-merge PR ZIPs without signing in; authenticated contributors can open issues and pull requests when repository policy allows it, review compact PR diff hunks with line numbers, comment with mentions, watch activity, and merge when they have permission. Private repositories stay limited to admins, repository maintainers, and explicitly granted users.

Repository creation is intentionally restricted to admins listed in the deployment environment variable. This keeps Drive storage, API usage, and abuse risk under the control of the instance owner. Teams that need their own repository publishing space can host a separate Harbur instance on free or low-cost serverless platforms and configure their own owner Drive.

The design keeps hosting simple and recovery practical: the app has no database or persistent server process, repositories are stored as portable ZIP snapshots plus small Drive JSON files with structured collaboration metadata, and optional backup Drives can hold a restorable mirror. Only global control state and Drive credentials stay in Drive app-data; repository state and thread append records live beside each repository in normal Drive files. Google Drive credentials and refresh tokens stay server-side or inside Drive app-data, never in browser-readable storage.

![Harbur app showcase](assets/showcase-grid.png)

## Current Scope

- Vercel-hosted TanStack Start app with server functions, no database, no worker, and no stateful server.
- Google Identity Services SSO creates Harbur's own long-lived HttpOnly session cookie. Google Drive tokens and refresh credentials stay server-side or in Drive app-data, never in browser-readable storage.
- Owner Drive setup and backup Drive connections are configured from `/settings` by admins. Production deployments still need the owner `GOOGLE_DRIVE_REFRESH_TOKEN` stored in server environment configuration.
- Repositories are stored as ZIP snapshots plus compact Drive JSON metadata: global app-data, per-repository index state, per-thread issue/PR detail docs, and append-only thread records for high-frequency collaboration events.
- Admins can create repositories from browser folder upload or, when enabled, public GitHub mirror URL. Browser ZIP work and Drive uploads use the staged signed resumable-upload flow described in the architecture overview.
- The web UI includes owner browsing, fuzzy repository search, README rendering with root `assets/` support, ZIP downloads, issues, comments, pull requests, compact diffs, reviews, merge, watches, mentions, public/private access, per-repo policy settings, user Name settings, and admin operational settings.
- Optional backup Drives receive compact restorable mirrors of app-data, repository JSON files, manifests, repository ZIPs, and PR ZIPs.

## Out of Scope

- Any Harbur CLI.
- Manual Drive folder management by users.
- Direct Drive browsing as the product UI.
- Long-running backend workers or a stateful server.
- Native Git hosting over SSH or HTTPS.
- Service workers, offline install, push notifications, or PWA behavior.
- Storing Google access tokens, refresh tokens, client secrets, OAuth codes, Drive credentials, or authorization headers in browser-readable durable storage.

## User Workflows

| Workflow | Entry Point | Primary Actions |
| --- | --- | --- |
| Sign in | Header | Google Identity Services returns a short-lived authorization code; the server exchanges it, verifies the returned identity token, and creates Harbur's long-lived HttpOnly session cookie |
| Search repositories | `/` | Load Harbur Drive config from server functions, read visible repository manifests, and fuzzy-search by owner, repository name, description, labels, or GitHub URL |
| Browse owners | `/` | List public or accessible owners; owner cards open `/$owner` |
| Browse owner repositories | `/$owner` | Show repositories owned by a mutable Name |
| Open repository | `/repo/$owner/$repo` | Render the root README with GitHub-flavored Markdown, Mermaid, KaTeX, and repository asset support. Public repository pages, issues, pull requests, and ZIP downloads are readable without sign-in; mutating actions require authentication and policy permission |
| Create repository | Admin upload on `/` | Select a local folder or enter a public GitHub repository URL. Folder uploads are filtered, counted, hashed, and zipped by the browser with the shared ZIP adapter. GitHub mirror files are fetched through GitHub's CORS-readable API/raw endpoints and packed by the browser. Both paths show browser preparation/ZIP/upload progress, upload directly to an origin-bound server-created Drive resumable upload session, then commit only after signed ticket, Drive file metadata, path, count, size, hash metadata, and sidecar-content validation |
| Delete repository | Admin repository page | Delete the repository folder from Drive and remove the repository, issues, PRs, notifications, watches, and activity from Harbur state |
| Download ZIP | Repository download button | Authorize visibility, create a temporary link-readable Drive copy of the stored repository ZIP, fetch it from the Drive API media endpoint with a restricted browser API key, save it from the browser, schedule cleanup of the temporary copy after the intended fetch starts, and rely on stale-download sweeps only for missed cleanup |
| Create issue | Issue form | Validate labels and body, write one repository append record, emit activity |
| Comment or close issue | Issue detail page | Append comments, linkify plain `http://` and `https://` URLs, highlight mentions, and apply issue state transitions with ownership checks |
| Open PR | PR frontend folder upload | Download the current repository ZIP through a temporary Drive API media copy, filter the uploaded folder in the browser, compute the diff locally for UX, upload one compact changed-file ZIP directly to Drive with the shared signed resumable-upload flow, and commit compact PR metadata/diff summary only if the ticket still matches the current repository ZIP id |
| Review PR diff | PR detail page | Render file-level added/modified/deleted status, content fingerprints, per-file hide/show controls, and compact diff hunks with old/new line numbers |
| Download merged PR ZIP | PR detail page | Download the current repository ZIP plus the selected PR ZIP through temporary Drive API media copies, build the merged ZIP in the browser, and do not mutate Drive state |
| Merge PR | PR detail page | Enforce merge permissions and review policy, build the merged repository ZIP in the browser, upload it through a signed staged resumable upload pinned to the current repository ZIP id, save the repository index/thread state, delete the previous repository ZIP artifact, and emit activity |
| Watch repo | Watch control on a repository | Store per-user watch state and show watched repository activity in notifications |
| Configure repo settings | `/repo/$owner/$repo/settings` | Repository owner sets public/private visibility, issue/PR policy, and private access grants by registered email or unique Name. Private grants can access private repositories, merge PRs, edit issue/PR titles, and close or reopen issues/PRs, but cannot change repository settings |
| Notifications | Header bell | Show mention notifications and watched repository activity in a dropdown. Each item opens the related issue, PR, or repository and marks unread mentions as read |
| Settings | `/settings` | User Name settings for authenticated users, plus admin-only GitHub mirror, GitHub mirror interval hours, new repository defaults, PR auto-clean days, backup interval hours, temporary ZIP download cleanup delay, max-files upload limit, owner Drive connection, and backup Drive controls. Admins can disconnect a backup without deleting the remote mirror, or delete the app-created backup mirror and then disconnect |

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Owner directory, repository search, and admin repository upload |
| `/$owner` | Repositories owned by an owner Name |
| `/repo/$owner/$repo` | Repository overview and README rendering |
| `/repo/$owner/$repo/issues` | Issue list and creation |
| `/repo/$owner/$repo/issues/$number` | Issue detail, comments, close/reopen |
| `/repo/$owner/$repo/pulls` | Pull request list |
| `/repo/$owner/$repo/pulls/new` | PR folder upload flow |
| `/repo/$owner/$repo/pulls/$number` | PR detail, diff, comments, review, close, merge |
| `/repo/$owner/$repo/settings` | Repository access and policy settings for the repository owner |
| `/settings` | User Name settings plus admin-only operational and backup settings |

Names are mutable route/display values. Changing a Name remaps owned repository routes and owner pages, and updates display and mention resolution for that email. Email addresses remain the stable user identifiers for authors, maintainers, comments, reviews, settings updates, watch state, and activity; stored thread text is not rewritten.

## Module Map

| Path | Purpose |
| --- | --- |
| `src/routes/__root.tsx` | Root document, metadata, app shell mounting. Must not register a service worker. |
| `src/routes/index.tsx` | Owner discovery, repository search, and admin repository upload. |
| `src/routes/$owner.tsx` | Owner repository list. |
| `src/routes/repo.$owner.$repo*.tsx` | Repository route files that select overview, issues, PR, PR creation, PR detail, and repository settings views. |
| `src/routes/settings.tsx` | User profile settings, admin operational settings, owner Drive connection, and backup Drive controls. |
| `src/components/AppShellProvider.tsx` | Client app shell context. It loads auth/session state, loads shell Drive state, loads repository detail on demand, merges route-scoped state responses, prepares browser uploads, and calls server functions. |
| `src/components/app-pages/` | Route-facing page modules for repository overview, issues, PRs, settings, loading states, thread UI, and file diffs. |
| `src/components/app-pages/FileDiffView.tsx` | PR file diff rendering. It uses `diff`/jsdiff `structuredPatch` for hunk generation and keeps binary files as a "Binary file changed" row. |
| `src/components/LinkifiedText.tsx` | Shared plain-text URL renderer for `http://` and `https://` links in repository descriptions and issue/PR messages. |
| `src/components/ReadmeRenderer.tsx` | README Markdown rendering with GFM, Mermaid, KaTeX, raw HTML disabled, and repository asset URL rewriting. |
| `src/components/RepositoryCard.tsx` | Repository list card used by owner and search surfaces. Repository description links stay independently clickable without nesting anchors inside the card route link. |
| `src/lib/google-auth-client.ts` | Browser Google Identity Services loader and authorization-code popup helper for sign-in, owner Drive connection, and backup Drive connection. It never receives Drive tokens. |
| `src/lib/server-functions.ts` | TanStack Start server functions for sessions, authorization, owner Drive access, backup Drive token exchange, repositories, issues, PRs, settings, and downloads. |
| `src/lib/drive-state.ts` | Drive-backed application state coordinator. It loads and saves the global app-data document, per-repository index JSON, per-thread issue/PR JSON, append-only thread records, ZIP artifacts, backup sync status, and domain operations. |
| `src/lib/google-drive.ts` | Server-side Google Drive API adapter using owner access tokens supplied by server functions. |
| `src/lib/client-zip-workflows.ts` | Shared browser ZIP workflow for repository creation, GitHub mirror creation/sync, PR creation, merge ZIP replacement, cached ZIP hydration, pre-merge ZIP synthesis, quota checks, and signed staged Drive uploads. |
| `src/lib/drive-quota.ts` | Shared owner Drive quota parsing, formatting, header/settings display helpers, and client-side upload preflight checks with safety margin. |
| `src/lib/github.ts` | Browser-side public GitHub repository lookup plus tree/raw file fetch for mirror creation and due mirror refresh. |
| `src/lib/upload-client.ts` | Browser folder filtering, accepted-file counting, client-side ZIP creation, repository ZIP extraction, direct Drive upload-session transfer, and upload progress. |
| `src/lib/zip.ts` | Shared browser ZIP adapter for archive creation and extraction used by uploads, PR diffs, merges, pre-merge ZIP synthesis, GitHub mirrors, and client ZIP hydration. |
| `src/lib/download-client.ts` | Browser download helper for Drive API media ZIP blobs and client-built pre-merge PR ZIP blobs. |
| `src/lib/search.ts` | Owner and repository grouping plus fuzzy repository search over visible shell metadata. |
| `src/lib/readme-assets.ts` | README asset path resolution for files under the repository root `assets/` directory. |
| `src/lib/security/paths.ts` | Shared unsafe path and VCS metadata path checks. |
| `src/lib/repositories/` | Manifest creation, repository name rules, upload validation, content fingerprints, ZIP/download filtering. |
| `src/lib/issues/` | Issue state transitions, labels, comments, ownership checks, mention parsing. |
| `src/lib/pulls/` | PR schemas, folder upload diffing, compact changes, merge guards, and merge application helpers. |
| `src/lib/activity/` | Activity record types shared by Drive state and UI activity feeds. |
| `src/lib/settings/` | Settings schema, defaults, and bootstrap config. |
| `src/styles.css` | Tailwind v4, typography plugin, and daisyUI theme declarations. |
| `vite.config.ts` | TanStack Start, Nitro, TanStack devtools, React, React compiler, Tailwind, and daisyUI Vite wiring. |
| `scripts/export-excalidraw.ts` | TypeScript Excalidraw export script. It finds every `*.excalidraw` file in the repo and writes the matching `assets/<name>.svg` file. |
| `docs/diagrams/*.excalidraw` | Editable architecture diagram sources for the committed README SVGs. |
| `tests/unit/` | Deterministic unit tests for current domain behavior. |

## Data Contracts

Runtime validation uses `zod` at import, form, route, and storage boundaries.

Important settings defaults:

```json
{
  "schema": "harbur.settings.v1",
  "ownerName": "harbur-<random>",
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
  "uploadLimits": {
    "maxRepoUploadBytes": 2147483648,
    "maxPrUploadBytes": 536870912,
    "maxSingleFileBytes": 104857600,
    "maxFilesPerUpload": 20000
  },
  "backupTargets": []
}
```

Repository creation defaults are stored settings. The admin UI exposes public GitHub mirror enablement, GitHub mirror interval hours, default repository visibility, default issue/PR policy for new repositories, PR auto-clean days, backup interval hours, temporary ZIP download cleanup delay milliseconds, `maxFilesPerUpload`, detailed owner Drive usage in settings, and a minimal owner Drive usage indicator in the header.

Repository names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`: only letters, numbers, dots, underscores, and hyphens; a leading letter or number; no spaces; maximum length 100 characters.

Operational settings:

| Setting | Behavior |
| --- | --- |
| `githubMirrorSyncIntervalHours` | Limits automatic GitHub mirror refresh to at most once per mirrored repository in that many hours during admin sessions. `0` disables automatic mirror refresh. Normal public/user reads do not trigger GitHub fetches or Drive writes. Public mirror imports use GitHub's unauthenticated API/raw endpoints from the browser, so GitHub public rate limits and tree-size limits can reject very large or high-frequency imports. |
| `prAutoCleanDays` | Deletes pull requests older than the configured number of days the next time their repository state is loaded. `0` disables PR auto-clean. |
| `backupSyncIntervalHours` | Limits automatic full backup mirrors to at most once per connected backup Drive in that many hours. `0` disables automatic background backups. Successful mutations opportunistically start a background backup only when a connected Drive is due. |
| `downloadCleanupDelayMs` | Waits this many milliseconds before deleting temporary ZIP download copies after the browser starts the intended media fetch. `0` schedules cleanup without delay. Cleanup tickets and stale-download sweeps include this delay plus the fixed grace window. |
| `uploadLimits` | Browser preflight validates local repository/PR folders for immediate UX. Server-side quota, signed-ticket, Drive metadata, submitted path/count/size/hash metadata, and sidecar validation remain authoritative before commit. |

Backup Drives connected from `/settings` receive a compact restorable mirror: global app-data without backup credentials, repository index/thread JSON files, repository ZIP artifacts, manifests, and PR ZIP artifacts. Append records are materialized into the mirrored index/thread JSON instead of copied as separate append files. A restore is performed by configuring `GOOGLE_DRIVE_REFRESH_TOKEN` for the backup Drive account and starting the app against that mirrored `Harbur/` state.

Implementation constants:

| Area | Value |
| --- | --- |
| App and schema names | App name `Harbur`, slug `harbur`, schemas `harbur.appdata.v1`, `harbur.settings.v1`, `harbur.repository.v1`, `harbur.repository-state.v1`, `harbur.repository-thread.v1`, and `harbur.repository-append.v1`. |
| Actors and config | Anonymous actor id is `anonymous`, anonymous email is `anonymous@harbur.local`, actor roles are `anonymous`, `user`, and `admin`, repository ids are `<owner>/<name>`, bootstrap config provider is `google-drive`, and app-data version is `1`. |
| Drive filenames | `harbur.appdata.v1.json`, `harbur.repository.zip`, `harbur.repository.json`, `harbur.repository-state.v1.<repository-root-folder-id>.json`, `harbur.repository-thread.v1.<repository-root-folder-id>.<thread-id>.json`, and `harbur.repository-append.v1.<repository-root-folder-id>.<append-id>.json`. |
| Staged artifacts | Upload folders use `upload-<uuid>-<label>` and `harbur.upload.zip` for staged non-repository ZIPs. Download folders use `download-<uuid>-<label>`. Labels are lowercased, non `[a-z0-9._-]` characters become `-`, leading/trailing dashes are trimmed, and labels are capped at 80 characters. |
| Sessions and timing | Session cookie names are `harbur_session` in development and `__Host-harbur_session` in production. Harbur session max age is 400 days. Session passwords and ticket HMACs are derived from the server-only `GOOGLE_DRIVE_CLIENT_SECRET`; there is no separate session-secret variable. Slow timing spans log at 1000 ms unless `HARBUR_TIMING=1` logs all spans. |
| Upload staging | ZIP upload tickets expire after 2 hours. Stale upload sweep grace is 1 hour after ticket expiry and deletes at most 10 stale upload folders per sweep. Upload preflight uses a 10 MiB Drive quota safety margin. Browser ZIP compression level is 3. |
| Download staging | Temporary download cleanup delay admin-configurable. Cleanup grace is 1 hour after the configured delay, and stale download sweeps delete at most 10 folders per sweep. |
| Sidecar caps | README root `assets/` sidecars include at most 20 files and 2 MiB total. Selected PR base-side diff sidecars include at most 200 files and 2 MiB total. |
| Append compaction | Repository append compaction runs after at least 5 append records accumulate for a repository load. |
| Drive queries | Exact Drive searches request up to 10 results; prefix searches request up to 1000 results. |
| Activity kinds | Activity records use `repo.created`, `issue.created`, `issue.closed`, `issue.reopened`, `issue.commented`, `pr.created`, `pr.closed`, `pr.commented`, `pr.merged`, `repo.watched`, `repo.deleted`, `repo.synced`, and `settings.updated`. |

Validation and content contracts:

- Browser folder uploads strip a common selected root folder, apply only the root `.gitignore`, exclude VCS metadata paths, reject unsafe paths, reject duplicate normalized paths, enforce configured file/count/byte limits, and build one ZIP.
- Unsafe paths are empty paths, paths escaping through `..`, paths containing NUL bytes, and paths that normalize differently after slash normalization. Blocked VCS path segments are `.git`, `.hg`, `.svn`, `_FOSSIL_`, `.fslckout`, `.fossil-settings`, and `CVS`.
- Repository exports also exclude Harbur metadata path segments: `issues`, `pulls`, `activity`, `feeds`, `audit`, `settings`, and `credentials`.
- When repository file content is stored in JSON sidecars or thread documents, it is stored as UTF-8 text when it decodes cleanly and contains no NUL bytes; otherwise it is stored as base64 with `encoding: "base64"`.
- Content hashes use 32-bit FNV-1a over file bytes, rendered as an 8-character lowercase hex string.
- PR diffs compare normalized paths and content hashes. Compact PR ZIPs contain only added and modified files; deleted-file intent is represented in PR diff metadata and remains a production-readiness item to verify before it is treated as authoritative.
- Mention resolution checks registered user Names using exact, dashed-space, compact-space, and sanitized lowercase handle aliases, and supports self-mentions.
- Upload tickets and download cleanup tickets are base64url JSON payloads signed with HMAC-SHA256 using the server session secret. Verification uses timing-safe signature comparison, expiry checks, and request-origin checks.
- ZIP upload tickets are discriminated by `repository`, `pull-request`, `pull-merge`, or `github-mirror-sync`. Repository tickets bind actor email, owner, repository name, upload folder id, ZIP byte size, origin, and expiry. PR, merge, and mirror-sync tickets also bind repository id, repository root-folder id, base repository ZIP id, and, for merge, the PR number.
- Completion calls never send ZIP bodies to server functions. They send the uploaded Drive file id, signed ticket, and submitted path/count/size/hash metadata; the server verifies Drive parent/name/byte-size metadata, quota, permissions, base ZIP id pins, and submitted metadata before committing state.
- Temporary download copies get a Drive `anyone`/`reader` permission with `allowFileDiscovery: false`. Browser ZIP fetches use `https://www.googleapis.com/drive/v3/files/<file-id>?alt=media&acknowledgeAbuse=true&key=<browser-api-key>`, then submit the signed cleanup ticket.

Stored document shapes:

| Document | Durable fields |
| --- | --- |
| Global app-data | `schema`, `config`, `settings`, `rootFolder`, repository manifests, watches keyed by email, user profiles keyed by email, notifications keyed by email, global activity, and backup credentials. Runtime-only loaded repository/thread/file ids and storage versions are added after load and are not required in the stored document. |
| User profile | `email`, mutable `ownerName`, `createdAt`, and `updatedAt`. |
| Notification | `id`, `repositoryId`, `recipientEmail`, `actorEmail`, `sourceId`, `message`, `createdAt`, and `read`. |
| Repository manifest | `schema`, `id`, `owner`, `name`, optional `description`, `defaultBranch`, `vcs`, `visibility`, `rootFolderId`, `policy`, `maintainers`, private `access` grants, optional `githubMirror`, labels, `archived`, `createdAt`, and `updatedAt`. |
| Repository index | `schema`, `repositoryId`, content-free repository file metadata, README/assets sidecar files with content, current repository ZIP id, issue summaries with empty comments, PR summaries with empty comments plus capped base sidecars, PR ZIP id map, and repository activity. |
| Thread document | `schema`, `repositoryId`, `kind` (`issue` or `pull`), and the full issue or PR thread with body, comments, reviews, edits, and selected sidecar content. |
| Append record | `schema`, UUID `id`, `repositoryId`, `createdAt`, append `kind`, the kind-specific payload, emitted activity, and emitted notifications. Append kinds are `issue.created`, `pull.created`, `issue.commented`, `issue.title.edited`, `issue.message.edited`, `issue.state.changed`, `pull.commented`, `pull.title.edited`, `pull.message.edited`, `pull.reviewed`, and `pull.closed`. |

Repository policy is stored on each repository manifest and can be changed from `/repo/$owner/$repo/settings` by users with `settings` maintainer permission. Admin settings only define the default policy copied into newly created repositories. The active per-repository policy contains exactly these enforced controls:

| Field | Effect |
| --- | --- |
| `issuesEnabled` | Allows or blocks new issue creation and issue state changes. Existing issues remain readable and commentable to signed-in users who can see the repository. |
| `prsEnabled` | Allows or blocks new PR creation and merge. Existing PRs remain readable, commentable, and reviewable to signed-in users who can see the repository. |
| `allowUserCloseOwnIssues` | Allows issue authors to close or reopen their own issues without maintainer triage permission. |
| `requiredStatusForMerge` | `none` allows direct merge by merge-capable users. `reviewed` requires another merge-capable user to click "Mark reviewed" before merge. |

Fixed collaboration rules intentionally remain code-level product behavior rather than stored policy: signed-in users who can see a repository can comment on existing issues and PRs; PR authors can close their own PRs; PR authors cannot mark their own PR reviewed; private access grants can merge, review, close or reopen threads, and edit issue/PR titles but cannot change repository settings; new repository creators receive `triage`, `merge`, and `settings`; new repositories start with `main` as the default branch and built-in `bug`, `enhancement`, and `question` labels.

Drive storage layout:

| Drive Area | File or Folder | Contents |
| --- | --- | --- |
| Owner Drive root folder | `Harbur/` | App-created parent folder for Harbur repository folders. Repository and PR ZIP artifacts live inside those folders. |
| Owner Drive `appDataFolder` | `harbur.appdata.v1.json` | Global state: schema, config, settings, repository manifests, watches, users, notifications, non-repository activity, backup credentials, and runtime-only `storageVersion` after load. |
| Repository folder | `harbur.repository.zip` | Current repository code snapshot as one ZIP artifact. |
| Repository folder | `harbur.repository.json` | Portable repository manifest beside the ZIP artifact. |
| Repository folder | `harbur.repository-state.v1.<repository-root-folder-id>.json` | Per-repository index state: repository file metadata, root README plus capped root `assets/` image sidecars, current repository ZIP id, issue/PR summaries, capped selected PR base diff files, PR metadata/diff, PR ZIP ids, repository activity, and runtime-only repository document version after load. Full repository file contents, PR changed-file contents, and compacted thread comment bodies are not stored in this JSON. |
| Repository folder | `harbur.repository-thread.v1.<repository-root-folder-id>.<thread-id>.json` | Per-issue or per-PR detail document written by append compaction and mutable repo saves. Selected issue/PR detail routes load only the requested thread document instead of every thread body/comment in the repository. |
| Repository folder | `harbur.repository-append.v1.<repository-root-folder-id>.<append-id>.json` | Append-only thread records for issue/PR creation, comments, message/title edits, issue state changes, PR reviews, and PR closes. PR create records store compact PR metadata/diff, capped selected base-side diff files, and the PR ZIP id, not changed-file contents. Concurrent actions write separate files, and repository loads materialize final issue/PR state from the repo index, selected thread docs, and append records. When enough append records accumulate, the loader folds them into the affected thread docs and repository index, then deletes the compacted append files. |
| PR folder | `pull-<uuid>/pull-<uuid>.zip` | Compact PR upload ZIP containing changed files for that pull request. The display PR number is assigned during repository state materialization, not used as the Drive artifact identity. |
| Staged upload folder | `upload-<uuid>-<label>/` | Temporary browser-to-Drive ZIP upload folder under `Harbur/`. Repository upload stages contain `harbur.repository.zip`; after manifest/index/global state commit succeeds, the same folder id is promoted into the repository manifest as the repository root. PR upload stages contain the browser-built compact changed-file `harbur.upload.zip`; completion moves that ZIP under the target repository, appends the PR create record, and deletes the stage folder. Merge upload stages contain the browser-built merged `harbur.repository.zip`; completion moves that ZIP under the target repository, updates repository metadata, and deletes the stage folder. |
| Staged download folder | `download-<uuid>-<label>/` | Temporary ZIP download folder under `Harbur/`. The server copies a committed repository ZIP or compact PR ZIP into this folder, grants link-readable access to that copy only, returns a Drive API media URL plus a signed cleanup ticket, and the browser schedules cleanup after the configured delay once it starts the intended media fetch. Later stale-download sweeps delete old folders if browser cleanup was missed. |
| Backup Drive root folder | `Harbur/` mirror | Compact restorable mirror of global app data without backup credentials, repository index/thread files, repository ZIPs, manifests, and PR ZIPs. ZIP artifacts are copied Drive-to-Drive with temporary source permissions rather than rebuilt on the server. Append records are folded into mirrored index/thread files. |

The server returns only a filtered `AppState` to the browser. `backupCredentials` are stripped before serialization, private repositories are removed for unauthorized actors, stale notifications for repositories the actor can no longer see are filtered out, and route-scoped repository responses only include details for repositories explicitly loaded by id.

Existing app-data, repository index, and thread JSON documents fail closed when they are unreadable or incompatible; the app bootstraps only when the owner app-data document is missing.

## Architecture Overview

Harbur uses TanStack Start server functions as the only backend and Google Drive as the only durable store. The browser handles large ZIP creation, extraction, diffing, and merge synthesis; server functions handle identity, authorization, Drive credentials, signed upload/download tickets, quota checks, metadata validation, and final state commits.

Runtime responsibilities:

| Layer | Responsibilities |
| --- | --- |
| Browser UI | Routes, settings forms, repository browsing, README rendering, issue/PR UI, ZIP creation/extraction, PR diff generation, merge ZIP synthesis, GitHub mirror API/raw file fetch and ZIP packing, direct Drive upload PUTs, and Drive API media fetches for temporary ZIP download copies. |
| Server functions | Google code exchange, Harbur session cookies, admin and repository permission checks, owner/backup Drive access tokens, signed upload/download tickets, quota checks, Drive metadata verification, app-data/repo-state/thread JSON writes, append compaction, backup triggers, and filtered `AppState` responses. |
| Google Drive | Durable storage for app-data, repository manifests, repository ZIPs, compact repository indexes, per-thread documents, append records, staged upload folders, staged download folders, and backup mirrors. |

Design rationale:

- Drive operations are kept small on normal reads. Shell, owner, repository overview, and thread detail routes use the global manifest, compact repository indexes, README/assets sidecars, selected thread docs, and repository root-folder hints instead of extracting repository ZIPs or scanning Drive folders.
- High-frequency collaboration writes avoid shared mutable JSON where possible. Issue/PR creates, comments, edits, reviews, closes, and issue state changes write append JSON records first, then repository loads compact those records into per-thread docs and the per-repo index.
- Large archive bytes avoid serverless request-body, memory, and timeout limits. The browser builds, extracts, diffs, and merges ZIPs; uploads go directly to Drive resumable upload URLs; ZIP downloads and PR hydration use temporary Drive API media copies; backup ZIPs copy Drive-to-Drive.
- Security stays server-owned even when bytes move directly between browser and Drive. Server functions keep OAuth secrets and Drive tokens, sign upload/download tickets, check quota and permissions, pin PR/mirror/merge tickets to the base repository ZIP id, validate Drive metadata, and commit state only after those checks pass.
- Staged upload/download folders are not durable Harbur state until validated and committed. Stale staged artifacts are cleaned best-effort, while canonical repository and PR ZIPs remain private.

The canonical storage layout is listed in the Drive storage table above. The architecture summary below focuses on how that state is read, written, and cleaned up.

Read paths:

| Path | Behavior |
| --- | --- |
| Shell load | Server functions load global app-data, filter private repositories and stale notifications for the actor, and return visible shell metadata. |
| Owner/repository list | Lists use visible manifests and compact repository metadata instead of extracting ZIP artifacts. |
| Repository overview | Reads the repository index README/assets sidecars and renders Markdown without loading the full repository ZIP. |
| Issue/PR detail | Hydrates only the selected thread document plus materialized append state. Selected PR detail may fetch the compact PR ZIP and capped base-side diff files for diff rendering. |
| Repository-scoped calls | The browser sends the visible repository root folder id so the server can start repository Drive reads in parallel with global app-data loading, then authorize the result against the manifest before returning data. |

Write and ZIP paths:

| Mutation | Flow |
| --- | --- |
| Repository creation | Browser filters the selected folder, applies root `.gitignore`, excludes VCS metadata, builds the ZIP, sends sidecar/path/count/size/hash metadata, uploads directly to an origin-bound Drive resumable upload URL, then the server validates the signed ticket and Drive metadata before committing manifest/index state. |
| GitHub mirror creation/sync | Browser reads public repository metadata/tree data from GitHub's API, fetches file bytes from GitHub raw/blob endpoints, packs/validates them through the shared ZIP workflow without applying `.gitignore`, uploads through the same staged Drive flow, and commits only when server ticket and base ZIP checks pass. |
| PR creation | Browser downloads the current repo ZIP through a temporary Drive API media copy, computes the UX diff locally, builds a compact changed-file PR ZIP, uploads it through a signed staged upload pinned to the current repository ZIP id, and commits PR metadata only if that base ZIP id still matches. |
| Merge | Browser downloads the current repo ZIP plus compact PR ZIP through temporary Drive API media copies, builds the merged repository ZIP, uploads it through a signed staged upload pinned to the current repository ZIP id, and the server commits only if permissions, review policy, state, and base ZIP id still match. |
| ZIP download / pre-merge ZIP | Server authorizes access, creates a temporary copy of the committed ZIP artifact, grants link-readable access with link discovery disabled on that copy only, returns a Drive API media URL plus cleanup ticket, and the browser fetches bytes directly from Drive before scheduling signed cleanup after the configured delay. |
| Backup mirror | Server copies ZIP artifacts Drive-to-Drive with temporary source permissions; append records are materialized into mirrored index/thread JSON instead of copied as separate append files. |

Concurrency and consistency:

- High-frequency thread mutations write separate UUID append JSON files, avoiding shared repository-index rewrites for comments, edits, reviews, closes, and issue state changes.
- Repository loads materialize append records into the repository index plus affected thread documents, then delete compacted append records best-effort.
- Global settings, repository settings, watches, cleanup, merge, backup status, manifests, users, and notifications use versioned mutable JSON saves with retry.
- PR creation, merge, and GitHub mirror sync tickets are pinned to the repository ZIP id used by the browser as its base snapshot, so stale browser-generated diffs or merged ZIPs are rejected if the repository changed before commit.
- Repository, issue, PR, watch, settings, backup, merge, and GitHub mirror mutations append activity records in Drive state for repository feeds and watched notifications.
- Repository deletion deletes the repository folder as one Drive object and removes the repository, issues, PRs, notifications, watches, and activity from Harbur state.

Cleanup and recovery:

- Abandoned `upload-*` folders are not considered repositories, PRs, mirror syncs, or merges unless the server validates the signed ticket, Drive metadata, submitted metadata, and commits state. A detached stale-upload sweep runs before new staged upload sessions.
- Temporary `download-*` folders are intended for a single browser media fetch. The browser schedules signed cleanup after the configured delay once the fetch starts, and later download requests sweep stale folders if cleanup was missed.
- Backup sync is opportunistic and interval-gated by persisted backup target timestamps, so stateless serverless instances do not need a resident scheduler.
- Existing app-data, repository index, and thread JSON documents fail closed when unreadable or incompatible; the app bootstraps only when the owner app-data document is missing.

## Architecture Diagrams

The README architecture diagrams are generated SVGs exported from editable Excalidraw source files in `docs/diagrams/`. The low-level design diagram covers storage and runtime internals; the sequence diagram covers read, write, upload, download, OAuth, and backup flows.

![Harbur low-level design and Drive-only internals](assets/harbur-low-level-design.svg)

![Harbur end-to-end sequences](assets/harbur-end-to-end-sequence.svg)

Architecture-affecting changes must update the relevant `docs/diagrams/*.excalidraw` source and regenerate committed SVG assets with `npm run diagrams:build`. Do not edit generated `assets/*.svg` architecture diagrams by hand. New diagrams should be added only when they cover a new concern without duplicating the low-level design or sequence diagrams.

## Security Requirements

- Google OAuth client secrets, Google access tokens, refresh tokens, Drive credentials, OAuth codes, and authorization headers are never stored in browser-readable durable storage.
- Google sign-in, owner Drive consent, and backup Drive consent use Google Identity Services popup code flow. The browser receives only a short-lived authorization code for the current origin; the server rejects origin mismatches and exchanges the code with the Google client secret.
- Harbur stores its own long-lived HttpOnly session cookie after Google identity verification. Production cookies use the `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`, and `Path=/`.
- Owner Drive refresh tokens are read only by server functions from server environment variables. Backup Drive refresh tokens are stored only in primary Drive app-data and are never returned to the browser.
- Admin access requires exact email matches from `APP_ADMIN_EMAILS`. Protected server functions refresh the role from that allowlist before authorizing mutations.
- Non-admin authenticated users can edit only their own Name in global settings. Repository creation, repository deletion, owner Drive connection, backup Drive connection, backup deletion, GitHub mirror defaults, upload limits, temporary ZIP download cleanup delay, and global operational defaults are admin-only. Repository settings require `settings` maintainer permission.
- Private repositories, route-scoped repository details, and notifications are filtered server-side by the actor's current visibility. Revoking access also hides stale notifications for that repository.
- Names are unique mutable route/display handles. Email addresses are stable identifiers for authors, maintainers, access grants, comments, reviews, settings updates, watch state, and activity.
- No Google refresh token is serialized into route data, returned `AppState`, server function return values, localStorage, sessionStorage, browser-readable cookies, or rendered HTML.
- Staged ZIP uploads expose only an origin-bound temporary Drive resumable upload URL plus a signed Harbur ticket. The browser never receives a Drive access token, and repository/PR/mirror/merge state commits only after server-side permission, quota, ticket, base ZIP id, Drive metadata, and submitted metadata checks pass.
- ZIP downloads expose only temporary link-readable copies of committed ZIP artifacts, with link discovery disabled on the copy. Canonical repository and PR ZIPs stay private, and the temporary copy is deleted after the configured cleanup delay once the intended browser media fetch starts. If Drive policy blocks temporary link sharing, the download path fails closed instead of exposing owner credentials.
- Client-submitted PR diff metadata is not a security boundary. A modified browser can lie about a diff; the compact PR ZIP carries added/modified bytes, while deletion intent remains metadata that must be verified before it is treated as authoritative.
- Repository README rendering disables raw HTML. User-authored Mermaid diagrams run with strict security mode; maintained README architecture diagrams are generated from Excalidraw sources.
- Repository exports must exclude Harbur metadata folders such as `issues/`, `pulls/`, `activity/`, `feeds/`, `audit/`, `settings/`, and `credentials/`.
- The app must not register a service worker.

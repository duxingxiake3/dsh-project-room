# Project Room (dsh-project-room)

English | [中文](README.zh.md)

One project = one persistent group chat. The user, the coordinator agent, frontend, backend, testing and ops all talk on the same group-message timeline, while each of them has a **genuinely independent** Harness session, its own working context and real execution capability.

This is not a chat-UI skin: every delivery in the room lands in a real session, task state is driven only by real execution and evidence, and models are routed per member.

---

## 1. Install and enable

The plugin is a pure ESM package with **no installed dependencies**: the host half imports only Node built-ins, and the browser half is a self-registering classic script. No build toolchain and no extra package in the profile is needed.

```powershell
# Clone this repository first
git clone https://github.com/duxingxiake3/dsh-project-room.git
# Then install the cloned directory as a local path in Harness's plugin manager
# (equivalent to dsh plugin install)
#   target: <REPO>
```

After installation the profile's `package.json` gains a `link:` dependency, and `cordis.patch.yml` gains:

```yaml
- insert:
    - id: project-room
      name: 'dsh-project-room'
```

A successful activation writes a boot record, so you can check afterwards "which version is actually running":

```
<DSH_HOME>/storages/project-room/boot-report.json
```

`boot-report.json` records the resolved core version, the file path it was resolved from, the registered tool names, the tool names actually available in the current context, capability flags, and the history of every activation. If the version cannot be determined, the plugin explicitly flags compatibility as unverified in the UI instead of pretending the version is usable.

### Disable and uninstall

- **Disable**: turn off the `project-room` entry in the plugin manager. Already-started tasks continue under the current settings; enabling it again restores from `boot-report.json` and the room database.
- **Uninstall**: remove `dsh-project-room` in the plugin manager. **Removing the plugin does not remove project history**; the room database, messages, tasks, decisions and outcomes remain in `<DSH_HOME>/storages/project-room/rooms.sqlite`, and reinstalling resumes from there.
- A full cleanup is a separate operation: disable the plugin, then delete that directory.
- The plugin never destroys a "borrowed user session" (see section 6).

---

## 2. Create a room

Open the **Project Room** icon in the left sidebar → **New project room**.

| Field | Description |
|---|---|
| Room name | Anything, e.g. "SMS login feature". |
| Workspace directory | The working directory where members actually execute tasks (the `cwd` of member sessions). May be left empty and filled in later in room settings. |
| Overall goal | The goal handed to the coordinator. After submission the coordinator breaks it down, assigns members and drives it forward. |
| Initial members | Tick coordinator / frontend / backend / testing / ops / design / docs; or create only the coordinator and add the rest as needed later. |
| Model per member | Each member may select a model individually, or leave it empty to follow the role/project default. Options come from the providers and model IDs that are really wired up in the host. |

Creating a room writes the room, its members and the `room.created` event **in one transaction**, and only then creates member sessions. An interruption never leaves half a team; member identities land first, so recovery verifies them instead of rebuilding a person.

---

## 3. Each member picks its own model

Three layers of configuration, lowest to highest priority:

| Layer | Location | Description |
|---|---|---|
| Project default | Room settings → Models | Used by members without their own configuration. |
| Role default | Room settings → Models → Role defaults | Presets per frontend/backend/tester/devops. |
| Member-specific | Member details → Model | Bound to a specific memberId; highest priority. |
| Allowed-pool auto-selection | Room settings → Models → Selection mode | Once enabled, the coordinator picks a model **within the allowed pool** for new members/new tasks and publishes the reason; members that are locked are not overridden. |

The default is `fixed`: the user pins each member, and no model is silently swapped.

**Switch semantics (safety boundary)**: after selecting a model in member details and clicking "Apply model", the request currently in flight keeps its old route and the **next request** uses the new model; member identity, avatar, display name, `@` name and task ownership all stay unchanged, and the session is not recreated nor tool side effects repeated. A switch records the config revision and the reason, and old results keep their old provenance.

The "actual route" line shows the provider/model **observed on a real request**, not what the configuration says — it appears only after a call has actually run.

Model identifiers must be written as the `provider/modelID` the host has wired up. Spoken brand names ("use GLM") are not treated as model IDs; a provider whose catalogue cannot be read or whose credentials are invalid is shown as unavailable with a reason, rather than disappearing from the list.

---

## 4. The three kinds of @, and how to hand off the overall task

### 4.1 Three legal input paths

| Path | Operation | Behaviour |
|---|---|---|
| Right-click an avatar → "@ them" | Right-click (long-press on touch / Enter on keyboard) any avatar | Makes that member a recipient, **does not auto-send**, and keeps the existing draft. On yourself it shows "@ yourself", which only leaves a note and triggers no model call. |
| Type `@` and pick | Type `@` or full-width `＠` in the input box | Opens the room's member list; filter by display name/handle/role/alias; ↑↓ to move, Enter/Tab to pick, Esc to close. The first item is "Everyone", showing how many AI members would be reached. |
| Type `@name` directly | e.g. `@backend, why did the API fields change?` | The server resolves it with deterministic rules into the same memberId list as the chip; no need to reopen the picker. |

Resolution rules (`shared/mention-resolver.js`; frontend and backend are **the same code**):

1. Mask body structure first — fenced code blocks, inline code, `>` quote lines, link targets, email addresses and URLs; an `@` in those places wakes nobody.
2. `@` must be at start of text, after whitespace, or after an allowed punctuation boundary; `dev@example.com` and `@scope/pkg` do not trigger.
3. Match exact unique handles first (ASCII case-insensitive), then exact unique aliases and unique display names (NFC-normalized). **No LLM guessing of people**.
4. Naming the same member in different forms produces a single delivery; chip plus text duplication also delivers once.
5. For names containing spaces use `@「Frontend Lin」`; `@Frontend Lin` resolves only the complete alias "Frontend".
6. Forms with no name boundary, such as `@frontendlookatthis`, are **never split by guessing**; the UI asks for a space or punctuation after the name (e.g. `@frontend`).
7. Duplicate names, unrecognized names and members who have left (old alias tombstone) are all reported before sending; you can pick someone or send as plain text — **it never silently redirects to the coordinator**.
8. `@everyone` / `@all` expands to the active-member snapshot **at send time**; `@user` only notifies human members and produces no model call.

When a Chinese IME is in its composition stage, Enter is not stolen (it will not commit in-progress characters early); `Enter` sends and `Shift+Enter` inserts a newline.

### 4.2 Submit the overall task

Fill in the "overall goal" when creating the room, or simply state it to the coordinator in the room (an unmentioned message goes to the coordinator by default). The coordinator then:

1. checks the current state and constraints;
2. persists a structured plan through room tools (work items, dependencies, acceptance criteria, assumptions);
3. validates the plan before submitting (no dependency cycles, every item has acceptance criteria, owners exist);
4. dispatches only tasks whose dependencies are satisfied as `ready`; unsatisfied ones stay visible in a waiting state;
5. keeps coordinating and organising acceptance.

In "plan first" mode the plan is only persisted and not dispatched; it waits for the user to start it.

### 4.3 The user changes a requirement directly

An explicit instruction such as `@frontend change this entry point to SMS verification.` goes through the full path: save the original words → bind the target task → write a new requirement decision revision (a human requirement is adopted directly) → mark the deterministically affected tasks as `needsSync` → notify the relevant members → require each to report its sync state. **Passing results from an old revision cannot be reused**; they must be re-verified against the new revision.

"@frontend why is it designed this way?" is a question and does not turn into a code task by itself.

---

## 5. What you can see in the room

- **Panel**: the top bar has the project title, status, project switcher and task/member entries. Wide screens show three columns — "Project room / Timeline / Tasks and models"; when space is short the side columns collapse into drawers instead of squeezing the chat into a strip. The `Aa` control in the top-right offers **standard / large / extra-large** text sizes, stored on this machine.
- **Timeline**: separated by day; your own messages sit in bubbles on the right, member messages on the left. Fenced code renders as code blocks, and inline code, bold text and delivered mentions have explicit styles; hover a message to reply, or `@` the other side in the input box.
- **Input area**: a frosted-glass input card; the `@` popup supports keyboard selection, and the quote bar, recipient chips and the "how many AI members will be reached" hint are all visible before sending.
- **Member column**: the avatar menu offers `@ them`, view member, view/switch model, view current task, pause and leave; status dots and model provenance (member-pinned / role default / project default / allowed pool) are visible inline.
- **Tasks and models**: the same column has two tabs, "Tasks / Models". The Tasks page shows acceptance progress, task cards (status, revision, owner, acceptance criteria, dependency wait, artifact verification state), project decisions and sync receipts, deliveries and recovery; the Models page shows project defaults, role defaults, selection mode and the allowed pool.
- **Project lifecycle**: the left column separates "Active / Archived / Recycle bin"; the `…` in the top-right offers pause/resume, archive, move to recycle bin, cleanup preview and permanent delete. Projects in the archive or recycle bin are read-only in the UI and never execute, deliver or wake members; restoring only returns them to paused. Moving to the recycle bin keeps 30 days by default (`trashRetentionDays`); permanent deletion requires typing the full project name and ticking a confirmation, and only cleans the plugin's private data; source code, borrowed sessions, worktrees and host logs are kept by default, with a minimal audit tombstone.
- **Deep research**: the coordinator or the user can propose a research run with scope, members and a budget; an approval card that a real human must click appears on the room timeline. Approval covers only the current `proposalRevision + scopeDigest` and never starts the run by itself; it can be rejected, cancelled, or have its scope/budget adjusted (adjusting creates a new revision and invalidates the old approval), and an expired approval cannot start. Clicking "Start research" passes through ResearchGate, which re-checks the project revision, the approval and the budget; once approved, **dedicated research Sessions** are created for the participating members (with an `agent/pre-step` gate, a per-run lock, normal room tools disabled, write paths resolved through the real filesystem, and session-level usage attribution; the supervised prototype does not yet allow research Sessions to run shell, and experiments are still performed by members under supervision). A running research can be paused/stopped; archiving or trashing the project stops the research, revokes the approval and releases the dedicated sessions, and restoring cannot reuse the old approval. After a restart a running research enters `PAUSED_RECONCILE` and must be checked by a human before it can resume; multi-human projects fail closed because the specific approver cannot be verified. The research tools are `room_research_propose / get / start / hypothesis / experiment / finding / report / flowback`; there is no agent-callable approve or delete entry point.
- **Delivery state is honest**: `delivered, use not yet confirmed` and `used by the recipient this turn` are two different states; the latter appears only after the host actually reports consumption. When it cannot be confirmed the UI shows `cannot confirm delivery, reconciling` and stops automatic resends.
- **Technical details** do not spill into the room chat: tool execution and natural speech are presented separately, and group messages carry only meaningful information.

A member's normal reply automatically returns to the room (the final answer of every room-driven turn), so "the agent answered but the room shows nothing" does not happen. To speak early while working, use `room_send`.

---

## 6. Permissions and boundaries

- Author identity is bound by the server from the real caller; writing "I am the boss" in the body grants no permission.
- Room members can read and write only rooms they belong to; tools accept no forgeable senderId.
- Independent root sessions explicitly apply the project's workspace and tool configuration; detail-only members such as design/docs have write and shell tools **really removed** (not asked to refrain via a prompt).
- Host-native permission prompts remain owned by the host; chat in the room is never treated as native approval.
- **Borrowed user sessions**: the plugin never destroys them, and never posts their turns unrelated to the project into the room.
- **Lifecycle operations accept only real human members**: agents cannot call pause, archive, recycle-bin or permanent delete, nor forge confirmation from chat content; permanent deletion additionally requires the full project name and an explicit tick.
- Write work: in a git repository every write attempt uses its own worktree; for non-git projects, or when worktree creation fails, the system **explicitly degrades to serialized writes and says why**, never claiming isolation. After a member leaves or fails, unmerged changes are kept and the working directory is not automatically deleted.

---

## 7. Pause, resume, restart

| Operation | Behaviour |
|---|---|
| Pause member | Stops that member's new automatic execution; messages and tasks are kept, and new `@` mentions show as pending. |
| Resume member | Syncs revision and unprocessed messages first, then continues applicable tasks. |
| Stop current work | Requests cancellation of the current turn and keeps the pending queue (already-executed actions are not promised to be rolled back). |
| Member leaves the room | Ends new assignment and keeps historical authorship; old aliases become tombstones so they no longer mis-deliver to newcomers; unfinished tasks become pending handover. |
| Pause project | Blocks new task admission and member wake-ups first, then requests running members to stop; only after re-reading that members have stopped does it enter "paused", otherwise it stays at "stop unconfirmed", with retry-check or cancel-request available. |
| Resume project | Restores only a paused project to `active` and re-validates/creates member sessions; failures are reported per member. |
| Archive project | Blocks execution and requests stop first; archives after stop is confirmed, keeping messages, tasks, decisions, outcomes and model-binding history; restoring returns it to "paused" and never auto-starts. |
| Move to recycle bin | Immediately enters the stop-blocking state and requests stop; writes a recoverable snapshot and enters the recycle bin only after stop is confirmed; it never claims "deleted" while unconfirmed; source code, borrowed sessions and worktrees are not deleted by default; the default notice keeps 30 days. |
| Restore from recycle bin | Verifies the structural snapshot and resource summary recorded when moved, then restores to "paused"; old side effects are not replayed and old approvals are not restored. |
| Stop reconciliation / cancel request | When the stop result is unknown the project shows "stop unconfirmed"; the real member state can be re-checked; a request that has not yet caused irreversible deletion can be cancelled and return to the previous state. |
| Permanent delete | Allowed only from the recycle bin; requires the full project name and an explicit tick, and refuses projects that still have running members; releases plugin-exclusive resources one by one, and only when all succeed deletes the plugin's private data while keeping a minimal audit tombstone; a partial release failure stops at "cleanup blocked", keeping data and allowing an idempotent retry. |
| Close the room UI | Closes the view only; already-started tasks continue. |
| Restart Harness | Recovers from the room database: rooms, members, messages, tasks, decisions and the delivery ledger; **only restores owned member sessions of active projects** (paused/archived/recycle-bin ones are not restored), uncertain deliveries are retried only after reconciliation, and a short recovery report is given. |

The database uses a schemaVersion and a backup before migration; a single-writer lock guarantees no second process modifies the same project at the same time. If a second instance tries to open the same data, it is explicitly refused.

---

## 8. Known limitations

Only the most important ones to know first:

- **File and command tools for member sessions come from `memberAgentPreset`**: without it, members only have room-collaboration tools. The preset is a **two-part contract** — `meta.agentPreset` only writes the session header, and the real tool tree is mounted onto the member context by `agentPresets.mount()`; the plugin does both (both create and resume), and **both paths have been verified in the real host**: members really ran `node --version`, really wrote files, and passed acceptance.
- **Lifecycle operations never pretend a member has stopped**: archive/recycle-bin blocks new execution first, then requests stop and **re-reads the real agent state**; only a confirmed stop enters the target state, otherwise it stays at "stop unconfirmed" (`BLOCKED`). Verified on the real desktop app: while the stop request was in flight `confirmed=false`, and only after reconciliation succeeded was the project archived.
- **Project lifecycle is a soft-delete loop, not "dropping the database"**: moving to the recycle bin only changes the project state and keeps all plugin data; permanent deletion only clears the project's plugin-private records, the resource-ownership ledger and plugin-owned sessions, and **never deletes source code, user workspaces, borrowed sessions, worktrees or host logs by default**. External copies the plugin cannot prove cleaned are honestly kept and reported. Recycle-bin expiry only shows a date hint and **never auto-purges**. A partial resource release enters "cleanup blocked" (`PURGE_BLOCKED`), keeps the data and allows an idempotent retry.
- **Optional source / temp-file / worktree cleanup is not implemented**: the advanced cleanup in the spec needs a separate dangerous operation, per-path authorization, ownership verification and a host deletion receipt; this version does not provide it, and the cleanup preview explicitly lists the source code, worktrees and host logs that are kept. Any "clean the source code" action must not be treated as supported.
- **Deletion and research approval both require a verifiable human identity**: when a project has multiple active human members, lifecycle operations and research approval fail closed instead of guessing an approver.
- **Deep research is a supervised prototype, not fully autonomous research**: it implements the approval card, scopeDigest/revision, cancel/expiry, budget reservation, dedicated research Sessions (`agent/pre-step` gate, run lock, exact usage attribution by researchId, real-path resolution for writes, shell disabled), pause/stop, archive/recycle-bin grant revocation, and automatable permission and recovery tests. **Not yet implemented**: pre-call interception on shared member sessions, automatic research orchestration/phase loops, product-level management of experience hints, and a complete real research demonstration.
- **The plugin takes effect only when selected as a bundle.** With `installed: true` + `enabled: false`, the plugin's `cordis.patch.yml` does not apply at all, its row is absent from the loader tree, **and no error is reported**.
- **Cross-provider** acceptance requires the host to really wire up a second provider; with only one route, cross-provider compatibility is marked as unmeasured.
- **Prices and cost** record real usage only and **show no amounts** (left empty rather than fabricated when there is no reliable price source).
- The practical difference between `steer` (insert at a step boundary while running) and `queue` (queue for the next turn) requires a long tool call to observe; the UI shows which one a given delivery **actually** used.
- The "alive" feel in the room is a behavioural goal, not something a prompt alone achieves: acceptance looks at real evidence, follow-up actions and artifacts, not message count or emotional wording.
- Non-git projects have no filesystem-level isolation; serialized writes are only a collaboration mechanism and cannot prevent all shell writes.
- Managing the same project from multiple windows/processes: the single-writer lock refuses the second writer.
- **Source hot reload needs a watched directory**: if the plugin is linked to the profile via a junction outside the profile, HMR does not see `src/` by default; add the repository directory to the profile's `hmr.root` to reload in place, otherwise changing `src/` requires reloading the host.

---

## 9. Development and verification

```powershell
# Generate the browser half (from the single source in shared/; never hand-edit generated files)
node scripts/build-client.mjs

# Syntax gate + generated file up to date
npm run check

# Unit tests (@ resolution rules, storage/sequence/idempotency/version conflicts/single writer)
npm run test

# Real Chromium load check of the browser half
npm run harness

# Pack and verify the package contents
npm run pack:verify
```

---

## 10. Technical documentation

- [Deep research — technical documentation](docs/deep-research.md) — state machine, approval and scope freeze, budget ledger, dedicated research sessions, evidence protocol, data model, threat model, recovery and test coverage.

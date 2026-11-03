# Only One Chat

Development preview. One chat in VS Code with a **leader**, the model you reason with, which
works with an **implementer** on another subscription (ADR 0010 in the repository).

## How it works

You talk to the leader. For each request it states the route it takes in the first line of
its answer:

- **rispondo**: it answers. To read the code it uses its own sub-agents, which never write.
- **chiedo**: a decision is missing, and it asks you for it.
- **delego**: any change to the code, small ones included.
  - It explains what it hands over, writes a brief (or a short targeted message for a
    follow-up), and the implementer receives it directly.
  - The implementer keeps its session for the whole chat, so a follow-up costs it little.
  - Afterwards the leader reads the implementer's report and the facts the extension verified
    (changed files, tests run again), then tells you whether everything went well and what does
    not add up.
  - With `onlyOneChat.leaderReview` set to `deferred` it reads them with your next message
    instead, one leader turn less.
- **faccio io**: only when you start with `/fai`, or when no implementer is available. In our
  tests a leader making a one-line change itself cost more than delegating it.

## The chat

The chat opens in an editor tab, which you can move and resize; the layout follows its width.

- **The bar:** the folder and the chat's title, its state (PRONTO, IN CORSO, ASPETTA TE, NON
  PRONTO), STORICO (the chats of this folder), + NUOVA, IMPOSTAZIONI and SQUAD.
- **The thread:** one column; each message opens with a line saying who wrote it, with which
  model, and its state, and COPIA (and ↺ RIPRISTINA QUI on yours) at hand. An agent's tools
  (commands, files read and changed, sub-agents) show as a terminal log inside its turn: the
  latest ones while it works, all of them with "+ N AZIONI"; its context, output, time and, for
  Claude, nominal cost close it. Delegations (D01, D02) and reports are one line, their text one
  click away; then the facts the extension verified and the changes to review.
- **The dock, at the bottom:** what waits for you takes its place — a permission (keys 1, 2, 3;
  Esc denies), a delegation or a report to approve, editable — else the box you write in. It
  grows with the text up to about a third of the panel, then scrolls. Around the text:
  - **LEADER / IMPLEMENTATORE:** who receives it, one per message. Writing to the implementer
    directly is the cheapest way when you already know what to ask; the leader reads that report
    with your next message;
  - **VIA**, the route you ask of the leader: DECIDE LUI, DELEGA, FAI TU, CHIEDI;
  - **CTX:** how full the session of the agent you write to is, after its latest turn;
  - **@ FILE** attaches a file or a folder (see below);
  - **/ COMANDI**, or `/` at the start of the text: `/delega`, `/fai`, `/chiedi`, `/impl`,
    `/leader`, `/allega`, `/nuova` (or `/ferma` while it works), `/squad`, `/impostazioni`;
  - **DELEGHE:** whether you approve each message between the agents or they pass on their own.
- **Enter** sends, **Shift+Enter** starts a new line (the other way round in the settings).

A brief written in the ChatGPT web app (it starts with `<<<OOC-BRIEF`) can be pasted into the
chat. The leader does not rewrite it: it forwards it with targeted notes or corrections only.

## The Squad panel

SQUAD opens a panel over the chat: how the work flows (you, the leader, the implementer), the
roles with their model, permissions, state and context, the events, what waits for you, the
changes, the models the CLIs offer, and the usage of the subscriptions. Select a role to change:

- the model, among those the CLIs offer, read from Codex and Claude Code themselves with no turn
  and no quota. The leader's model stays the one the chat began with; another applies from the
  next chat;
- the reasoning, among the levels that model supports, and the permissions: from the role's next
  turn, in the same session;
- another provider: from the next chat, since a chat keeps its providers.

Nothing changes the roles automatically.

Some starting points:

| Way of working                                     | Leader                                                              | Implementer                                 |
| -------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| You reason in the extension                        | a strong model with high reasoning, e.g. Sol 6.1 high               | an efficient one, e.g. Sonnet low or medium |
| You reason in the ChatGPT web app and paste briefs | the same leader with low reasoning: it only forwards and adds notes | Sonnet medium                               |
| Small, well-defined tasks                          | low or medium                                                       | low                                         |

- Reasoning matters most where decisions are made: in the conversation, not in the forwarding
  of a brief that is already reasoned.
- In our tests the implementer weighs more than the leader: an efficient implementer in a fresh
  session costs less than a strong model doing everything in one long chat.

## Usage of the subscriptions

The Squad panel shows each subscription's 5-hour and weekly windows.

- **Codex** is read from Codex itself, without using quota: when the chat opens, every 2 minutes
  while it is in view, and after each turn.
- **Claude** reports its windows only when a turn starts, so the panel shows the last value seen.

Nothing is read from credential files or session files.

## Settings

IMPOSTAZIONI in the chat's bar (or "Only One Chat: Settings")
opens a page with all the settings, grouped: roles, delegations, your own instructions per role,
sub-agents, permissions and unsaved files, the composer, notifications, the CLIs.

- They are VS Code's own settings: the page says whether a value comes from the default, your
  user settings or the folder's, and SALVA PER chooses where it writes.
- CLI paths, allowed commands, the verify command and the instructions per role are user
  settings only: a folder's settings cannot change them.

## Files and context

- **`@` in the box** (or @ FILE) lists the folder's files and folders; pick one with the arrows
  and Enter: it becomes an attachment above the text. `@` is for files only. **Ctrl+Alt+K** in the editor (or "Add File or
  Selection to Chat" in its context menu) attaches the open file, or the selected lines as
  `file#L10-20`.
- **The agents receive paths**, and read the files themselves: your leader's context does not
  fill with files. Selected lines are copied into the message when they are few (up to 80).
- **CTX** above the text tells how full the session of the agent you write to is, after its
  latest turn; the Squad panel shows it for both roles.

## Reviewing and undoing changes

- **Before each of your messages** the extension records the folder's files in its own storage
  (no git involved).
- **After the message** a MODIFICHE card lists each changed file with the lines added and
  removed. Click a file for VS Code's diff; ACCETTA keeps it, RIFIUTA puts it back as it was.
- **"↺ ripristina qui"** on one of your messages brings the folder back to before it.
- **The conversation is not rewound:** the agents are told, with your next message, which
  files were put back.
- **Not covered:** files over 2 MB, the excluded folders (`.git`, `node_modules`, …), and what a
  command does outside the folder.

## Chats are kept

- **Each chat of the folder is saved** in the extension's workspace storage, together with the
  ids of the agents' own sessions.
- **When you open the panel again**, the most recent chat comes back, and the leader and the
  implementer continue their sessions (`--resume` for Claude, `thread/resume` for Codex).
  Reports of the implementer the leader had not read yet reach it with your next message.
- **Earlier chats** are in STORICO; + NUOVA starts an empty one.
- **What was running or waiting** when the chat was closed is shown as interrupted.

## Scope and safety

- The agents work only in the folder open in VS Code, once it is trusted (Workspace Trust).
- The first request asks for your consent.
- Claude may run only the programs in `onlyOneChat.allowedCommands`; Codex writes inside the
  folder, without network.
- **Permission levels per role**, set in `onlyOneChat.leader.permission` and
  `onlyOneChat.implementer.permission`:
  - `read-only`: no file changes, no commands that write;
  - `ask`: asks you before acting. Codex asks before any command it does not know to be safe,
    Claude before every edit and command;
  - `auto`: acts inside the folder and asks you to go beyond it.
- **When an agent asks**, a PERMESSO card appears in the chat: once, for the session (the same
  command or file only), or no. Stopping the chat declines what is still waiting.

License: MIT.

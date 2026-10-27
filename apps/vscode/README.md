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

`/delega` and `/chiedi` choose the other routes. `@impl` writes to the implementer directly:
it is the cheapest way when you already know what to ask. The leader reads that report with
your next message.

A brief written in the ChatGPT web app (it starts with `<<<OOC-BRIEF`) can be pasted into the
chat. The leader does not rewrite it: it forwards it with targeted notes or corrections only.

## Choosing models and reasoning

Models come from the settings (`onlyOneChat.*`). The reasoning of each role you choose in the
chat header, separately for the leader and the implementer. It applies from that role's next
turn, in the same session, and becomes the setting for the next chats. Nothing changes it
automatically. Some starting points:

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

The **Only One Chat** icon in the activity bar opens a small view, **Utilizzo**. For each
subscription in use it shows the 5-hour and weekly windows, and what the current chat has used.

- **Codex** is read from Codex itself, without using quota: every 2 minutes while the view is
  visible, after each turn, and when you press "Aggiorna".
- **Claude** reports its windows only when a turn starts, so the view shows the last value seen,
  with its time.

Nothing is read from credential files or session files.

## Chats are kept

- **Each chat of the folder is saved** in the extension's workspace storage, together with the
  ids of the agents' own sessions.
- **When you open the panel again**, the most recent chat comes back, and the leader and the
  implementer continue their sessions (`--resume` for Claude, `thread/resume` for Codex).
- **Earlier chats** are in the CHAT selector of the header; "Nuova chat" starts an empty one.
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

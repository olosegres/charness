# README and SETUP screenshots

The Telegram setup in the top-level `SETUP.md` references the images below. They
are sanitized, generated Telegram-style walkthroughs, so the public repository
does not expose a real bot token, chat, group, user id, or project. Keep these
exact filenames and the portrait `720x1280` size (rendered at `width="360"`).

| File | Step | What the image shows |
|---|---|---|
| `01-botfather.png` | Telegram setup 1. Create the bot | The @BotFather chat: `/newbot` giving the token, then `/setprivacy` → this bot → **Disable**. |
| `02-enable-topics.png` | Telegram setup 2. Set up a group | Group settings with the **Topics** (Forum mode) toggle switched on. |
| `03-promote-admin.png` | Telegram setup 2. Set up a group | The bot's admin-rights screen with **Manage Topics**, **Delete Messages**, **Pin Messages** ticked. |
| `04-bind-and-run.png` | Telegram setup 4. Bind a topic | A topic where `/bind <subdir>` then `/claude` (or `/opencode`) was sent and the agent is replying. |

Notes:
- Keep every replacement synthetic or fully redact anything private before
  committing (real chat/group/user ids, group name, tokens, home paths). The
  repo is public.
- Paths are relative, matching `demo.gif`, so they render in the GitHub/GitLab
  web view. Relative images do **not** render on the npmjs.com package page
  (the same limitation applies to `demo.gif`); switch every image reference —
  including `demo.gif` — to an absolute raw URL if npm-page rendering is needed.

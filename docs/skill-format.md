# Skills — format v1

A *skill* is a folder you install under Settings → Skills. It carries a method the model is
handed when one of the skill's trigger phrases is in your message, and optionally the things
that method needs: a library pack, an MCP server, Python helper files for the sandbox. Sigma
Oasis installs a skill by **copying** the folder into `userData/skills/<id>/`; the source is
never referenced again. There is no registry, no URL install and no update channel — what you
installed is what runs, and a confirmation lists everything the folder carries before anything
is written. Reader: `src/main/ipc/skills.ts`; the format: `src/shared/skills.ts`.

```
my-skill/
  skill.json          required
  playbook.md         optional — the method, plain text or Markdown
  pack/               optional — a library pack: manifest.json + docs/ (docs/library-pack-format.md)
  helpers.py          optional — any .py files named in skill.json, staged into the sandbox
```

## skill.json

| field | required | meaning |
| --- | --- | --- |
| `formatVersion` | yes | `1` |
| `id` | yes | `[a-z0-9][a-z0-9-]{1,63}` — also the folder name after install |
| `name` | yes | shown in the panel and in the reply's disclosure |
| `description` | yes | a decision rule, at most 400 characters: when to use it, when not to, one example. It is the first thing the model reads when the skill fires |
| `triggers` | yes | 1 to 20 phrases, 3 to 80 characters. Matched case-insensitively at word boundaries, with fenced and inline code stripped. The first installed skill with a matching phrase wins |
| `playbook` | no | a `.md` file name in the folder; its text (up to 6,000 characters) follows the description in the method block |
| `pack` | no | a sub-folder holding a library pack; installed like any pack under its own manifest id, and left in place when the skill is removed |
| `mcp` | no | `{ command, args, env, cwd }` — saved as an MCP server named `skill-<id>`, **switched off**, approval `ask`. Environment values are stored; the confirmation and the panel show names only |
| `helpers` | no | up to 8 `.py` file names in the folder; when the skill fires they are staged into `/work` as `<id>_<file>` so a program can `import <id>_<file without .py>` |

## What happens on a turn

When a trigger phrase matches, the skill's method block rides the turn where the built-in
playbook would, and the playbook stands down: one method per turn, as always. The block names
the skill, so the reply's disclosure line (*🧩 Skill: name*) and the eval suites read one shape.
The skill's helper files, if any, ride the turn's tool context and appear under `/work` for
`run_python` and `run_code` beside the conversation's attachments.

## What a skill cannot do

- Run anything outside the sandbox. Helper files execute only inside the Workbench; the MCP
  server, if any, is a separate program you turn on yourself under Settings → MCP, with the
  same confirmation and the same approval modes as one you added by hand.
- Reach the network. The sandbox has none; the server's traffic is its own and is stated as
  invisible to the app, as for every MCP server.
- Change any setting, tool toggle, allowlist or grant. A skill is text, documents and files.
- Update itself. Install the folder again to replace it.

## Why no registry

OpenClaw's skills are the closest prior art, and its registry is where its exfiltrating skill
came from. A folder on your disk that you chose, read by an installer that shows you what it
holds, is the whole supply chain here.

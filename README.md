# figma-vault

**English** · [Русский](README.ru.md)

A local store of Figma designs for AI coding agents.

You pull a frame from Figma **once**. It is normalized and written to disk. From then on
Claude Code, Codex or any other MCP client can read it as often as it likes, with no
Figma calls, no token and no rate limits.

```
one developer:      figma-vault add <link>  →  vault  →  git commit
the rest of the team:  the agent reads it over MCP, no Figma token needed
```

## The problem

Figma's MCP server and REST API are rate-limited, and on some seats the limit is tiny.
While building a UI, an agent goes back to the design all the time to check a margin,
a colour or a font size. That can mean dozens of calls in one session. You hit the limit
fast and the work stops.

With figma-vault, the number of Figma calls **doesn't depend on what the agent does**.
Each design costs a fixed number of calls, spent once when you pull it.

|  | Figma Dev Mode MCP | figma-vault |
|---|---|---|
| who calls Figma | the agent, while it works | the CLI, once |
| how many calls | grows with the agent's work | fixed per design |
| does every reader need a token | yes | no |
| works offline | no | yes |

There's a side effect: the design becomes a file in your repository. A developer without
access to the Figma file (no licence, no permissions, no token) still gets the whole
design.

### How it compares

Other projects work on the same problem. The [Framelink Exporter](https://www.figma.com/community/plugin/1626137893880787983/framelink-exporter)
plugin exports a design to a zip for offline use, and there are caching forks of
[Framelink's Figma MCP](https://github.com/GLips/Figma-Context-MCP). figma-vault takes
a different approach:

- **The vault is meant to be committed.** One person pulls a design and the whole team
  reads it from git. Nobody else needs Figma access.
- **Icons cost zero requests.** Vector paths come with the node tree, and the SVGs are
  built locally. Rendering them through Figma would eat the image-render limit.
- **The format is fixed and validated.** `doc.json` follows a written contract,
  and a strict validator checks every file.

## Install

Requires Node.js 22+.

```bash
npm i -g figma-vault
```

### Option 1. Per project

```bash
figma-vault init
```

This creates `.figma-vault/`, registers the server in the project's `.mcp.json` (other
entries are left alone), adds `.env` to `.gitignore` and installs a `/figma` slash command
for Claude Code.

Use `--no-command` to skip the `/figma` command, so the agent gets only the read-only
`vault_*` tools.

### Option 2. Nothing in the repository

```bash
figma-vault init --global
```

The vault lives in `~/.figma-vault/` and the server is registered in the agent's user
config. The project repository never learns the tool exists. Use this when you can't add
config or dependencies to the project.

## Usage

```bash
figma-vault add "https://figma.com/design/KEY/Project?node-id=127-4532"
```

To get the link, right-click a frame in Figma and choose **Copy link to selection**.

```bash
figma-vault limits "<link>"   # check your Figma rate limits BEFORE pulling
figma-vault list              # what has been pulled so far
figma-vault check             # verify the whole chain works
figma-vault demo              # add a demo design, no token needed
```

CLI output, errors and the MCP tool descriptions are in English by default; the `/figma`
command it installs is in English too. [README.ru.md](README.ru.md) is a translation of
the documentation only.

After `init`, Claude Code has one command:

```
/figma <frame link>
```

It pulls the design, reads it over MCP and builds the UI following the project's
conventions.

### What a pull costs in Figma requests

REST API limits depend on the token, the plan and the seat type, and you can't look them
up in advance. Run `figma-vault limits "<link>"` before your first pull. It makes the same
two requests a pull would and tells you whether the pull will go through.

A full pull of one screen costs **three requests**. We measured this on a real design
with 332 nodes:

| | requests |
|---|---|
| node tree (`/v1/files/:key/nodes`) | 1 |
| frame screenshot (`/v1/images`) | 1 |
| raster images (`/v1/images`, in batches of 40) | 1 per 40 images |
| icons and vectors | **0** |

On that design, the 141 icons cost zero requests. **So the cost of a pull doesn't depend
on how many icons the design has.** After the pull, the agent never calls Figma again.

## Check the result against the design

`figma-vault verify` compares the page the agent built with the design. The package ships
no browser: the snapshot is taken with whatever the project already uses (Playwright,
DevTools, the agent's browser tool).

1. Mark the root element of the page with `data-figma-node-id="<root node id>"`, and the
   main blocks with the ids of their nodes.
2. `figma-vault verify <docId> --snippet` prints a script. Run it on the page and save
   what it returns to a file.
3. `figma-vault verify <docId> --snapshot <file>` checks it:
   - **texts:** every visible text of the design must be on the page;
   - **geometry:** each marked block must match the design's position and size, within
     2 px by default (`--tolerance`).

The result is `PASS` (exit code 0), `FAIL` (1, with a list of what is off) or
`INCOMPLETE` (2, when nothing is marked and geometry can't be checked). The `/figma`
command runs this step itself when the project has a browser.

## Try it without a Figma token

You only need a token to pull new designs. Reading works without one, which is the
normal setup for everyone except the person who pulls. So you can test the whole install
without creating a token:

```bash
figma-vault init && figma-vault demo && figma-vault check
```

`check` starts the real MCP server as a child process and talks to it over the protocol.
It exits with code 1 when something is actually broken, so you can use it in CI.

## Token

In Figma, go to Settings → Security → Personal access tokens → Generate new token.
The token needs only one scope: **File content → Read-only**.

Put it in a `.env` file in the directory you run the CLI from, as a line
`FIGMA_TOKEN=figd_...`, or set it as an environment variable. If both are set,
the environment variable wins.

## What the agent gets

The MCP server exposes six read-only tools:

| tool | returns |
|---|---|
| `vault_list` | the designs in the vault |
| `vault_get_doc` | a design's node tree; `maxDepth` limits the depth |
| `vault_get_node` | the subtree of one node |
| `vault_search` | nodes found by name or text |
| `vault_get_tokens` | colours, typography, effects |
| `vault_get_asset` | an image or an icon |

The tree is normalized:

- auto-layout becomes `mode: row|column` with `gap` and `padding`;
- coordinates are relative to the parent;
- styles, gradients and text come in one predictable shape, including differently
  coloured fragments inside one text (`text.runs`);
- nodes hidden in Figma are kept with `hidden: true`. By default the agent doesn't get
  them, but a parent reports how many it has (`hiddenOmitted`). Pass `includeHidden: true`
  when building a reusable component whose optional slots are switched off on this screen.

The raw Figma response is saved next to it in `raw.json` for debugging.

On a real design, normalization shrinks the tree about 7 times:

```
raw.json   1.9 MB   raw Figma response
doc.json   256 KB   what the agent reads
```

This saves more than disk space. An agent that reads 256 KB instead of 2 MB rebuilds
the UI noticeably more accurately.

## Vault layout

```
<vault>/
  index.json                 list of designs
  <docId>/
    doc.json                 normalized tree, the main artifact
    raw.json                 raw Figma response
    screenshot.png           render of the whole frame
    assets/                  icons and images
```

The `figma-vault/doc@1` schema is described in [docs/CONTRACT.md](docs/CONTRACT.md)
(in Russian). A strict validator checks it. Vaults pulled with 0.1.0 (`doc@0`) are
still read as they are; there is no need to pull them again.

`doc.json` stands on its own: the MCP server never reads `raw.json` and never touches
the network.

## Known limitations

This is an MVP. Here is what it can't do yet.

- **Image-render limit.** Figma's `/v1/images` endpoint runs out sooner than tree
  reads do, and the block can last for days. Icons no longer depend on it, but the frame
  screenshot and raster images still do. The client retries up to three times,
  following `Retry-After`, and never sleeps for more than a minute. If Figma asks it to
  wait for days, the pull **keeps the node tree**, records the reason as a warning and
  doesn't fail. Run `figma-vault limits` before pulling.
- **Only colour and weight are kept for fragments inside a text.** A gradient, a
  different font or an underline on part of a text is lost.
- **Designs with many component variants make a large `doc.json`.** Hidden slots are kept
  now. On a 332-node screen that added 3,400 hidden nodes, and the file grew from 444 KB
  to 5 MB. The agent still gets about 100 KB by default, but the file goes into your git.

## How it was tested

The fixture in the repository is synthetic: 29 nodes, enough to install the tool and
confirm the chain works without a Figma token.

We checked accuracy separately, on two real designs whose content isn't published here.
Results on a product screen with 332 nodes, 15 levels deep:

| check | result |
|---|---|
| design texts present in the rebuilt markup | 41 of 41 |
| icons | 15 of 15, 0 broken links |
| placeholders needed | 1 (a raster avatar) |
| Figma requests to pull | 3 |
| `doc.json` against the contract | passes |

**Not checked:** pixel-perfect match. We compare with Figma's reference render by eye,
using `npm run dev` → `/compare/<name>`. `figma-vault verify` checks texts and the
geometry of marked blocks, but not colours, fonts or pixels.

## What it deliberately doesn't do

It isn't a SaaS, a Figma replacement or a real-time sync. There is no auth, billing,
teams or users, and no server side. The MCP server runs on the developer's machine as a
child process of the agent and talks over stdio. There is nothing to deploy.

## More docs (in Russian)

- [docs/INTEGRATION.md](docs/INTEGRATION.md): rolling it out to a team, the no-trace
  mode, checking without a Figma token.
- [docs/ADAPT.md](docs/ADAPT.md): adapting the tool to a project's design system.

## Development

```bash
npm install
npm test          # 57 tests
npm run typecheck
npm run dev       # local preview of rebuilt markup and comparison with the design
```

Two AI agents write this project in parallel, following the protocol in
[AGENTS.md](AGENTS.md): separate areas of the code, a task board and a shared log.
Each commit is tagged with its author.

## License

MIT

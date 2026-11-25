<p align="center"><img src="docs/hero.svg" alt="sibac: SIBA Code, a coding agent for your terminal" width="800"></p>

# sibac (SIBA Code)

A coding agent for your terminal, made by [SIBA](https://siba.az). Website and install line: [code.siba.az](https://code.siba.az). You describe a task; it reads your files, proposes changes and commands, and asks before it does any of them. No dependencies, Node.js only.

It works straight after install: with no settings it answers through SIBA's hosted line, free and without a key.

**Which model answers.** The hosted line (`siba-code`) runs open models, not a model trained by SIBA: at this release Qwen 3.8 27B first, and OpenAI's open-weight gpt-oss models when that one is busy, so the model can change from one reply to the next. The name of the model that really answered is printed under every reply. The one SIBA-trained model on offer is `siba-oak`, a small Azerbaijani model for plain chat: it cannot read or change files. You can also point sibac at Groq or any other OpenAI-compatible endpoint with your own key.

<p align="center"><img src="docs/terminal.svg" alt="The sibac start screen and an example task (illustration: the start screen is the real one, the example session is shortened)" width="720"></p>

<details>
<summary>Contents</summary>

- [How it works](#how-it-works)
- [Install](#install)
- [First run](#first-run)
- [Use](#use)
- [What it asks permission for](#what-it-asks-permission-for)
- [A typical session](#a-typical-session)
- [Skills](#skills)
- [Project guide](#project-guide)
- [What is sent where](#what-is-sent-where)
- [Limits in 0.2.3](#limits-in-023)
- [Development](#development)
- [License](#license)

</details>

## How it works

```mermaid
flowchart LR
  you([You type a task]) --> sibac[sibac<br/>on your computer]
  sibac -->|task, files it read,<br/>command output| model[(Model endpoint<br/>SIBA hosted, Groq,<br/>or your own)]
  model -->|reply and tool requests| sibac
  sibac --> gate{Permission gate}
  gate -->|you say yes| tools[Read, edit, run,<br/>fetch]
  gate -->|you say no| model
  tools -->|result| model
  sibac -->|answer| you
```

The model only proposes; sibac does the work on your machine, and only after the gate lets it through.

## Install

One line, on Windows, macOS or Linux. It needs [Node.js](https://nodejs.org) 18 or newer and takes a few seconds:

```
npm install -g https://github.com/aghasalim/sibac/tarball/main
```

Then type `sibac` in any project folder. To try it once without installing:

```
npx -y https://github.com/aghasalim/sibac/tarball/main
```

With Homebrew (macOS, Linux):

```
brew tap aghasalim/siba
brew trust aghasalim/siba
brew install sibac
```

The `brew trust` line is for Homebrew 7 and newer, which asks before it uses a tap outside its own catalogue. Skip it on older versions.

`sibac update` prints the update command (the same install line). `sibac doctor` checks Node, the settings, the endpoint, git and the shell.

## First run

```
cd your-project
sibac
```

The first time, it shows a menu. Press Enter for the default:

```
  1) SIBA hosted   free, no key needed; runs open models (default)
  2) Groq          with my own key
  3) Another OpenAI-compatible endpoint
```

Choice 2 asks for the model (Enter keeps `openai/gpt-oss-120b`) and your key from https://console.groq.com/keys. Choice 3 asks for the endpoint address, the model and an optional key; a local Ollama is `http://localhost:11434/v1`. Every answer is checked and asked again if it cannot work. The key is not shown while you type it.

The answers are saved in `~/.sibac/config.json` on your computer. `/login` shows the menu again, `/logout` removes the key. If the saved endpoint is not a web address (version 0.1.0 accepted anything there), sibac says so at start and shows the menu instead of failing on every message.

`SIBAC_BASE_URL`, `SIBAC_MODEL` and `SIBAC_API_KEY` win over the file; `SIBAC_HOME` moves the `~/.sibac` folder. A SIBA key (`sk_siba_...`) for the hosted line goes in `SIBAC_API_KEY`, or in choice 3 with the address `https://siba.az/api/code/v1` and the model `siba-code`.

## Use

```
sibac                          # a session in the current folder
sibac -p "fix the failing test"    # one task, then exit (sibac "task" does the same)
sibac --continue               # reopen the latest conversation of this folder
sibac --model siba-oak         # another model for this run
sibac --yes -p "task"          # approve changes and commands inside this folder without asking
```

In a session:

| Type | What it does |
|---|---|
| `/help` | the commands and skills |
| `/model`, `/model <name>` | list the models, switch |
| `/login`, `/logout` | choose the model line again, remove the saved key |
| `/status` | endpoint, model, tokens used this session, folder, version |
| `/init` | looks at the project and writes `SIBAC.md` |
| `/skills`, `/<skill>` | list the skills, run one |
| `/resume` | reopen an earlier conversation from this folder |
| `/compact` | replace the conversation by a summary, to save tokens |
| `/diff` | `git status` and `git diff` of the folder |
| `/undo` | put back the files the last turn changed |
| `/clear`, `/exit` | start a new conversation, leave |

Tab completes commands and `@paths`; typing `/` lists the matching commands under the prompt. `@some/file` in a message attaches that file. The arrow keys recall earlier messages. Ctrl+C during a reply cancels that reply; at the prompt it empties the line, and pressed twice it leaves.

## What it asks permission for

Reading inside the current folder needs no permission. File changes, shell commands, web fetches and anything outside the current folder are asked first. The full table, the decision diagram and what `--yes` does and does not skip are in [docs/permissions.md](docs/permissions.md).

## A typical session

```mermaid
sequenceDiagram
  participant U as You
  participant S as sibac
  participant M as Model
  U->>S: fix the failing test
  S->>M: task + project guide + skill names
  M-->>S: run npm test
  S->>U: Run this command? [y/n]
  U->>S: y
  S->>M: test output
  M-->>S: edit src/list.js
  S->>U: Change this file? [y/a/n/v]
  U->>S: y
  S->>M: done, test again
  M-->>S: explanation
  S->>U: reply and the model that answered
```

## Skills

A skill is a markdown file with instructions for one kind of task. sibac ships five (`/review`, `/explain`, `/test`, `/fix`, `/commit`) and reads your own. Where they live and how to install more is in [docs/skills.md](docs/skills.md).

## Project guide

If the folder has a `SIBAC.md` (or, without one, an `AGENTS.md`), its text is sent along as notes about the project: how to build and test, the layout, the conventions. `/init` writes one. It is treated as information, not as permission: it cannot approve anything.

## What is sent where

Your task, the files sibac reads, the output of the commands it runs, the skill list and the project guide go to the endpoint in use. On the hosted line that is SIBA's server at siba.az, which passes the request on to the provider that runs the open model. Do not use it in a folder with secrets you would not send there.

Conversations are saved as JSON in `~/.sibac/sessions/`, per folder, for `--continue` and `/resume`. They hold the messages (including file contents the agent read) and never the key. Delete the folder to forget them.

## Limits in 0.2.3

The hosted line is free, shared and rate limited, and `siba-oak` is chat only. The full list is in [docs/limits.md](docs/limits.md).

## Development

```
node test.js        # offline checks of the tools, the permission gate and the parsers
node e2e.js         # drives the real program against a local stand-in endpoint
python3 e2e-pty.py  # the interactive paths in a real pseudo-terminal (Linux, macOS, WSL)
```

## License

MIT

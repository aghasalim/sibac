# sibac (SIBA Code)

A coding agent for your terminal, made by [SIBA](https://siba.az). You describe a task; it reads your files, proposes changes and commands, and asks before it does any of them. One file, no dependencies.

It is not a SIBA model. By default it talks to `openai/gpt-oss-120b` on Groq, and it works with any endpoint that speaks the OpenAI chat-completions API. You bring your own key.

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
## First run

```
cd your-project
sibac
```

The first time, it asks three things: the endpoint (Enter keeps Groq), the model (Enter keeps `openai/gpt-oss-120b`) and your API key. A Groq key comes from https://console.groq.com/keys. The answers are saved in `~/.sibac/config.json` on your computer and sent nowhere except to that endpoint. Delete the file to start over.

You can also set `SIBAC_BASE_URL`, `SIBAC_MODEL` and `SIBAC_API_KEY`; they win over the file.

```
sibac                      # a session in the current folder
sibac "fix the failing test"   # one task, then exit
```

In a session: `/help`, `/clear` (forget the conversation), `/exit`.

## What it asks permission for

| Action | Asks? |
|---|---|
| Read a file, list a folder, search | No |
| Create or change a file in the current folder | Yes: `y` once, `a` for the rest of the session, `n` no |
| Run a shell command | Yes, every time |
| Change anything outside the current folder | Yes, every time, with a warning |

`--yes` approves file changes and commands inside the current folder without asking. It never approves a change outside it. When nobody can answer (for example in a script without `--yes`), every change is refused.

What you send goes to the endpoint you chose: your task, the files it reads and the output of the commands it runs. Do not point it at a folder with secrets you would not send to that provider.

## Limits in 0.1.0

- Replies are not streamed: the answer appears when it is complete.
- The approval prompt previews the first 8 lines of a change.
- A free Groq key allows about 8,000 tokens a minute, so long tasks pause on rate limits.
- Commands run in bash (Git Bash on Windows, PowerShell if it is missing), with a 2 minute limit and no interactive input.
- No conversation resume.

## License

MIT

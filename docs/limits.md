# Limits in 0.2.3

- The hosted line is free and shared. At this release: 10 requests a minute and 200 a day per address (60 a minute and 2,000 a day with a SIBA key), about 7,000 input tokens per request on the first model, replies up to 4,000 tokens. To fit, sibac keeps tool output and history short there, reads long files in pieces, and summarises the conversation once on its own when a request is too large. A short busy signal is waited out; at the daily cap it says so and stops. Large tasks go better with your own key.
- `siba-oak` is chat only: it sees only the last few turns, answers briefly, and is offline at times (it runs on a small server).
- A free Groq key allows only a few thousand tokens a minute per model, so long tasks pause on rate limits there too.
- Replies appear line by line as they arrive, not letter by letter.
- Commands run in bash (Git Bash on Windows, PowerShell if it is missing), with a 2 minute limit and no interactive input.
- `/undo` and the "always" answer last for the running session only.
- sibac needs a real terminal for the session. In an old Git Bash window (mintty) Node sees no terminal: use Windows Terminal, or `winpty sibac`.
- Colours use 24-bit codes where the terminal announces them (`COLORTERM`) and on Windows, 256 colours elsewhere; `NO_COLOR` switches colour and the start animation off.

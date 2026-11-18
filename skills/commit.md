---
name: commit
description: Commit the current changes to git with a clear message, after checking what is in them. Never pushes.
---
# Commit

1. Run `git status --short` and `git diff HEAD` and read the result. If there is nothing to commit, say so and stop.
2. Check the changes before staging: no keys, passwords or tokens, no large or generated files, nothing unrelated to the task. If something looks wrong, stop and tell the user.
3. Stage the files by name with `git add <files>`, not `git add -A`.
4. Write the message in the style of `git log --oneline -5`: one line that says what changed and why, at most about 70 characters; a short body only when the reason is not obvious.
5. Commit, then show `git log --oneline -1`.

Do not push, amend or rebase unless the user asked for exactly that.

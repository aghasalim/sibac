# Skills

A skill is a markdown file with instructions for one kind of task, in the common `SKILL.md` format: a folder with a `SKILL.md` whose frontmatter has `name` and `description`, or a single `name.md`. sibac ships five (`/review`, `/explain`, `/test`, `/fix`, `/commit`) and reads yours from:

- `.sibac/skills/` in the project
- `~/.sibac/skills/` for all projects
- `.claude/skills/` in the project, if it exists (read only)

Run one with `/<name> what you want`. The model can also load one on its own when the task fits; only names and one-line descriptions are sent with every request.

```
sibac skills                              # list them
sibac skills add owner/repo/path/to/skills    # install skill folders from a public GitHub repository
```

`skills add` downloads the repository archive, shows what it found and asks before it writes into `~/.sibac/skills`. It refuses archives with links or paths that leave their folder, and anything large (300 files, 1 MB a file, 8 MB in all). A skill is text the model will follow: read it before you rely on it.

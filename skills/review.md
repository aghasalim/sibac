---
name: review
description: Review the current changes (git diff) or the named files for bugs, risks and missing tests. Reports findings; changes nothing.
---
# Review

1. Find what to review. If the user named files, read those. Otherwise run `git status --short` and `git diff HEAD`; if there is no diff, say so and ask what to review.
2. Read enough of the surrounding code to judge each change: the function it sits in, and its callers when the behaviour changed.
3. Look for, in this order: wrong behaviour and broken edge cases; data loss or security problems (unchecked input, secrets in code, commands built from user text); changed behaviour that no test covers; code that is more complicated than the job needs.
4. Report a short list, most serious first. For each finding: file and line, what is wrong, and the smallest fix. Say plainly when you found nothing serious.

Do not edit files in a review. Do not report style preferences as problems.

---
name: fix
description: Find the cause of a failing test, an error message or a described bug, fix it with the smallest change, and check the fix.
---
# Fix

1. Reproduce it first: run the failing test or command and read the full error. If it cannot be reproduced, say so before changing anything.
2. Find the cause, not the symptom: read the code the error points to, and the code that calls it. Use grep to find every caller of what you are about to change.
3. Make the smallest change that removes the cause. Fix it once, in the shared code, not in each caller.
4. Run the same test or command again and report the real result. If other tests exist, run them too.
5. End with: what was wrong, what you changed (file and line), and what you did not check.

Do not hide the error (an empty catch, a skipped test, a loosened check) and call it fixed.

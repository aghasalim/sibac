---
name: test
description: Run the project's tests, or write a missing test for the named code, and report the real result.
---
# Test

1. Find how tests run here: the scripts in package.json, a Makefile, pytest or go test files, the README. If nothing runs tests, say so and propose the smallest setup instead of inventing one.
2. If the user asked for a new test: read the code under test first, then add one focused test next to the existing ones, in their style. Test behaviour through the public function, including one edge case.
3. Run the tests with run_command. Report the command, how many passed and failed, and the first failing message exactly as printed.
4. If a test fails because the code is wrong, say so and show the cause. Do not weaken or delete a test to make it pass.

# Working rules for this repo

Merges into `master` deploy to aifoundscore.com automatically (Workers Builds). The owner does not
test by hand, so nothing is "done" until it has been tested and verified here.

## Before opening or merging a PR

1. **Every new route, button, or form gets a test that goes through the real router** (e.g.
   `call(env, '/admin/...')` in `src/admin/test/admin.test.js`), not just a unit test of the handler.
   A handler that the router never reaches (a missing allow-list entry, a wrong path) must fail a test.
2. **Prove the test catches the bug**: it fails without the change and passes with it.
3. **`npm test` and `npm run check` both pass** (run `npm ci` first in a fresh worktree). Report the
   pass/fail counts in the PR description.
4. **Click through the change on the PR preview build** before merge when it's something a person
   sees or clicks (a page, a button, an admin action). Say in the PR what was checked and how.
5. If anything couldn't be verified, say so plainly in the PR. Don't call it done.

Extend `parseArgs` in `src/args.js`:

- a `--dry-run` flag, with `-n` as its short form, that sets `dryRun: true` (it is `false` when absent);
- `--out=folder` as another way to write `--out folder`. An empty value (`--out=`) is an error, like a missing one.

Everything that works today must keep working, and unknown options must still be rejected. Add tests and run the suite.

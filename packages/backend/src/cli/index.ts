#!/usr/bin/env node
/**
 * @parcae/backend — CLI entry point
 *
 * Invoked via the `parcae` bin. Parses argv, dispatches, exits. Kept
 * intentionally thin so the real logic lives in testable units.
 */

import { parseArgv } from "./argv";
import { dispatch } from "./dispatch";

dispatch(parseArgv(process.argv.slice(2))).catch((err) => {
  // `dispatch` handles expected errors itself — if we get here, something
  // unexpected happened (programming error, unhandled promise rejection, etc).
  process.stderr.write(
    "[parcae] unexpected error: " +
      (err instanceof Error ? err.stack ?? err.message : String(err)) +
      "\n",
  );
  process.exit(1);
});

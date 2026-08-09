/**
 * Mechanize the `Copilot-Session` trailer instead of relying on an agent to
 * transcribe it (#670).
 *
 * THE MEASURED DEFECT (`.squad/decisions.md`, 2026-08-07): one trailer value
 * covered 74 commits spanning 39h33m on `development` -- more than any single
 * session's lifetime. The value reached every one of those commits through an
 * agent's PROMPT (`git commit --trailer "Copilot-Session=<uuid>"`, hand-typed
 * or copy-pasted from a dispatch brief), never through anything the tooling
 * measured. A value that is *occasionally* right and never checked is worse
 * than one that is visibly absent -- see
 * `.squad/decisions/inbox/ripley-attribution-carries-no-bits.md`. This hook
 * removes the prompt from that path entirely: it reads the value at commit
 * time, from the process, and the agent's prompt text never touches it.
 *
 * WHY `COPILOT_AGENT_SESSION_ID` AND NOT THE "CLOUD" ID THE SKILL DOC USED TO
 * NAME
 *
 * `.squad/skills/git-workflow/SKILL.md` used to instruct
 * `--trailer "Copilot-Session=<cloud-copilot-session-uuid>"` -- a value that
 * exists only in chat/session metadata the agent can see, never in anything a
 * local process can read. That is exactly why it had to be typed by hand: a
 * hook running inside `git commit` has no channel to that id at all. Deriving
 * "the trailer" mechanically therefore cannot preserve that specific
 * namespace -- it has to name a DIFFERENT value that a local process actually
 * has, and that substitution has to be argued rather than assumed, because
 * `scripts/push-guard.mjs` already measured one substitution that failed:
 *
 *   > `COPILOT_AGENT_SESSION_ID` is `e5a64133-...` in this process while the
 *   > commits it writes carry `b459f162-...`. Comparing against it would
 *   > match no trailer at all...
 *
 * That measurement is about comparing a NEW commit's env var against an OLD,
 * hand-typed trailer written under the previous, unmechanized convention --
 * it shows the two values differ, not that either is unfit as a *source*
 * going forward. Once this hook is the thing writing the trailer, "the
 * trailer" and "`COPILOT_AGENT_SESSION_ID` at commit time" become the same
 * value by construction, for every commit made after #670 lands. Confirmed
 * in this repository's own CLI session while writing this file:
 *
 *   COPILOT_AGENT_SESSION_ID = 16bd6f16-b4f8-4054-a461-f5d274535a7d
 *   artifacts_dir             = .../session-state/16bd6f16-b4f8-4054-a461-f5d274535a7d/files
 *
 * -- the same UUID the CLI runtime already uses to name this session's own
 * on-disk state directory, set by the process that launched the CLI, not by
 * anything in this file's prompt. An agent's prompt can misremember a cloud
 * id or copy a stale one from a dispatch brief; it cannot edit the argv/env
 * of the `git commit` child process this hook inspects, because the hook
 * reads that channel directly rather than reading anything the agent wrote.
 *
 * WHY NOT A PER-WORKTREE SESSION-ID FILE INSTEAD
 *
 * #670 also allows "a per-worktree session-id file written once at session
 * creation". That would work too, but it is strictly more moving parts for no
 * added guarantee here: something still has to WRITE that file, at the exact
 * moment that is claimed to be tamper-proof, and the CLI runtime already
 * exposes the same id for free as an environment variable inherited by every
 * `git commit` this session runs. Reading the file would only be justified if
 * the env var were unavailable in some CLI version or execution mode; nothing
 * in this repository's environment currently indicates that.
 *
 * WHAT THIS INTENTIONALLY DOES NOT DO
 *
 * A human committing from an ordinary terminal has no
 * `COPILOT_AGENT_SESSION_ID` at all -- it is a CLI-runtime process variable,
 * not a git or shell-wide setting. This hook is a no-op for that case rather
 * than fabricating a value or blocking the commit; `main`'s catch-all in the
 * CLI entry point below does the same for any unexpected failure, because a
 * provenance nicety must never become a productivity outage.
 *
 * `merge` is the one commit-message SOURCE this hook skips outright: a merge
 * commit's message already represents whatever the branches being joined
 * carry, and stamping a single session's id onto it would misattribute work
 * that may span several. `squash` (`git merge --squash`) is NOT skipped --
 * that source produces one ordinary commit about to be authored in THIS
 * session, which is exactly what the trailer is for.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { COPILOT_SESSION_UUID } from './check-copilot-session-trailers.mjs';

/**
 * The CLI runtime's own per-process session id. Set by whatever launched this
 * `copilot` process, inherited by every child process it spawns (including
 * `git commit`), and never present for a plain terminal `git commit` outside
 * that runtime. See the module header for why this is the source and not the
 * cloud Copilot-session id the skill doc used to name.
 */
export const SESSION_ENV_VAR = 'COPILOT_AGENT_SESSION_ID';

/**
 * Commit-message sources (git's own `$2` argument to this hook) that must NOT
 * receive a mechanized trailer. See the module header's last paragraph for
 * why only `merge` is here and `squash` deliberately is not.
 */
export const SKIPPED_SOURCES = new Set(['merge']);

/**
 * Reads the session id straight from the environment and validates its
 * shape with the exact regex `check-copilot-session-trailers.mjs` enforces,
 * so a hook-written value can never itself be the thing that check rejects.
 * Returns `null` -- never throws -- when the variable is absent or
 * malformed, which is the ordinary state for a human committing outside the
 * CLI runtime.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string | null}
 */
export function resolveSessionId(environment = process.env) {
  const raw = environment[SESSION_ENV_VAR];
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  return COPILOT_SESSION_UUID.test(value) ? value : null;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

/**
 * Appends the trailer via `git interpret-trailers`, so the exact same tool
 * that classifies trailers for `check-copilot-session-trailers.mjs` and
 * `check-copilot-session-collisions.mjs` is the one deciding where this line
 * lands. Measured idempotent: invoking this twice with the same `sessionId`
 * against the same file adds the line once, not twice -- which matters
 * because `git commit --amend` re-runs this hook against a message that may
 * already carry this exact trailer from the commit being amended.
 *
 * Deliberately NOT `--in-place`: that flag has git write its own swap file
 * next to a FILE PATH it is given and then rename that swap file onto the
 * target, and that path is resolved two different, mutually-incompatible
 * ways depending on how it is spelled. A full path handed to `--in-place`
 * writes and renames the swap file relative to the CALLER's cwd (not the
 * target's directory) -- which fails outright on Windows the moment the
 * caller's cwd and the target file are on different drive letters, because
 * an OS-level rename cannot cross drives (`Improper link` /
 * `Permission denied`). The fix attempted before this one -- passing a bare
 * basename with `cwd` pinned to the file's own directory -- traded that
 * failure for a different one: Hicks (#675 QA review) measured Windows
 * `git interpret-trailers --in-place` itself failing to resolve that
 * basename back into an input file (`fatal: could not read input file
 * 'COMMIT_EDITMSG'`) once cwd was reassigned this way, which meant the hook
 * silently no-opped there (a caught error is swallowed by `main`'s
 * catch-all, by design -- see the module header). Both variants asked git to
 * resolve a FILE PATH under some cwd; the difference between them was only
 * which cwd, and neither one is correct in every context this hook actually
 * runs under (a real hook invocation's cwd, vs. a test harness's temp
 * directory on its own drive).
 *
 * Piping the message through stdin/stdout instead removes the file path --
 * and therefore the cwd -- from git's side of this call entirely. Git only
 * ever sees bytes on a pipe; this function alone still touches
 * `messageFilePath`, via ordinary Node `fs` calls that resolve it against
 * the process's real cwd the same way on every OS, with no OS-level rename
 * involved on either end.
 *
 * @param {string} messageFilePath
 * @param {string} sessionId
 * @param {typeof run} [exec]
 */
export function appendSessionTrailer(messageFilePath, sessionId, exec = run) {
  const original = readFileSync(messageFilePath, 'utf8');
  const updated = exec(
    'git',
    ['interpret-trailers', '--trailer', `Copilot-Session=${sessionId}`],
    { input: original },
  );
  writeFileSync(messageFilePath, updated);
}

/**
 * @param {string[]} argv `[commitMsgFile, commitSource, sha]`, exactly what
 *   git passes a `prepare-commit-msg` hook.
 * @param {{ environment?: NodeJS.ProcessEnv, exec?: typeof run }} [deps]
 * @returns {{ applied: boolean, sessionId?: string, reason?: string }}
 */
export function main(argv, deps = {}) {
  const { environment = process.env, exec = run } = deps;
  const [messageFilePath, source] = argv;

  if (!messageFilePath) {
    throw new Error(
      'usage: prepare-commit-msg.mjs <commit-msg-file> [source] [sha]',
    );
  }

  if (SKIPPED_SOURCES.has(source)) {
    return {
      applied: false,
      reason: `commit source is ${JSON.stringify(source)}`,
    };
  }

  const sessionId = resolveSessionId(environment);
  if (!sessionId) {
    return {
      applied: false,
      reason: `${SESSION_ENV_VAR} is absent or not a well-formed UUID`,
    };
  }

  appendSessionTrailer(messageFilePath, sessionId, exec);
  return { applied: true, sessionId };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = main(process.argv.slice(2));
    if (result.applied) {
      console.log(`[prepare-commit-msg] Copilot-Session: ${result.sessionId}`);
    } else {
      console.log(`[prepare-commit-msg] skipped: ${result.reason}`);
    }
  } catch (error) {
    // A hook must never turn a provenance nicety into a productivity outage:
    // report and exit 0 rather than blocking the commit.
    console.error(
      `[prepare-commit-msg] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

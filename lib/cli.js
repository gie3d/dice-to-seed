// Enables JS strict mode for this file: catches silent bugs like assigning to an undeclared variable.
"use strict";

/**
 * lib/cli.js
 *
 * Interactive CLI: walks the user through entering dice rolls and prints
 * the resulting mnemonic. Nothing is written to disk, logged, or
 * transmitted anywhere — output goes only to the terminal (stdout), and
 * dice input is read from stdin (never a command-line argument, so it
 * never lands in shell history).
 *
 * Dice-roll entry has two modes:
 *   - Real terminal (stdin is a TTY): a live, redrawing grid (see
 *     collectDiceRollsInteractive below) that tracks exactly which roll
 *     index you're on and shows everything typed so far, so a 100-digit
 *     sequence is easy to enter correctly. Backspace corrects the last
 *     roll; Enter only confirms once every roll has been entered.
 *   - Piped/redirected stdin (e.g. scripts, tests): a plain line-based
 *     prompt (see collectDiceRollsFromLines below), since a live redrawing
 *     grid has no meaning without a real terminal to draw it on.
 */

// Node's built-in module for reading lines of text from stdin — used to prompt the user interactively.
const readline = require("node:readline");
const { CONFIGS, diceRollsToMnemonic } = require("./mnemonic.js");
const { parseDiceInput } = require("./validate.js");

// A persistent 'line' listener with a small queue, rather than chained
// rl.question() calls. rl.question() registers a fresh one-shot 'line'
// listener per call; when stdin is not a TTY (piped or redirected input,
// as opposed to a human typing at a real terminal), Node can emit several
// buffered 'line' events synchronously before the *next* question() has
// had a chance to register its listener, silently dropping that input.
// Queuing lines as they arrive avoids that race regardless of timing.
// Builds a small helper that lets us `await` one line of input at a time from a readline interface.
function createLineReader(readlineInterface) {
  // Holds lines that have already arrived from stdin but haven't been consumed by the caller yet.
  const bufferedLines = [];
  // Holds pending Promise `resolve` callbacks for callers who asked for a line before one was available.
  const pendingResolvers = [];
  // Fires every time the user (or piped input) completes a line of text ending in Enter/newline.
  readlineInterface.on("line", (line) => {
    // If someone is already waiting for a line, hand it to the oldest waiter immediately.
    if (pendingResolvers.length) pendingResolvers.shift()(line);
    // Otherwise, nobody has asked for it yet — buffer it in the queue for the next call to nextLine().
    else bufferedLines.push(line);
  });
  // Returns a Promise that resolves with the next available line of input.
  return function nextLine() {
    // If a line is already buffered, resolve immediately with it (removing it from the queue).
    if (bufferedLines.length) return Promise.resolve(bufferedLines.shift());
    // Otherwise, park this `resolve` in the pendingResolvers list until the 'line' event above delivers one.
    return new Promise((resolve) => pendingResolvers.push(resolve));
  };
}

// Prints a prompt to the terminal, then waits for and returns the user's next line of input.
async function ask(nextLine, prompt) {
  // Write the prompt without a trailing newline, so the user's typed answer appears on the same line.
  process.stdout.write(prompt);
  // Wait for (and return) the next line of input via the queued line reader above.
  return nextLine();
}

// ---------------------------------------------------------------------
// Interactive grid entry (TTY only)
// ---------------------------------------------------------------------

// How many rolls are shown per row of the live grid (10 keeps rows short and index math easy to read:
// row N covers rolls 10*N+1 .. 10*N+10).
const GRID_COLUMNS = 10;

// Builds the lines to render for the current progress; a pure function (no I/O) so it's easy to reason
// about and, if ever needed, unit-test independently of the terminal.
function buildGridLines(faces, rollCount) {
  // How many grid rows are needed to fit every roll (e.g. 5 rows for 50, 10 rows for 100).
  const rowCount = Math.ceil(rollCount / GRID_COLUMNS);
  // Width to pad index numbers to, so the "NNN-NNN:" labels line up in a column regardless of digit count.
  const indexWidth = String(rollCount).length;
  // Will collect one rendered string per grid row.
  const rows = [];
  for (let row = 0; row < rowCount; row++) {
    // First roll index (0-based) covered by this row.
    const start = row * GRID_COLUMNS;
    // One past the last roll index (0-based) covered by this row, capped at rollCount.
    const end = Math.min(start + GRID_COLUMNS, rollCount);
    // Builds this row's cells: the typed face if we're that far along, otherwise a placeholder dot.
    const cells = [];
    for (let i = start; i < end; i++) {
      cells.push(i < faces.length ? faces[i] : "·");
    }
    // Human-facing 1-based range label for this row, e.g. " 1- 10" or "91-100".
    const rangeLabel =
      String(start + 1).padStart(indexWidth, " ") + "-" + String(end).padStart(indexWidth, " ");
    rows.push("  " + rangeLabel + ": " + cells.join(" "));
  }
  // The next roll the user needs to type (1-based), capped at rollCount once everything is entered.
  const nextRollNumber = Math.min(faces.length + 1, rollCount);
  // Status line shown above the grid: either what to type next, or that entry is complete.
  const statusLine =
    faces.length === rollCount
      ? `All ${rollCount} rolls entered. Press Enter to confirm, or Backspace to fix the last one.`
      : `Roll ${nextRollNumber} of ${rollCount} — type the die face (1-6).`;
  return [statusLine, "", ...rows];
}

// Returns a `redraw(lines)` function that erases whatever it last drew on `stream` and writes `lines` in
// its place — so re-rendering the grid after every keystroke doesn't scroll the terminal or flicker.
function makeRedrawer(stream) {
  // How many lines the previous call to redraw() wrote, so this call knows how far up to erase.
  let previousLineCount = 0;
  return function redraw(lines) {
    if (previousLineCount > 0) {
      // Move the cursor up to the first line of the previous render (it's currently at the end of it).
      readline.moveCursor(stream, 0, -(previousLineCount - 1));
      // Move it back to the start of that line.
      readline.cursorTo(stream, 0);
      // Erase everything from there to the end of the screen — i.e. the entire previous render.
      readline.clearScreenDown(stream);
    }
    // Write the new render. No trailing newline, so the next redraw's cursor math stays correct.
    stream.write(lines.join("\n"));
    // Remember how many lines this render used, for next time.
    previousLineCount = lines.length;
  };
}

// Interactively collects `rollCount` dice rolls one keystroke at a time, redrawing the grid above after
// every keystroke so the user always sees exactly which roll index they're on and can visually verify
// everything typed so far. This is what makes typing a 100-digit sequence tractable without losing your
// place. Only meaningful when process.stdin.isTTY is true (see collectDiceRollsFromLines for the
// non-interactive fallback).
function collectDiceRollsInteractive(rollCount) {
  return new Promise((resolve) => {
    // Raw typed characters ("1".."6"), in entry order — used only for the on-screen grid.
    const faces = [];
    // Parallel array of base-6 digits (0-5) — this is what actually gets resolved to the caller.
    const digits = [];
    // Re-renders the grid in place each time it's called (see makeRedrawer above).
    const redraw = makeRedrawer(process.stdout);

    // Restores the terminal to its normal (cooked, echoing) input mode and stops listening for keystrokes.
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
    };

    // Handles a single keystroke. `key` is undefined for some inputs, hence the `key &&` guards.
    function onKeypress(str, key) {
      // Ctrl+C or Ctrl+D: bail out immediately rather than leaving the terminal stuck in raw mode.
      if (key && key.ctrl && (key.name === "c" || key.name === "d")) {
        cleanup();
        process.stdout.write("\n\nCancelled.\n");
        process.exit(130);
        return;
      }
      // Backspace: remove the most recently entered roll, if any, and re-render.
      if (key && key.name === "backspace") {
        if (faces.length > 0) {
          faces.pop();
          digits.pop();
          redraw(buildGridLines(faces, rollCount));
        }
        return;
      }
      // Enter/Return: only completes entry once every roll has actually been typed.
      if (key && (key.name === "return" || key.name === "enter")) {
        if (faces.length === rollCount) {
          cleanup();
          process.stdout.write("\n");
          resolve(digits);
        }
        return;
      }
      // A valid die face (1-6): append it, unless we've already collected everything expected — extra
      // digits are silently ignored (rather than overflowing), forcing a deliberate Backspace to change one.
      if (str && /^[1-6]$/.test(str) && faces.length < rollCount) {
        faces.push(str);
        digits.push(Number(str) - 1);
        redraw(buildGridLines(faces, rollCount));
        return;
      }
      // Anything else (letters, punctuation, arrow keys, ...) is ignored outright.
    }

    // Enables per-keystroke 'keypress' events on stdin (rather than only line-buffered 'line' events).
    readline.emitKeypressEvents(process.stdin);
    // Puts the terminal into raw mode so keystrokes reach us immediately, unbuffered and unechoed by the
    // terminal itself — required so our own grid rendering is the only thing drawing to the screen.
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    // Draw the initial (empty) grid before any input arrives.
    redraw(buildGridLines(faces, rollCount));
  });
}

// Non-interactive fallback used when stdin isn't a real terminal (e.g. piped input in scripts or tests):
// reads one full line, validates it as a unit via parseDiceInput, and re-prompts on failure. This is the
// original line-based behavior, preserved because raw keypress collection has no meaning without a TTY.
async function collectDiceRollsFromLines(nextLine, rollCount) {
  // Keep asking until the dice-roll input passes validation.
  while (true) {
    // Prompt mentions the exact count expected, based on the roll count chosen earlier.
    const raw = await ask(
      nextLine,
      `Enter your ${rollCount} dice rolls (digits 1-6, spaces optional): `
    );
    // Validate (but never silently fix) the raw typed line against the required roll count.
    const result = parseDiceInput(raw, rollCount);
    // Validation succeeded — hand back the converted 0-5 digit array.
    if (result.ok) return result.digits;
    // Validation failed — show exactly why, and require the user to type the entire sequence again
    // (rather than trying to patch just the bad part, which could introduce ambiguity).
    console.log("Invalid input: " + result.error + " Please re-enter all rolls.");
  }
}

// Prints a titled banner: a divider line, the message, then a matching divider line below it.
const printBanner = (message) => {
  // Prints a visual divider line of 70 '=' characters.
  console.log("=".repeat(70));
  // Prints the banner.
  console.log(message);
  // Prints a matching divider line below the title.
  console.log("=".repeat(70));
};

// Entry point for interactive use: walks the user through entering dice rolls and prints the mnemonic.
// `connectivityCheckSkipped` is true only when the caller bypassed checkInternetConnection() (see
// lib/connectivity.js) because the user passed --ignore-internet-check, and only changes the banner
// text below — it has no other effect.
async function main(connectivityCheckSkipped) {
  // Prints the program's title/banner.
  printBanner("dice-to-seed: offline BIP-39 mnemonic generator from dice rolls");
  // A safety reminder shown before any input is requested, reflecting whether the connectivity probe
  // actually ran (see checkInternetConnection() in lib/connectivity.js) or was explicitly bypassed.
  if (connectivityCheckSkipped) {
    console.log(
      "Internet connectivity check was skipped (--ignore-internet-check). You\n" +
        "have asserted this machine is offline and accepted the risk if it is not.\n"
    );
  } else {
    console.log(
      "No internet connection was detected. For maximum assurance, physically\n" +
        "disconnect this machine from all networks before continuing.\n"
    );
  }

  // Creates a readline interface bound to the process's actual stdin/stdout streams, used for the
  // roll-count question below and — only when stdin isn't a TTY — for dice-roll entry too (see below).
  const readlineInterface = readline.createInterface({
    // Read user input from standard input (keyboard, or a pipe/redirect).
    input: process.stdin,
    // Write prompts/output to standard output (the terminal).
    output: process.stdout,
  });
  // Wraps that readline interface with our queue-based line reader (see createLineReader above).
  const nextLine = createLineReader(readlineInterface);

  // Will hold the validated roll count (50 or 100) once the user answers correctly.
  let rollCount;
  // Keep asking until we get a valid answer — invalid answers are rejected, never guessed or auto-corrected.
  while (true) {
    // Prompt the user and wait for their typed response, then trim leading/trailing whitespace from it.
    const answer = (
      await ask(nextLine, "How many dice rolls will you enter — 50 (12 words) or 100 (24 words)? ")
    ).trim();
    // Only these two exact strings are accepted.
    if (answer === "50" || answer === "100") {
      // Convert the validated string ("50"/"100") into the actual number 50 or 100.
      rollCount = Number(answer);
      // Valid answer received — exit the retry loop.
      break;
    }
    // Explain the expected format and loop back to ask again.
    console.log('Please answer exactly "50" or "100".');
  }

  // Will hold the validated, converted dice digits (array of 0-5 values) once entry succeeds.
  let digits;
  if (process.stdin.isTTY) {
    // Real terminal: done with line-based questions — close this interface before switching stdin into
    // raw mode for the interactive grid below, so the two never compete over the same input stream. This
    // is safe for a TTY because, unlike a pipe, nothing arrives before the user types it.
    readlineInterface.close();
    console.log("Type each die face as you roll it — the grid below tracks your progress.\n");
    digits = await collectDiceRollsInteractive(rollCount);
  } else {
    // Piped/redirected stdin: keep reusing the *same* readline interface/line-reader for dice-roll entry
    // too. A second interface can't safely be opened here — with piped input, all of it (both the roll
    // count and the dice-roll line) can already have been buffered into this interface's queue the
    // instant the pipe was read, so closing it now and opening a fresh one would silently lose that
    // already-buffered dice-roll line (verified: a second interface never observes it).
    try {
      digits = await collectDiceRollsFromLines(nextLine, rollCount);
    } finally {
      readlineInterface.close();
    }
  }

  // Run the full dice-digits -> entropy -> BIP-39-mnemonic pipeline on the validated input.
  const mnemonic = diceRollsToMnemonic(rollCount, digits);
  // Zero out the raw dice-digit array in memory now that it's no longer needed (best-effort scrubbing).
  digits.fill(0);

  // Announce the result, including how many words it should contain, for the user to visually double check.
  console.log("\nYour mnemonic (" + CONFIGS[rollCount].wordCount + " words):\n");
  // Print the actual mnemonic phrase, numbered so it lines up with the numbered write-down sheets most
  // hardware wallets use — this is the only place it's ever output, and only to the terminal.
  const words = mnemonic.split(" ");
  const indexWidth = String(words.length).length;
  words.forEach((word, i) => {
    const number = String(i + 1).padStart(indexWidth, " ");
    console.log(number + ". " + word);
  });
  // Final safety reminder about handling the generated seed phrase securely.
  console.log(
    "\nWrite this down on paper now. Do not store it digitally, screenshot it,\n" +
      "or type it anywhere else. Clear your terminal scrollback when done."
  );
}

module.exports = {
  main,
};

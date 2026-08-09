// Enables JS strict mode for this file: catches silent bugs like assigning to an undeclared variable.
"use strict";

/**
 * lib/dice-input.js
 *
 * Dice-roll entry: collects `rollCount` raw dice-face digits (1-6) from the
 * user and converts them into base-6 digits (0-5) for lib/mnemonic.js.
 *
 * Two modes:
 *   - Real terminal (stdin is a TTY): a live, redrawing grid (see
 *     collectDiceRollsInteractive below) that tracks exactly which roll
 *     index you're on and shows everything typed so far, so a 100-digit
 *     sequence is easy to enter correctly. Backspace corrects the last
 *     roll; Enter only confirms once every roll has been entered.
 *   - Piped/redirected stdin (e.g. scripts, tests): a plain line-based
 *     prompt (see collectDiceRollsFromLines below), since a live redrawing
 *     grid has no meaning without a real terminal to draw it on.
 */

// Node's built-in module for reading lines of text from stdin — used for cursor control in the grid.
const readline = require("node:readline");
const { parseDiceInput } = require("./validate.js");

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
// `nextLine` is the queued line reader built by createLineReader() in lib/cli.js.
async function collectDiceRollsFromLines(nextLine, rollCount) {
  // Keep asking until the dice-roll input passes validation.
  while (true) {
    // Prompt mentions the exact count expected, based on the roll count chosen earlier.
    process.stdout.write(`Enter your ${rollCount} dice rolls (digits 1-6, spaces optional): `);
    // Wait for the next line of input via the queued line reader.
    const raw = await nextLine();
    // Validate (but never silently fix) the raw typed line against the required roll count.
    const result = parseDiceInput(raw, rollCount);
    // Validation succeeded — hand back the converted 0-5 digit array.
    if (result.ok) return result.digits;
    // Validation failed — show exactly why, and require the user to type the entire sequence again
    // (rather than trying to patch just the bad part, which could introduce ambiguity).
    console.log("Invalid input: " + result.error + " Please re-enter all rolls.");
  }
}

module.exports = {
  collectDiceRollsInteractive,
  collectDiceRollsFromLines,
};

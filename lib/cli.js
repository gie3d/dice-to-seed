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
 * Actual dice-roll collection (the live redrawing grid for a real terminal,
 * and the plain line-based fallback for piped/redirected stdin) lives in
 * lib/dice-input.js; this file only wires that together with the roll-count
 * question and the final mnemonic printout.
 */

// Node's built-in module for reading lines of text from stdin — used to prompt the user interactively.
const readline = require("node:readline");
const { CONFIGS, diceRollsToMnemonic } = require("./mnemonic.js");
const { collectDiceRollsInteractive, collectDiceRollsFromLines } = require("./dice-input.js");

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

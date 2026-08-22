// dice-input.js
//
// This file does one job: collect the dice rolls you type, and hand back the
// exact sequence of die faces as text, for example "6142...".
//
// It hands back the faces exactly as you typed them - "1" stays "1", "6"
// stays "6" - because that text is what gets hashed in dice-to-seed.js, and
// keeping it unchanged is what lets you re-compute your own seed on any
// other computer with a plain `shasum -a 256`. Nothing here reorders,
// re-scales or "fixes" your rolls.
//
// There are two ways of collecting rolls, because there are two very
// different situations:
//
//   1. You are sitting at a real terminal and typing by hand. Typing 64 or
//      128 digits without losing your place is hard, so we draw a live grid
//      that redraws after EVERY keystroke and tells you which roll number
//      you are on. Backspace fixes the last roll. See
//      collectDiceRollsInteractive below.
//
//   2. The input is piped in from a file or a test script, so there is no
//      real person and no screen to draw a grid on. Then we simply read one
//      whole line of digits and check it. See collectDiceRollsFromLines.

"use strict";

// Node's built-in helper for reading the keyboard. We use two parts of it:
// per-keystroke events (instead of whole lines), and moving the cursor
// around so we can redraw the grid in place.
const readline = require("node:readline");

// ---------------------------------------------------------------------
// PART 1: Checking a whole typed line of dice rolls
// ---------------------------------------------------------------------

// Looks at one line the user typed and decides whether it is a valid set of
// dice rolls. It never repairs the input: if anything is wrong it explains
// what, and the caller asks again for the whole line.
//
// It returns an object shaped like one of these two:
//   { isValid: true,  diceRollText: "6142..." }
//   { isValid: false, reasonItIsInvalid: "..." }
function checkTypedDiceRolls(typedLine, expectedNumberOfRolls) {
  // Remove every space and tab, so "1 2 3" and "123" are both accepted.
  const withoutSpaces = typedLine.replace(/\s+/g, "");

  // The count has to match exactly. Too few rolls would mean less
  // randomness than promised; too many would mean some were ignored.
  if (withoutSpaces.length !== expectedNumberOfRolls) {
    return {
      isValid: false,
      reasonItIsInvalid:
        "Expected exactly " +
        expectedNumberOfRolls +
        " digits, got " +
        withoutSpaces.length +
        ".",
    };
  }

  // Every character has to be a real die face: 1, 2, 3, 4, 5 or 6.
  for (let index = 0; index < withoutSpaces.length; index = index + 1) {
    const character = withoutSpaces[index];
    if (character < "1" || character > "6") {
      return {
        isValid: false,
        reasonItIsInvalid: "Only digits 1-6 are allowed (one per die face).",
      };
    }
  }

  // All good: hand back the faces exactly as typed, minus the spaces.
  return { isValid: true, diceRollText: withoutSpaces };
}

// ---------------------------------------------------------------------
// PART 2: The live grid (only useful on a real terminal)
// ---------------------------------------------------------------------

// How many rolls are shown per row of the grid. 10 keeps each row short and
// makes the row labels easy to read: row 0 covers rolls 1-10, row 1 covers
// rolls 11-20, and so on.
const NUMBER_OF_COLUMNS = 10;

// Builds the exact lines of text to show on screen for the rolls entered so
// far. It only builds text and returns it - it does not print anything -
// which keeps the drawing code and the thinking code separate.
//
// `dieFacesTypedSoFar` is a list of the characters typed so far, such as
// ["4", "6", "2"]. Rolls not yet typed are drawn as a dot.
function buildGridLines(dieFacesTypedSoFar, totalNumberOfRolls) {
  // How many rows we need in total, rounding up (64 rolls needs 7 rows).
  const numberOfRows = Math.ceil(totalNumberOfRolls / NUMBER_OF_COLUMNS);
  // How wide the row-number labels should be, so they line up in a column.
  // For 128 rolls this is 3, because "128" is 3 characters long.
  const labelWidth = String(totalNumberOfRolls).length;

  const rows = [];
  for (let rowNumber = 0; rowNumber < numberOfRows; rowNumber = rowNumber + 1) {
    // The first and last roll (counting from 0) shown on this row.
    const firstRollOnRow = rowNumber * NUMBER_OF_COLUMNS;
    let lastRollOnRow = firstRollOnRow + NUMBER_OF_COLUMNS;
    if (lastRollOnRow > totalNumberOfRolls) {
      lastRollOnRow = totalNumberOfRolls;
    }

    // Build the cells of this row: the typed face if we have got that far,
    // otherwise a dot as a placeholder for a roll still to come.
    const cells = [];
    for (let index = firstRollOnRow; index < lastRollOnRow; index = index + 1) {
      if (index < dieFacesTypedSoFar.length) {
        cells.push(dieFacesTypedSoFar[index]);
      } else {
        cells.push("·");
      }
    }

    // The label humans read, counting from 1: for example " 1- 10".
    const rowLabel =
      String(firstRollOnRow + 1).padStart(labelWidth, " ") +
      "-" +
      String(lastRollOnRow).padStart(labelWidth, " ");

    rows.push("  " + rowLabel + ": " + cells.join(" "));
  }

  // The line above the grid: either which roll to type next, or that
  // everything has been entered and we are waiting for Enter.
  let statusLine;
  if (dieFacesTypedSoFar.length === totalNumberOfRolls) {
    statusLine =
      "All " +
      totalNumberOfRolls +
      " rolls entered. Press Enter to confirm, or Backspace to fix the last one.";
  } else {
    const nextRollNumber = dieFacesTypedSoFar.length + 1;
    statusLine =
      "Roll " +
      nextRollNumber +
      " of " +
      totalNumberOfRolls +
      " - type the die face (1-6).";
  }

  // A blank line between the status line and the grid, purely for looks.
  return [statusLine, ""].concat(rows);
}

// Creates a "redraw" function that erases whatever it printed last time and
// prints the new lines in the same place. Without this, every keystroke
// would print a whole new grid and the screen would scroll away.
//
// It works by remembering how many lines it printed last time, moving the
// cursor back up that many lines, and clearing from there downwards.
function makeScreenRedrawer(outputStream) {
  let numberOfLinesPrintedLastTime = 0;

  return function redraw(linesToPrint) {
    if (numberOfLinesPrintedLastTime > 0) {
      // The cursor is sitting at the end of the last line we printed, so we
      // move up to the first one (hence the minus, and the minus one).
      readline.moveCursor(outputStream, 0, -(numberOfLinesPrintedLastTime - 1));
      // Then to the very start of that line.
      readline.cursorTo(outputStream, 0);
      // Then wipe everything from the cursor to the bottom of the screen.
      readline.clearScreenDown(outputStream);
    }

    // Print the new version. We deliberately do NOT end with a newline, so
    // that next time the cursor is still on the last printed line and the
    // moving-up maths above stays correct.
    outputStream.write(linesToPrint.join("\n"));
    numberOfLinesPrintedLastTime = linesToPrint.length;
  };
}

// Collects `totalNumberOfRolls` dice rolls one keystroke at a time, redrawing
// the grid after each one. Returns a promise that finishes with the typed die
// faces as one string, once the user has typed every roll and pressed Enter.
//
// Only use this when process.stdin.isTTY is true, meaning a real terminal.
function collectDiceRollsInteractive(totalNumberOfRolls) {
  return new Promise(function (resolve) {
    // The characters typed so far, such as ["4", "6", "2"].
    const dieFacesTypedSoFar = [];
    // Draws the grid in place each time we call it.
    const redraw = makeScreenRedrawer(process.stdout);

    // Puts the terminal back to normal and stops listening for keystrokes.
    // Forgetting this would leave the user's terminal in a strange state.
    function stopListening() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", handleKeystroke);
    }

    // Called once for every key the user presses. `typedCharacter` is the
    // character itself (may be undefined for special keys) and `keyDetails`
    // describes the key, such as { name: "backspace" } or { ctrl: true }.
    function handleKeystroke(typedCharacter, keyDetails) {
      // Ctrl+C or Ctrl+D: give up, but restore the terminal on the way out.
      if (keyDetails && keyDetails.ctrl && (keyDetails.name === "c" || keyDetails.name === "d")) {
        stopListening();
        process.stdout.write("\n\nCancelled.\n");
        process.exit(130);
        return;
      }

      // Backspace: undo the most recent roll, if there is one.
      if (keyDetails && keyDetails.name === "backspace") {
        if (dieFacesTypedSoFar.length > 0) {
          dieFacesTypedSoFar.pop();
          redraw(buildGridLines(dieFacesTypedSoFar, totalNumberOfRolls));
        }
        return;
      }

      // Enter: only finishes if every single roll has been typed. Otherwise
      // it is ignored, so a stray Enter cannot cut your entropy short.
      if (keyDetails && (keyDetails.name === "return" || keyDetails.name === "enter")) {
        if (dieFacesTypedSoFar.length === totalNumberOfRolls) {
          stopListening();
          process.stdout.write("\n");
          resolve(dieFacesTypedSoFar.join(""));
        }
        return;
      }

      // A die face 1-6: record it, unless we already have every roll we
      // asked for. Extra digits are ignored on purpose - to change one you
      // must press Backspace deliberately.
      const isDieFace =
        typedCharacter !== undefined &&
        typedCharacter.length === 1 &&
        typedCharacter >= "1" &&
        typedCharacter <= "6";
      if (isDieFace && dieFacesTypedSoFar.length < totalNumberOfRolls) {
        dieFacesTypedSoFar.push(typedCharacter);
        redraw(buildGridLines(dieFacesTypedSoFar, totalNumberOfRolls));
        return;
      }

      // Anything else (letters, arrow keys, punctuation) is simply ignored.
    }

    // Ask Node to report individual keystrokes rather than whole lines.
    readline.emitKeypressEvents(process.stdin);
    // "Raw mode" means keystrokes reach us immediately and the terminal does
    // not echo them itself - so our grid is the only thing drawing on screen.
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", handleKeystroke);

    // Draw the empty grid once, before the user types anything.
    redraw(buildGridLines(dieFacesTypedSoFar, totalNumberOfRolls));
  });
}

// ---------------------------------------------------------------------
// PART 3: The plain line version (used when input is piped in)
// ---------------------------------------------------------------------

// Reads one whole line of dice rolls, checks it, and asks again if it is not
// valid. `waitForNextLine` is the line-waiting function built in
// dice-to-seed.js; it throws if the input ends early, and that error is
// deliberately left to travel up to the main program, which reports it and
// exits with a failure code rather than pretending nothing happened.
// Returns the die faces as one string, for example "6142...".
async function collectDiceRollsFromLines(waitForNextLine, totalNumberOfRolls) {
  while (true) {
    process.stdout.write(
      "Enter your " + totalNumberOfRolls + " dice rolls (digits 1-6, spaces optional): "
    );
    const typedLine = await waitForNextLine();
    const result = checkTypedDiceRolls(typedLine, totalNumberOfRolls);

    if (result.isValid) {
      return result.diceRollText;
    }

    // Something was wrong. Say exactly what, and ask for the whole sequence
    // again rather than trying to patch part of it (which could get
    // confusing about which roll ended up where).
    console.log("Invalid input: " + result.reasonItIsInvalid + " Please re-enter all rolls.");
  }
}

module.exports = {
  checkTypedDiceRolls,
  buildGridLines,
  collectDiceRollsInteractive,
  collectDiceRollsFromLines,
};

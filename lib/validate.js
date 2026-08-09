// Enables JS strict mode for this file: catches silent bugs like assigning to an undeclared variable.
"use strict";

/**
 * lib/validate.js
 *
 * Input validation — rejects and re-prompts, never "fixes" your input.
 */

// Validates a raw line of user input against the expected dice-roll count; never alters the digits themselves.
function parseDiceInput(raw, expectedCount) {
  // Removes all whitespace (spaces, tabs) so the user can type rolls with or without separators between them.
  const stripped = raw.replace(/\s+/g, "");
  // Reject outright if the digit count doesn't exactly match what was expected (50 or 100).
  if (stripped.length !== expectedCount) {
    // Explains precisely why the input was rejected, so the user can fix it themselves.
    return {
      ok: false,
      error: `Expected exactly ${expectedCount} digits, got ${stripped.length}.`,
    };
  }
  // Reject if any character isn't a digit 1 through 6 (the only valid faces on a six-sided die).
  if (!/^[1-6]+$/.test(stripped)) {
    return {
      ok: false,
      error: "Only digits 1-6 are allowed (one per die face).",
    };
  }
  // Convert each character ("1".."6") into a zero-based base-6 digit (0-5) for use by diceDigitsToEntropy.
  const digits = Array.from(stripped, (digitChar) => Number(digitChar) - 1); // 0-5
  // Input passed validation; return the converted digits for the caller to use unchanged.
  return { ok: true, digits };
}

module.exports = {
  parseDiceInput,
};

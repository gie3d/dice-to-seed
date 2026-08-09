// Enables JS strict mode for this file: catches silent bugs like assigning to an undeclared variable.
"use strict";

/**
 * lib/selftest.js
 *
 * Offline self-test against official BIP-39 test vectors.
 * Run `node dice-to-seed.js --selftest` to verify this implementation
 * against official BIP-39 test vectors (entropy -> mnemonic), entirely
 * offline, before you trust it with real dice rolls.
 */

const { entropyToMnemonic, diceRollsToMnemonic } = require("./mnemonic.js");
const WORDLIST = require("../wordlist.js");

// Verifies this implementation's BIP-39 logic against known-correct official test vectors, fully offline.
function selfTest() {
  // Hex strings are built with repeat(), never hand-typed, so the byte
  // length can't silently drift from what each vector requires.
  // Each entry pairs a known entropy value (as hex) with the official mnemonic it must produce.
  const testVectors = [
    {
      // 16 bytes of 0x00 repeated = 128 bits of all-zero entropy.
      entropyHex: "00".repeat(16),
      // The official BIP-39 mnemonic for all-zero 128-bit entropy.
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    },
    {
      // 16 bytes of 0x7f repeated = 128 bits of entropy.
      entropyHex: "7f".repeat(16),
      mnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
    },
    {
      // 16 bytes of 0xff repeated = 128 bits of all-one entropy.
      entropyHex: "ff".repeat(16),
      mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
    },
    {
      // 32 bytes of 0x00 repeated = 256 bits of all-zero entropy.
      entropyHex: "00".repeat(32),
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    },
    {
      // 32 bytes of 0x7f repeated = 256 bits of entropy.
      entropyHex: "7f".repeat(32),
      mnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
    },
    {
      // 32 bytes of 0xff repeated = 256 bits of all-one entropy.
      entropyHex: "ff".repeat(32),
      mnemonic:
        "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
    },
  ];

  // Counts how many of the official test vectors matched exactly.
  let passCount = 0;
  // Check each vector in turn.
  for (const testVector of testVectors) {
    // Decode the vector's hex string back into raw entropy bytes.
    const entropy = Buffer.from(testVector.entropyHex, "hex");
    // Run our BIP-39 implementation on that entropy.
    const actualMnemonic = entropyToMnemonic(entropy);
    // Compare our output to the official expected mnemonic, character for character.
    const matches = actualMnemonic === testVector.mnemonic;
    // Print a PASS/FAIL line identifying which vector this was (by the start of its hex).
    console.log((matches ? "PASS" : "FAIL") + "  " + testVector.entropyHex.slice(0, 16) + "...");
    // On mismatch, show exactly what was expected vs. what we computed, to aid debugging.
    if (!matches) {
      console.log("  expected: " + testVector.mnemonic);
      console.log("  got:      " + actualMnemonic);
    } else {
      // Tally a passing vector.
      passCount++;
    }
  }

  // Sanity check on the dice path itself: 50 zeros (die face "1" repeated,
  // i.e. base-6 digit 0 repeated) must still deterministically produce a
  // valid, checksummed 12-word mnemonic drawn from the wordlist.
  // Simulates 50 dice rolls that all came up base-6 digit 0 (i.e. the user rolled "1" fifty times).
  const allZeroDigits50 = new Array(50).fill(0);
  // Runs the full dice-input pipeline (not just entropyToMnemonic) end to end for the 50-roll/12-word path.
  const mnemonic50 = diceRollsToMnemonic(50, allZeroDigits50);
  // Confirms the result is exactly 12 words and that every word is actually in the official wordlist.
  const isValid50 =
    mnemonic50.split(" ").length === 12 &&
    mnemonic50.split(" ").every((word) => WORDLIST.includes(word));
  // Reports the result of this structural check.
  console.log((isValid50 ? "PASS" : "FAIL") + "  50-roll dice path structural check");

  // Same idea, but simulating 100 dice rolls of base-6 digit 0 for the 24-word path.
  const allZeroDigits100 = new Array(100).fill(0);
  // Runs the full pipeline for the 100-roll/24-word path.
  const mnemonic100 = diceRollsToMnemonic(100, allZeroDigits100);
  // Confirms exactly 24 words, all drawn from the official wordlist.
  const isValid100 =
    mnemonic100.split(" ").length === 24 &&
    mnemonic100.split(" ").every((word) => WORDLIST.includes(word));
  // Reports the result of this structural check.
  console.log((isValid100 ? "PASS" : "FAIL") + "  100-roll dice path structural check");

  // Total number of checks run: the official vectors plus the 2 structural dice-path checks.
  const totalChecks = testVectors.length + 2;
  // Total number of checks that actually passed.
  const passedChecks = passCount + (isValid50 ? 1 : 0) + (isValid100 ? 1 : 0);
  // Prints a final summary line.
  console.log(`\n${passedChecks}/${totalChecks} checks passed.`);
  // Exits with status 0 (success) only if every single check passed; otherwise exits with status 1 (failure),
  // so this can be used as a pass/fail gate (e.g. in a script or CI check).
  process.exit(passedChecks === totalChecks ? 0 : 1);
}

module.exports = {
  selfTest,
};

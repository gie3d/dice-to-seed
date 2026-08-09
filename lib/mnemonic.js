// Enables JS strict mode for this file: catches silent bugs like assigning to an undeclared variable.
"use strict";

/**
 * lib/mnemonic.js
 *
 * Core conversion: dice digits (each 0-5) -> BIP-39 mnemonic string.
 *
 * ALGORITHM
 * ---------
 * 1. Each die roll (1-6) becomes a base-6 digit (0-5).
 * 2. All digits are accumulated into one big integer:
 *        accumulator = accumulator * 6 + digit   (using BigInt, arbitrary precision)
 *    50 rolls carry ~129.2 bits of entropy (50 * log2(6));
 *    100 rolls carry ~258.5 bits. Both exceed the 128 / 256 bits
 *    needed, so the accumulator is truncated (mod 2^N) to exactly
 *    N bits. This is the standard technique used by established
 *    dice->BIP39 tools.
 * 3. checksum = first (N/32) bits of SHA-256(entropy bytes)   [BIP-39]
 * 4. bits = entropy_bits || checksum_bits   (length is a multiple of 11)
 * 5. Split bits into groups of 11 -> each group indexes one word (0-2047)
 *    in the official BIP-39 English wordlist.
 */

// Node's built-in cryptography module (ships with Node, not npm) — used only for its SHA-256 hash function.
const crypto = require("node:crypto");
// Loads the local 2048-word official BIP-39 English wordlist (see ../wordlist.js) as a plain array of strings.
const WORDLIST = require("../wordlist.js");

// Maps each supported dice-roll count to how many entropy bits it produces and how many words that yields.
const CONFIGS = {
  // 50 dice rolls -> 128 bits of entropy -> a 12-word mnemonic.
  50: { entropyBits: 128, wordCount: 12 },
  // 100 dice rolls -> 256 bits of entropy -> a 24-word mnemonic.
  100: { entropyBits: 256, wordCount: 24 },
};

// Converts an array of base-6 digits (0-5, one per die roll) into exactly `entropyBits` bits of entropy.
function diceDigitsToEntropy(digits, entropyBits) {
  // Running total as a BigInt (arbitrary-precision integer) so it can hold numbers far bigger than 2^53.
  let accumulator = 0n;
  // Walk through every dice digit in the order the user entered them.
  for (const digit of digits) {
    // Shift the accumulator one base-6 "digit" to the left and add the new digit — same idea as building a
    // decimal number digit by digit (accumulator = accumulator*10 + digit), but in base 6 instead of base 10.
    accumulator = accumulator * 6n + BigInt(digit);
  }
  // Builds a bitmask of `entropyBits` 1-bits (e.g. 128 or 256 ones) — used to keep only the low N bits.
  const lowBitsMask = (1n << BigInt(entropyBits)) - 1n;
  // Because the dice carry slightly more than N bits of entropy, truncate down to exactly N bits.
  accumulator &= lowBitsMask;

  // How many bytes are needed to hold N bits (16 bytes for 128 bits, 32 bytes for 256 bits).
  const byteLength = entropyBits / 8;
  // Allocates a zero-filled byte buffer of that length to hold the final entropy.
  const entropyBuffer = Buffer.alloc(byteLength);
  // A working copy of the truncated accumulator that we'll consume byte by byte below.
  let remainingValue = accumulator;
  // Fill the buffer from the last byte back to the first, so the result is big-endian (most significant byte first).
  for (let byteIndex = byteLength - 1; byteIndex >= 0; byteIndex--) {
    // Take the lowest 8 bits of `remainingValue` (0xff mask) and store them as this byte.
    entropyBuffer[byteIndex] = Number(remainingValue & 0xffn);
    // Shift `remainingValue` right by 8 bits to expose the next byte on the next loop iteration.
    remainingValue >>= 8n;
  }
  // Return the finished entropy as a Buffer (byte array).
  return entropyBuffer;
}

// Implements the core BIP-39 algorithm: entropy bytes -> checksummed mnemonic words.
function entropyToMnemonic(entropyBytes) {
  // Total number of entropy bits (128 or 256), derived from the buffer's byte length.
  const entropyBits = entropyBytes.length * 8;
  // BIP-39 rule: the checksum length in bits is entropy_bits / 32 (4 bits for 128, 8 bits for 256).
  const checksumBits = entropyBits / 32;

  // Computes SHA-256(entropy) as required by BIP-39; `hash` is a 32-byte Buffer.
  const hash = crypto.createHash("sha256").update(entropyBytes).digest();

  // Build one long bit string: entropy bits followed by checksum bits.
  // Accumulates a text string of '0'/'1' characters representing the entropy bits, most significant bit first.
  let bitString = "";
  // Walk through every byte of the entropy buffer in order.
  for (const entropyByte of entropyBytes) {
    // Convert the byte to a binary string and left-pad with zeros to always be 8 characters (e.g. 5 -> "00000101").
    bitString += entropyByte.toString(2).padStart(8, "0");
  }
  // Will hold the binary-string representation of each byte of the SHA-256 hash.
  const hashBitChunks = [];
  // Walk through every byte of the 32-byte hash.
  for (const hashByte of hash) {
    // Same byte-to-8-bit-binary-string conversion as above, collected into an array this time.
    hashBitChunks.push(hashByte.toString(2).padStart(8, "0"));
  }
  // Join all the hash's bits into one string, then take only the first `checksumBits` of them (this is the
  // BIP-39 checksum) and append them after the entropy bits.
  bitString += hashBitChunks.join("").slice(0, checksumBits);

  // Will collect the mnemonic words in order as they're decoded.
  const words = [];
  // BIP-39 splits the combined entropy+checksum bit string into groups of 11 bits; loop once per group.
  for (let wordIndex = 0; wordIndex < bitString.length / 11; wordIndex++) {
    // Extract the wordIndex-th group of 11 bits as a substring, e.g. "01100100101".
    const elevenBitChunk = bitString.slice(wordIndex * 11, wordIndex * 11 + 11);
    // Parse that 11-bit binary string as a base-2 integer, giving a value from 0 to 2047.
    const wordListIndex = parseInt(elevenBitChunk, 2);
    // Use that value as an index into the 2048-word BIP-39 wordlist and append the resulting word.
    words.push(WORDLIST[wordListIndex]);
  }
  // Join all the words with single spaces to form the final mnemonic phrase.
  return words.join(" ");
}

// Top-level helper: given how many dice were rolled and the digits themselves, produce the full mnemonic.
function diceRollsToMnemonic(rollCount, digits) {
  // Look up the entropy-bit-count / word-count settings for this roll count (only 50 or 100 are defined).
  const config = CONFIGS[rollCount];
  // If rollCount isn't 50 or 100, there's no matching config — this is a programming error, not user input
  // (user input is already validated elsewhere before this function is called).
  if (!config) {
    // Fail loudly rather than silently guessing an entropy size.
    throw new Error("rollCount must be 50 or 100");
  }
  // Convert the dice digits into a raw entropy buffer of the required bit length.
  const entropy = diceDigitsToEntropy(digits, config.entropyBits);
  // Run the BIP-39 algorithm on that entropy to get the final word list as a string.
  const mnemonic = entropyToMnemonic(entropy);
  // Overwrite the entropy bytes with zeros in memory now that they're no longer needed, to reduce the window
  // during which sensitive data sits in RAM (best-effort only — JS/V8 doesn't guarantee no copies exist elsewhere).
  entropy.fill(0);
  // Hand back the finished mnemonic phrase to the caller.
  return mnemonic;
}

module.exports = {
  CONFIGS,
  diceDigitsToEntropy,
  entropyToMnemonic,
  diceRollsToMnemonic,
};

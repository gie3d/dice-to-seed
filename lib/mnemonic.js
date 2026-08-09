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
//
// WORKED EXAMPLE threaded through every comment below: imagine you rolled three dice and got
// 4, 6, 2. Each face becomes (face - 1), so `digits` = [3, 5, 1], and say `entropyBits` = 8
// (a real run uses 128 or 256 — 8 is just small enough to trace by hand).
function diceDigitsToEntropy(digits, entropyBits) {
  // Running total as a BigInt (arbitrary-precision integer) so it can hold numbers far bigger than 2^53.
  // Starts at 0n. ("n" suffix = this literal is a BigInt, not a regular number.)
  let accumulator = 0n;
  // Walk through every dice digit in the order the user entered them.
  // Loop runs 3 times here, once for each of 3, 5, 1.
  for (const digit of digits) {
    // Shift the accumulator one base-6 "digit" to the left and add the new digit — same idea as building a
    // decimal number digit by digit (accumulator = accumulator*10 + digit), but in base 6 instead of base 10.
    // Iteration 1 (digit=3): accumulator = 0*6 + 3  =   3
    // Iteration 2 (digit=5): accumulator = 3*6 + 5  =  23
    // Iteration 3 (digit=1): accumulator = 23*6 + 1 = 139
    // After the loop, accumulator = 139n (this is just [3,5,1] read as a base-6 number, in base 10).
    accumulator = accumulator * 6n + BigInt(digit);
  }
  // Builds a bitmask of `entropyBits` 1-bits (e.g. 128 or 256 ones) — used to keep only the low N bits.
  // With entropyBits=8: (1n << 8n) - 1n = 256 - 1 = 255n, i.e. binary 11111111 (eight 1-bits).
  const lowBitsMask = (1n << BigInt(entropyBits)) - 1n;
  // Because the dice carry slightly more than N bits of entropy, truncate down to exactly N bits.
  // 139 in binary is 10001011 — already only 8 bits, so 139n & 255n leaves it unchanged: accumulator = 139n.
  // (With real 50/100-roll inputs, the pre-mask number is bigger than N bits, so this step actually cuts
  // some of the most-significant bits off — that's the "truncation" the comment above refers to.)
  accumulator &= lowBitsMask;

  // How many bytes are needed to hold N bits (16 bytes for 128 bits, 32 bytes for 256 bits).
  // With entropyBits=8: byteLength = 8 / 8 = 1 (we only need a single byte).
  const byteLength = entropyBits / 8;
  // Allocates a zero-filled byte buffer of that length to hold the final entropy.
  // With byteLength=1: entropyBuffer = <Buffer 00> (one byte, currently zero).
  const entropyBuffer = Buffer.alloc(byteLength);
  // A working copy of the truncated accumulator that we'll consume byte by byte below.
  // remainingValue starts at 139n (a copy of accumulator).
  let remainingValue = accumulator;
  // Fill the buffer from the last byte back to the first, so the result is big-endian (most significant byte first).
  // With byteLength=1 there's only one iteration: byteIndex = 0.
  for (let byteIndex = byteLength - 1; byteIndex >= 0; byteIndex--) {
    // Take the lowest 8 bits of `remainingValue` (0xff mask) and store them as this byte.
    // 139n & 0xffn = 139n -> Number(139n) = 139 -> entropyBuffer[0] = 139.
    entropyBuffer[byteIndex] = Number(remainingValue & 0xffn);
    // Shift `remainingValue` right by 8 bits to expose the next byte on the next loop iteration.
    // 139n >> 8n = 0n (nothing left — there was only one byte's worth of data).
    remainingValue >>= 8n;
  }
  // Return the finished entropy as a Buffer (byte array).
  // Final result for this example: <Buffer 8b> (0x8b = 139 decimal = 10001011 binary).
  return entropyBuffer;
}

// Implements the core BIP-39 algorithm: entropy bytes -> checksummed mnemonic words.
//
// WORKED EXAMPLE threaded through every comment below: `entropyBytes` = <Buffer 8b 00 00 00>
// (4 bytes = 32 bits — a real run uses 16 or 32 bytes, but 4 is small enough to trace by hand
// and is still a valid multiple of 32 bits, which BIP-39 requires).
function entropyToMnemonic(entropyBytes) {
  // Total number of entropy bits (128 or 256), derived from the buffer's byte length.
  // 4 bytes * 8 = 32.
  const entropyBits = entropyBytes.length * 8;
  // BIP-39 rule: the checksum length in bits is entropy_bits / 32 (4 bits for 128, 8 bits for 256).
  // 32 / 32 = 1 — this example's mnemonic gets exactly 1 checksum bit.
  const checksumBits = entropyBits / 32;

  // Computes SHA-256(entropy) as required by BIP-39; `hash` is a 32-byte Buffer.
  // SHA-256(<8b 00 00 00>) happens to start with the byte 0x88 (binary 10001000) — only its first
  // bit (the leading "1") ends up mattering below, since checksumBits is 1 in this example.
  const hash = crypto.createHash("sha256").update(entropyBytes).digest();

  // Build one long bit string: entropy bits followed by checksum bits.
  // Accumulates a text string of '0'/'1' characters representing the entropy bits, most significant bit first.
  // Starts as "" and will end up as the 32-character string for <8b 00 00 00> (see loop below).
  let bitString = "";
  // Walk through every byte of the entropy buffer in order.
  // Iterates 4 times: over 0x8b, 0x00, 0x00, 0x00.
  for (const entropyByte of entropyBytes) {
    // Convert the byte to a binary string and left-pad with zeros to always be 8 characters (e.g. 5 -> "00000101").
    // 0x8b -> "10001011"; each 0x00 -> "00000000". After all 4 bytes, bitString =
    // "10001011" + "00000000" + "00000000" + "00000000" = "10001011000000000000000000000000" (32 chars).
    bitString += entropyByte.toString(2).padStart(8, "0");
  }
  // Will hold the binary-string representation of each byte of the SHA-256 hash.
  // Starts empty; will collect 32 eight-character strings, one per hash byte.
  const hashBitChunks = [];
  // Walk through every byte of the 32-byte hash.
  for (const hashByte of hash) {
    // Same byte-to-8-bit-binary-string conversion as above, collected into an array this time.
    // First entry (from the example's hash byte 0x88) is "10001000".
    hashBitChunks.push(hashByte.toString(2).padStart(8, "0"));
  }
  // Join all the hash's bits into one string, then take only the first `checksumBits` of them (this is the
  // BIP-39 checksum) and append them after the entropy bits.
  // hashBitChunks.join("") starts with "10001000..."; slice(0, 1) takes just the first character: "1".
  // bitString (32 chars) + "1" -> 33-character string ending "...00000000001".
  bitString += hashBitChunks.join("").slice(0, checksumBits);

  // Will collect the mnemonic words in order as they're decoded.
  const words = [];
  // BIP-39 splits the combined entropy+checksum bit string into groups of 11 bits; loop once per group.
  // bitString.length is 33, so this loop runs 3 times (33 / 11 = 3 whole words, no remainder).
  for (let wordIndex = 0; wordIndex < bitString.length / 11; wordIndex++) {
    // Extract the wordIndex-th group of 11 bits as a substring, e.g. "01100100101".
    // wordIndex=0: "10001011000"  wordIndex=1: "00000000000"  wordIndex=2: "00000000001"
    const elevenBitChunk = bitString.slice(wordIndex * 11, wordIndex * 11 + 11);
    // Parse that 11-bit binary string as a base-2 integer, giving a value from 0 to 2047.
    // "10001011000" -> 1112   "00000000000" -> 0   "00000000001" -> 1
    const wordListIndex = parseInt(elevenBitChunk, 2);
    // Use that value as an index into the 2048-word BIP-39 wordlist and append the resulting word.
    // WORDLIST[1112] = "mention"   WORDLIST[0] = "abandon"   WORDLIST[1] = "ability"
    words.push(WORDLIST[wordListIndex]);
  }
  // Join all the words with single spaces to form the final mnemonic phrase.
  // Result for this example: "mention abandon ability" (a toy 3-word phrase — real output is 12 or 24 words).
  return words.join(" ");
}

// Top-level helper: given how many dice were rolled and the digits themselves, produce the full mnemonic.
//
// WORKED EXAMPLE threaded through every comment below: `rollCount` = 50, `digits` = a 50-entry array
// that starts [3, 5, 1, ...] and is 0 for the remaining 47 entries (i.e. the user rolled 4, 6, 2, then
// 1, 1, 1, ... forty-seven more times — die face 1 becomes digit 0).
function diceRollsToMnemonic(rollCount, digits) {
  // Look up the entropy-bit-count / word-count settings for this roll count (only 50 or 100 are defined).
  // CONFIGS[50] = { entropyBits: 128, wordCount: 12 }, so config = that object.
  const config = CONFIGS[rollCount];
  // If rollCount isn't 50 or 100, there's no matching config — this is a programming error, not user input
  // (user input is already validated elsewhere before this function is called).
  // Not triggered in this example (config is defined), but e.g. diceRollsToMnemonic(7, digits) would hit this.
  if (!config) {
    // Fail loudly rather than silently guessing an entropy size.
    throw new Error("rollCount must be 50 or 100");
  }
  // Convert the dice digits into a raw entropy buffer of the required bit length.
  // diceDigitsToEntropy(digits, 128) accumulates all 50 digits (same process as the diceDigitsToEntropy
  // example above, just with 50 digits and entropyBits=128 instead of 3 digits and entropyBits=8) and
  // returns a 16-byte Buffer, e.g. <Buffer 8f d1 5a ... > (16 bytes total).
  const entropy = diceDigitsToEntropy(digits, config.entropyBits);
  // Run the BIP-39 algorithm on that entropy to get the final word list as a string.
  // entropyToMnemonic(<16-byte Buffer>) runs the same steps as the entropyToMnemonic example above (SHA-256,
  // bit string, 11-bit chunks), just with 128 entropy bits + 4 checksum bits = 132 bits = 12 words instead
  // of 32 + 1 = 33 bits = 3 words. For this example digits array it returns:
  // "mansion level holiday convince cart floor inside mosquito abandon abandon abandon about"
  const mnemonic = entropyToMnemonic(entropy);
  // Overwrite the entropy bytes with zeros in memory now that they're no longer needed, to reduce the window
  // during which sensitive data sits in RAM (best-effort only — JS/V8 doesn't guarantee no copies exist elsewhere).
  // Mutates entropy from <Buffer 8f d1 5a ...> to <Buffer 00 00 00 ...> (16 zero bytes) — the returned
  // `mnemonic` string above was already computed and is unaffected by this.
  entropy.fill(0);
  // Hand back the finished mnemonic phrase to the caller.
  // Returns "mansion level holiday convince cart floor inside mosquito abandon abandon abandon about".
  return mnemonic;
}

module.exports = {
  CONFIGS,
  diceDigitsToEntropy,
  entropyToMnemonic,
  diceRollsToMnemonic,
};

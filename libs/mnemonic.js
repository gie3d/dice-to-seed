// libs/mnemonic.js
//
// The maths: dice rolls -> entropy -> BIP-39 seed phrase. This is the part
// worth reading most carefully, because everything else in the program is
// just prompts and printing.
//
// THE STEPS
// ---------
// 1. Your rolls arrive as text, for example "6142...".
// 2. That text is hashed with SHA-256. The first 16 bytes of the hash (for
//    12 words) or all 32 bytes (for 24 words) become your "entropy" - the
//    randomness the seed phrase is built from.
// 3. SHA-256 of the entropy provides a few extra "checksum" bits, which are
//    glued onto the end of the entropy bits. This lets wallets detect typos.
// 4. The combined bits are cut into groups of 11. Each group is a number from
//    0 to 2047, pointing at one word in the official 2048-word BIP-39 list.
//
// WHY HASH THE ROLLS, AND WHY SO MANY ROLLS?
// -------------------------------------------
// An earlier version read the rolls as one big base-6 number and cut it down
// to 128 or 256 bits with a remainder ("mod") operation. That is simpler to
// explain, but it has two real problems:
//
//   * Modulo bias. 50 rolls of a die cannot be split evenly into 2^128
//     equally likely values, so some seed phrases came out more likely than
//     others - in the worst case 1.5x more likely. Not a break, but not the
//     uniform randomness the whole exercise is for.
//   * Real dice are not perfectly fair. A slightly biased die passed that
//     bias straight through into the seed. Hashing spreads the randomness of
//     the whole sequence across every output bit, so a small lean in one face
//     no longer lines up with any particular part of the entropy.
//
// Hashing only helps if you feed it comfortably more randomness than you take
// out, which is why the roll counts are 64 and 128 rather than 50 and 100:
//
//   * 64 rolls carry about 165 bits of randomness (64 x log2(6)) and we take
//     128 bits out - a margin of about 37 bits.
//   * 128 rolls carry about 331 bits and we take 256 bits out - a margin of
//     about 75 bits.
//
// A bonus of hashing: your seed can be reproduced by any other program, which
// is the best protection there is against a bug in this one.

"use strict";

const crypto = require("node:crypto");
const WORDLIST = require("../wordlist.js");
const {
  findProblemWithDiceRollText,
  findProblemWithDiceRandomness,
} = require("./validate.js");

// Settings for each supported number of dice rolls. See "WHY HASH THE ROLLS"
// above for where 64 and 128 come from.
const DICE_ROLL_SETTINGS = {
  64: { numberOfEntropyBytes: 16, numberOfWords: 12 },
  128: { numberOfEntropyBytes: 32, numberOfWords: 24 },
};

// The roll counts we accept, as a readable list for error messages: "64 or 128".
const SUPPORTED_ROLL_COUNTS = Object.keys(DICE_ROLL_SETTINGS).map(Number);

// Hashes the typed die faces with SHA-256 and keeps the first
// `numberOfEntropyBytes` bytes of the result. That is the entropy the seed
// phrase is built from.
//
// The text hashed is exactly what you typed - the digits 1-6, nothing added,
// nothing reordered - so `printf '6142...' | shasum -a 256` on any computer
// reproduces this same hash.
function convertDiceRollsToEntropyBytes(diceRollText, numberOfEntropyBytes) {
  const hashBuffer = crypto.createHash("sha256").update(diceRollText, "utf8").digest();
  const entropyByteNumbers = [];
  for (let index = 0; index < numberOfEntropyBytes; index = index + 1) {
    entropyByteNumbers.push(hashBuffer[index]);
  }
  return entropyByteNumbers;
}

// Turns a single byte number (0-255) into its 8-character binary text form.
// Example: 5 -> "00000101"
function convertByteNumberToBinaryText(byteNumber) {
  return byteNumber.toString(2).padStart(8, "0");
}

// Turns a list of byte numbers into lower-case hexadecimal text, the format
// every other BIP-39 tool expects when you paste entropy into it.
// Example: [255, 0, 16] -> "ff0010"
function convertBytesToHexText(byteNumbers) {
  let hexText = "";
  for (let index = 0; index < byteNumbers.length; index = index + 1) {
    hexText = hexText + byteNumbers[index].toString(16).padStart(2, "0");
  }
  return hexText;
}

// Given a list of entropy byte numbers (each 0-255), runs the official
// BIP-39 steps to produce the final seed phrase words.
function convertEntropyBytesToMnemonic(entropyByteNumbers) {
  // BIP-39 only defines entropy sizes of 16, 20, 24, 28 or 32 bytes. Anything
  // else would silently produce a phrase no wallet could read back, so refuse.
  const allowedByteCounts = [16, 20, 24, 28, 32];
  if (!Array.isArray(entropyByteNumbers) && !Buffer.isBuffer(entropyByteNumbers)) {
    throw new Error("Entropy must be given as a list of byte numbers.");
  }
  if (!allowedByteCounts.includes(entropyByteNumbers.length)) {
    throw new Error(
      "Entropy must be " +
        allowedByteCounts.join(", ") +
        " bytes long (BIP-39), got " +
        entropyByteNumbers.length +
        "."
    );
  }
  for (let index = 0; index < entropyByteNumbers.length; index = index + 1) {
    const byteNumber = entropyByteNumbers[index];
    if (!Number.isInteger(byteNumber) || byteNumber < 0 || byteNumber > 255) {
      throw new Error(
        "Entropy byte " + (index + 1) + " is not a whole number from 0 to 255."
      );
    }
  }

  const numberOfEntropyBits = entropyByteNumbers.length * 8;
  // BIP-39 rule: the checksum is (numberOfEntropyBits / 32) bits long.
  const numberOfChecksumBits = numberOfEntropyBits / 32;

  // Turn the entropy bytes into one long binary text string.
  let entropyBinaryText = "";
  for (let index = 0; index < entropyByteNumbers.length; index = index + 1) {
    entropyBinaryText = entropyBinaryText + convertByteNumberToBinaryText(entropyByteNumbers[index]);
  }

  // The checksum comes from the SHA-256 hash of the entropy bytes.
  const entropyBuffer = Buffer.from(entropyByteNumbers);
  const hashBuffer = crypto.createHash("sha256").update(entropyBuffer).digest();
  let hashBinaryText = "";
  for (let index = 0; index < hashBuffer.length; index = index + 1) {
    hashBinaryText = hashBinaryText + convertByteNumberToBinaryText(hashBuffer[index]);
  }
  const checksumBinaryText = hashBinaryText.slice(0, numberOfChecksumBits);

  // Glue the entropy bits and the checksum bits together.
  const fullBinaryText = entropyBinaryText + checksumBinaryText;

  // Cut the full binary text into groups of 11 characters. Each group is a
  // number from 0 to 2047 that points at one word in the word list.
  const mnemonicWords = [];
  const numberOfWords = fullBinaryText.length / 11;
  for (let wordPosition = 0; wordPosition < numberOfWords; wordPosition = wordPosition + 1) {
    const startIndex = wordPosition * 11;
    const elevenBitPiece = fullBinaryText.slice(startIndex, startIndex + 11);
    const wordIndex = parseInt(elevenBitPiece, 2);
    mnemonicWords.push(WORDLIST[wordIndex]);
  }

  return mnemonicWords.join(" ");
}

// The full pipeline: typed dice rolls -> entropy bytes -> seed phrase.
//
// Every assumption this function makes is checked before any math happens.
// Getting a seed phrase back from this function therefore means the input
// really was the full number of real die faces - never a short, partial or
// mistyped sequence quietly padded into something that looks fine.
function convertDiceRollsToMnemonic(diceRollText, numberOfRolls) {
  const settings = DICE_ROLL_SETTINGS[numberOfRolls];
  if (!settings) {
    throw new Error(
      "Number of rolls must be " + SUPPORTED_ROLL_COUNTS.join(" or ") + ", got " + numberOfRolls + "."
    );
  }

  const inputProblem = findProblemWithDiceRollText(diceRollText, numberOfRolls);
  if (inputProblem) {
    throw new Error(inputProblem);
  }

  const randomnessProblem = findProblemWithDiceRandomness(diceRollText);
  if (randomnessProblem) {
    throw new Error(
      "These rolls cannot have come from real dice: " +
        randomnessProblem +
        " Refusing to build a seed phrase from them - please roll again for real."
    );
  }

  const entropyByteNumbers = convertDiceRollsToEntropyBytes(
    diceRollText,
    settings.numberOfEntropyBytes
  );
  return convertEntropyBytesToMnemonic(entropyByteNumbers);
}

// What the program itself calls: one step from typed rolls to everything that
// needs printing. The entropy is returned alongside the words because they are
// the same secret in two forms, and showing the hex is what lets you check
// this program's answer against another one.
function buildSeedPhraseFromDiceRolls(diceRollText, numberOfRolls) {
  // This validates the rolls and throws if they are unusable, so it goes
  // first: nothing is computed or shown from input that will be rejected.
  const mnemonic = convertDiceRollsToMnemonic(diceRollText, numberOfRolls);
  const settings = DICE_ROLL_SETTINGS[numberOfRolls];
  const entropyByteNumbers = convertDiceRollsToEntropyBytes(
    diceRollText,
    settings.numberOfEntropyBytes
  );
  return {
    mnemonic: mnemonic,
    entropyHexText: convertBytesToHexText(entropyByteNumbers),
  };
}

module.exports = {
  DICE_ROLL_SETTINGS,
  SUPPORTED_ROLL_COUNTS,
  convertDiceRollsToEntropyBytes,
  convertBytesToHexText,
  convertEntropyBytesToMnemonic,
  convertDiceRollsToMnemonic,
  buildSeedPhraseFromDiceRolls,
};

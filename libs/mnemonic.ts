// libs/mnemonic.ts
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

import { createHash } from "node:crypto";
import { WORDLIST } from "../wordlist.ts";
import {
  findProblemWithDiceRollText,
  findProblemWithDiceRandomness,
} from "./validate.ts";

// How many bytes of entropy a given number of rolls produces, and how many
// words that entropy turns into.
export type DiceRollSettings = {
  numberOfEntropyBytes: number;
  numberOfWords: number;
};

// What buildSeedPhraseFromDiceRolls hands back: the same secret written two
// ways - as words to copy down, and as hex to check against another program.
export type SeedPhrase = {
  mnemonic: string;
  entropyHexText: string;
};

// Settings for each supported number of dice rolls. See "WHY HASH THE ROLLS"
// above for where 64 and 128 come from.
export const DICE_ROLL_SETTINGS: Record<number, DiceRollSettings> = {
  64: { numberOfEntropyBytes: 16, numberOfWords: 12 },
  128: { numberOfEntropyBytes: 32, numberOfWords: 24 },
};

// The roll counts we accept, as a readable list for error messages: "64 or 128".
export const SUPPORTED_ROLL_COUNTS: number[] = Object.keys(DICE_ROLL_SETTINGS).map(Number);

// Looks up the settings for a roll count, or refuses. Every path into the
// maths goes through here, so an unsupported roll count can never quietly
// produce a seed phrase of the wrong size.
export function settingsForRollCount(numberOfRolls: number): DiceRollSettings {
  const settings = DICE_ROLL_SETTINGS[numberOfRolls];
  if (!settings) {
    throw new Error(
      "Number of rolls must be " +
        SUPPORTED_ROLL_COUNTS.join(" or ") +
        ", got " +
        numberOfRolls +
        "."
    );
  }
  return settings;
}

// Hashes the typed die faces with SHA-256 and keeps the first
// `numberOfEntropyBytes` bytes of the result. That is the entropy the seed
// phrase is built from.
//
// The text hashed is exactly what you typed - the digits 1-6, nothing added,
// nothing reordered - so `printf '6142...' | shasum -a 256` on any computer
// reproduces this same hash.
export function convertDiceRollsToEntropyBytes(
  diceRollText: string,
  numberOfEntropyBytes: number
): number[] {
  const hashBuffer = createHash("sha256").update(diceRollText, "utf8").digest();
  // subarray takes the first `numberOfEntropyBytes` bytes of the hash, and
  // Array.from turns them into plain numbers 0-255.
  /*
  console.log('1. hashBuffer', hashBuffer.length);
  console.log('2. hashBuffer.subarray', hashBuffer.subarray(0, numberOfEntropyBytes).length);
  console.log('3. hashBuffer', JSON.stringify(hashBuffer));
  console.log('4. array from hashBuffer',JSON.stringify(Array.from(hashBuffer.subarray(0, numberOfEntropyBytes))));
  Example Output
  1. hashBuffer 32
  2. hashBuffer.subarray 32
  3. hashBuffer {"type":"Buffer","data":[96,54,83,102,5,229,70,24,12,116,233,89,148,202,183,252,65,178,78,45,41,17,222,4,103,101,187,125,90,176,55,133]}
  4. array from hashBuffer [96,54,83,102,5,229,70,24,12,116,233,89,148,202,183,252,65,178,78,45,41,17,222,4,103,101,187,125,90,176,55,133]
  */
  return Array.from(hashBuffer.subarray(0, numberOfEntropyBytes));
}

// Turns a single byte number (0-255) into its 8-character binary text form.
// Example: 5 -> "00000101"
function convertByteNumberToBinaryText(byteNumber: number): string {
  return byteNumber.toString(2).padStart(8, "0");
}

// Turns a list of byte numbers into lower-case hexadecimal text, the format
// every other BIP-39 tool expects when you paste entropy into it.
// Example: [255, 0, 16] -> "ff0010"
export function convertBytesToHexText(byteNumbers: readonly number[]): string {
  let hexText = "";
  for (const byteNumber of byteNumbers) {
    hexText = hexText + byteNumber.toString(16).padStart(2, "0");
  }
  return hexText;
}

// Given a list of entropy byte numbers (each 0-255), runs the official
// BIP-39 steps to produce the final seed phrase words.
export function convertEntropyBytesToMnemonic(
  entropyByteNumbers: readonly number[] | Buffer
): string {
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
  // From here on, work with one plain list of numbers whether the caller
  // handed us an array or a Buffer.
  const entropyBytes = Array.from(entropyByteNumbers);
  for (let index = 0; index < entropyBytes.length; index = index + 1) {
    const byteNumber = entropyBytes[index];
    if (byteNumber === undefined || !Number.isInteger(byteNumber) || byteNumber < 0 || byteNumber > 255) {
      throw new Error(
        "Entropy byte " + (index + 1) + " is not a whole number from 0 to 255."
      );
    }
  }

  const numberOfEntropyBits = entropyBytes.length * 8;
  // BIP-39 rule: the checksum is (numberOfEntropyBits / 32) bits long.
  const numberOfChecksumBits = numberOfEntropyBits / 32;

  // Turn the entropy bytes into one long binary text string.
  let entropyBinaryText = "";
  for (const byteNumber of entropyBytes) {
    entropyBinaryText = entropyBinaryText + convertByteNumberToBinaryText(byteNumber);
  }

  // The checksum comes from the SHA-256 hash of the entropy bytes.
  const entropyBuffer = Buffer.from(entropyBytes);
  const hashBuffer = createHash("sha256").update(entropyBuffer).digest();
  let hashBinaryText = "";
  for (const hashByteNumber of hashBuffer) {
    hashBinaryText = hashBinaryText + convertByteNumberToBinaryText(hashByteNumber);
  }
  const checksumBinaryText = hashBinaryText.slice(0, numberOfChecksumBits);

  // Glue the entropy bits and the checksum bits together.
  const fullBinaryText = entropyBinaryText + checksumBinaryText;

  // Cut the full binary text into groups of 11 characters. Each group is a
  // number from 0 to 2047 that points at one word in the word list.
  const mnemonicWords: string[] = [];
  const numberOfWords = fullBinaryText.length / 11;
  for (let wordPosition = 0; wordPosition < numberOfWords; wordPosition = wordPosition + 1) {
    const startIndex = wordPosition * 11;
    const elevenBitPiece = fullBinaryText.slice(startIndex, startIndex + 11);
    const wordIndex = parseInt(elevenBitPiece, 2);
    const word = WORDLIST[wordIndex];
    // Eleven bits can only name 0-2047 and the list holds exactly 2048 words,
    // so this cannot happen - but a silently missing word would mean a seed
    // phrase with a hole in it, which is worth refusing loudly.
    if (word === undefined) {
      throw new Error("Word list has no word at position " + wordIndex + ".");
    }
    mnemonicWords.push(word);
  }

  return mnemonicWords.join(" ");
}

// The full pipeline: typed dice rolls -> entropy bytes -> seed phrase.
//
// Every assumption this function makes is checked before any math happens.
// Getting a seed phrase back from this function therefore means the input
// really was the full number of real die faces - never a short, partial or
// mistyped sequence quietly padded into something that looks fine.
export function convertDiceRollsToMnemonic(
  diceRollText: string,
  numberOfRolls: number
): string {
  const settings = settingsForRollCount(numberOfRolls);
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
export function buildSeedPhraseFromDiceRolls(
  diceRollText: string,
  numberOfRolls: number
): SeedPhrase {
  // This validates the rolls and throws if they are unusable, so it goes
  // first: nothing is computed or shown from input that will be rejected.
  const mnemonic = convertDiceRollsToMnemonic(diceRollText, numberOfRolls);
  const settings = settingsForRollCount(numberOfRolls);
  const entropyByteNumbers = convertDiceRollsToEntropyBytes(
    diceRollText,
    settings.numberOfEntropyBytes
  );
  return {
    mnemonic: mnemonic,
    entropyHexText: convertBytesToHexText(entropyByteNumbers),
  };
}

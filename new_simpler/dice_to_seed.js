#!/usr/bin/env node

// dice_to_seed.js
//
// This program turns physical six-sided dice rolls into a BIP-39 seed phrase
// (also called a "mnemonic"). A seed phrase is a list of 12 or 24 English
// words that can be used to create a Bitcoin wallet.
//
// This is a SIMPLIFIED, EASY-TO-READ version of the program. It avoids
// "clever" tricks like bit-shifting (<<, >>) or bitwise AND (&). Instead it
// only uses everyday math (base 10: plus, times, remainder) and simple
// text-based binary numbers (base 2: strings of "0" and "1"). The goal is
// that anyone learning to code can read this file top to bottom and
// understand exactly what is happening.
//
// HOW TO RUN
// ----------
//   node dice_to_seed.js              -> normal interactive program
//   node dice_to_seed.js --selftest   -> checks this program against known
//                                        correct answers, so you can trust it
//                                        before using real dice rolls
//   node dice_to_seed.js --skip-internet-check
//                                      -> skip the "are you online" check
//
// NO INSTALL NEEDED
// ------------------
// This program only uses features that are already built into Node.js
// ("crypto", "net", and "readline"), plus this project's own
// ../lib/dice-input.js (the part that actually collects dice rolls from
// the keyboard, reused as-is so there is only one place that logic lives).
// You do not need to run "npm install".
//
// THE BIG PICTURE (the algorithm)
// --------------------------------
// 1. Every dice roll (1-6) is turned into a digit from 0 to 5.
// 2. All of those digits are combined into one very large base-10 number,
//    the same way you would build a normal number digit by digit:
//        bigNumber = bigNumber * 6 + nextDigit
//    (This is base 6 instead of base 10, because a die has 6 faces.)
// 3. That number is cut down to exactly 128 bits (for 12 words) or
//    256 bits (for 24 words) of "entropy" (randomness). Instead of using
//    bit-shifting, we just use the remainder operator: taking a number
//    "mod" 2^128 keeps only its lowest 128 bits, in plain base-10 math.
// 4. We compute the SHA-256 hash of those entropy bytes. The first few bits
//    of that hash become a "checksum", which is glued onto the end of the
//    entropy bits. This lets wallets detect typos later.
// 5. The combined bits (entropy + checksum) are cut into groups of 11 bits
//    each. Each group of 11 bits is a number from 0 to 2047, which points
//    at one word in the official 2048-word BIP-39 word list.
// 6. Those words, in order, are the seed phrase.

"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const readline = require("node:readline");
const WORDLIST = require("./wordlist.js");
const {
  collectDiceRollsInteractive,
  collectDiceRollsFromLines,
} = require("../lib/dice-input.js");

// ---------------------------------------------------------------------
// PART 1: Turning dice rolls into a seed phrase (the core math)
// ---------------------------------------------------------------------

// Settings for each supported number of dice rolls.
// 50 rolls give more than enough randomness for 128 bits (a 12-word phrase).
// 100 rolls give more than enough randomness for 256 bits (a 24-word phrase).
const DICE_ROLL_SETTINGS = {
  50: { numberOfEntropyBits: 128, numberOfWords: 12 },
  100: { numberOfEntropyBits: 256, numberOfWords: 24 },
};

// Turns a list of dice digits (each 0-5) into one big base-10 number.
// Example: dice digits [3, 5, 1] (from dice rolls 4, 6, 2) becomes:
//   start:            0
//   after first  3:   0 * 6 + 3  = 3
//   after second 5:   3 * 6 + 5  = 23
//   after third  1:   23 * 6 + 1 = 139
// We use BigInt (numbers with an "n" at the end) because normal JavaScript
// numbers are not big enough to hold 50 or 100 dice rolls worth of digits.
function convertDiceDigitsToBigNumber(diceDigits) {
  let bigNumber = 0n;
  for (let index = 0; index < diceDigits.length; index = index + 1) {
    const nextDigit = diceDigits[index];
    bigNumber = bigNumber * 6n + BigInt(nextDigit);
  }
  return bigNumber;
}

// Converts a BigInt number into a text string of "0"s and "1"s (its binary
// form), exactly `numberOfBits` characters long.
//
// Step 1: Use the remainder operator to keep only the lowest `numberOfBits`
//         bits of the number. This is the plain base-10 way of doing what
//         bit-masking normally does: any_number % (2 ** numberOfBits) always
//         leaves you with only the lowest `numberOfBits` bits, and nothing
//         else changes.
// Step 2: BigInt already knows how to print itself in base 2 using
//         .toString(2). We use that instead of manual bit-shifting.
// Step 3: If the result is shorter than `numberOfBits` characters (because
//         the number was small), add zeros to the front until it is exactly
//         the right length.
function convertBigNumberToBinaryText(bigNumber, numberOfBits) {
  const totalPossibleValues = 2n ** BigInt(numberOfBits); // e.g. 2^128
  const truncatedNumber = bigNumber % totalPossibleValues;
  const binaryText = truncatedNumber.toString(2);
  return binaryText.padStart(numberOfBits, "0");
}

// Splits a binary text string into 8-character pieces and turns each piece
// back into a normal number from 0 to 255 (one byte). `parseInt(text, 2)`
// reads a string of "0"s and "1"s as a base-2 number - this is the base-2
// equivalent of parseInt(text, 10) reading normal decimal digits.
function convertBinaryTextToByteNumbers(binaryText) {
  const byteNumbers = [];
  for (let position = 0; position < binaryText.length; position = position + 8) {
    const eightBitPiece = binaryText.slice(position, position + 8);
    const byteNumber = parseInt(eightBitPiece, 2);
    byteNumbers.push(byteNumber);
  }
  return byteNumbers;
}

// Turns a single byte number (0-255) into its 8-character binary text form.
// Example: 5 -> "00000101"
function convertByteNumberToBinaryText(byteNumber) {
  return byteNumber.toString(2).padStart(8, "0");
}

// Given a list of entropy byte numbers (each 0-255), runs the official
// BIP-39 steps to produce the final seed phrase words.
function convertEntropyBytesToMnemonic(entropyByteNumbers) {
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

// The full pipeline: dice digits -> big number -> entropy bytes -> mnemonic.
function convertDiceDigitsToMnemonic(diceDigits, numberOfEntropyBits) {
  const bigNumber = convertDiceDigitsToBigNumber(diceDigits);
  const entropyBinaryText = convertBigNumberToBinaryText(bigNumber, numberOfEntropyBits);
  const entropyByteNumbers = convertBinaryTextToByteNumbers(entropyBinaryText);
  const mnemonic = convertEntropyBytesToMnemonic(entropyByteNumbers);
  return mnemonic;
}

// ---------------------------------------------------------------------
// PART 2: Talking to the user (asking questions, printing the result)
// ---------------------------------------------------------------------
//
// The actual "type your dice rolls" part is reused, unchanged, from
// ../lib/dice-input.js:
//   - collectDiceRollsInteractive(rollCount) - used on a real terminal.
//     Draws a live grid that updates after every keystroke, so a 50 or
//     100-digit sequence is easy to enter correctly.
//   - collectDiceRollsFromLines(nextLine, rollCount) - used when input is
//     piped in (for example from a script or a test), where a live-updating
//     grid would not make sense. It already returns validated digits from
//     0 to 5 (one per die roll), so this file does not need its own
//     dice-roll validation code.
// Only the "how many dice rolls, 50 or 100?" question below is specific to
// this program, so it still lives here.

// Node's readline has a built-in `.question()` helper, but it only listens
// for ONE line at a time. If the user's input is piped in from a file or a
// script (instead of typed by a real person), Node can hand us several
// lines all at once, before we have asked our next question - and the
// `.question()` helper would silently lose whichever lines arrived early.
//
// To avoid that, we keep our own simple waiting list ("queue") of lines
// that have arrived but have not been used yet. This works correctly no
// matter how fast or slow the lines arrive.
function createLineWaiter(readlineInterface) {
  const linesThatArrivedEarly = [];
  const promiseResolveFunctionsWaitingForALine = [];

  readlineInterface.on("line", function (line) {
    if (promiseResolveFunctionsWaitingForALine.length > 0) {
      const resolveFunction = promiseResolveFunctionsWaitingForALine.shift();
      resolveFunction(line);
    } else {
      linesThatArrivedEarly.push(line);
    }
  });

  function waitForNextLine() {
    if (linesThatArrivedEarly.length > 0) {
      const line = linesThatArrivedEarly.shift();
      return Promise.resolve(line);
    }
    return new Promise(function (resolve) {
      promiseResolveFunctionsWaitingForALine.push(resolve);
    });
  }

  return waitForNextLine;
}

// Prints a question, then waits for (and returns) the user's next line.
async function askQuestion(waitForNextLine, questionText) {
  process.stdout.write(questionText);
  const answer = await waitForNextLine();
  return answer;
}

// Keeps asking "50 or 100?" until the user types exactly one of those.
async function askHowManyDiceRolls(waitForNextLine) {
  while (true) {
    const answer = await askQuestion(
      waitForNextLine,
      "How many dice rolls will you enter - 50 (12 words) or 100 (24 words)? "
    );
    const trimmedAnswer = answer.trim();
    if (trimmedAnswer === "50" || trimmedAnswer === "100") {
      return Number(trimmedAnswer);
    }
    console.log('Please type exactly "50" or "100".');
  }
}

// Prints the finished seed phrase, one numbered word per line.
function printMnemonic(mnemonic) {
  const words = mnemonic.split(" ");
  console.log("");
  console.log("Your seed phrase (" + words.length + " words):");
  console.log("");
  for (let index = 0; index < words.length; index = index + 1) {
    const wordNumber = index + 1;
    console.log(wordNumber + ". " + words[index]);
  }
}

// ---------------------------------------------------------------------
// PART 3: A best-effort check that this computer is offline
// ---------------------------------------------------------------------
//
// A seed phrase should be created on a computer that is NOT connected to
// the internet, so nobody else can ever see it. This check tries to open a
// plain connection to two well-known addresses. If either one succeeds,
// the computer is online, and we refuse to continue. This check can be
// fooled (for example by a very locked-down network), so it is only a
// helpful reminder, not a guarantee. For real safety, physically disconnect
// the computer from the internet before making a real seed phrase.

function checkIfOneAddressIsReachable(address, port, timeoutInMilliseconds) {
  return new Promise(function (resolve) {
    const connection = net.createConnection({ host: address, port: port });
    let alreadyFinished = false;

    function finish(isReachable) {
      if (alreadyFinished) {
        return;
      }
      alreadyFinished = true;
      connection.destroy();
      resolve(isReachable);
    }

    connection.setTimeout(timeoutInMilliseconds);
    connection.on("connect", function () {
      finish(true);
    });
    connection.on("timeout", function () {
      finish(false);
    });
    connection.on("error", function () {
      finish(false);
    });
  });
}

async function isThisComputerOnline() {
  const timeoutInMilliseconds = 3000;
  const cloudflareIsReachable = await checkIfOneAddressIsReachable("1.1.1.1", 443, timeoutInMilliseconds);
  const googleIsReachable = await checkIfOneAddressIsReachable("8.8.8.8", 443, timeoutInMilliseconds);
  return cloudflareIsReachable || googleIsReachable;
}

// ---------------------------------------------------------------------
// PART 4: Self-test - proving this program is correct before you trust it
// ---------------------------------------------------------------------
//
// These are official BIP-39 test vectors: known entropy values paired with
// the exact seed phrase they must produce. If our program produces the
// same seed phrases, we can trust the math is implemented correctly.

function runSelfTest() {
  const officialTestVectors = [
    {
      entropyHexText: "00".repeat(16),
      expectedMnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    },
    {
      entropyHexText: "7f".repeat(16),
      expectedMnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
    },
    {
      entropyHexText: "ff".repeat(16),
      expectedMnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
    },
    {
      entropyHexText: "00".repeat(32),
      expectedMnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    },
    {
      entropyHexText: "7f".repeat(32),
      expectedMnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
    },
    {
      entropyHexText: "ff".repeat(32),
      expectedMnemonic:
        "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
    },
  ];

  let numberOfChecksPassed = 0;
  let numberOfChecksTotal = 0;

  for (let index = 0; index < officialTestVectors.length; index = index + 1) {
    const testVector = officialTestVectors[index];
    numberOfChecksTotal = numberOfChecksTotal + 1;

    const entropyBuffer = Buffer.from(testVector.entropyHexText, "hex");
    const entropyByteNumbers = Array.from(entropyBuffer);
    const actualMnemonic = convertEntropyBytesToMnemonic(entropyByteNumbers);

    if (actualMnemonic === testVector.expectedMnemonic) {
      numberOfChecksPassed = numberOfChecksPassed + 1;
      console.log("PASS  " + testVector.entropyHexText.slice(0, 16) + "...");
    } else {
      console.log("FAIL  " + testVector.entropyHexText.slice(0, 16) + "...");
      console.log("  expected: " + testVector.expectedMnemonic);
      console.log("  actual:   " + actualMnemonic);
    }
  }

  // Also check the dice-roll path directly: rolling all 1s (digit 0, fifty
  // or a hundred times) should still produce a valid, correctly-sized
  // mnemonic made only of real word-list words.
  const fiftyOnes = new Array(50).fill(0);
  const twelveWordMnemonic = convertDiceDigitsToMnemonic(fiftyOnes, 128);
  const twelveWordsAreValid =
    twelveWordMnemonic.split(" ").length === 12 &&
    twelveWordMnemonic.split(" ").every(function (word) {
      return WORDLIST.includes(word);
    });
  numberOfChecksTotal = numberOfChecksTotal + 1;
  if (twelveWordsAreValid) {
    numberOfChecksPassed = numberOfChecksPassed + 1;
    console.log("PASS  50-roll dice path makes a valid 12-word phrase");
  } else {
    console.log("FAIL  50-roll dice path makes a valid 12-word phrase");
  }

  const hundredOnes = new Array(100).fill(0);
  const twentyFourWordMnemonic = convertDiceDigitsToMnemonic(hundredOnes, 256);
  const twentyFourWordsAreValid =
    twentyFourWordMnemonic.split(" ").length === 24 &&
    twentyFourWordMnemonic.split(" ").every(function (word) {
      return WORDLIST.includes(word);
    });
  numberOfChecksTotal = numberOfChecksTotal + 1;
  if (twentyFourWordsAreValid) {
    numberOfChecksPassed = numberOfChecksPassed + 1;
    console.log("PASS  100-roll dice path makes a valid 24-word phrase");
  } else {
    console.log("FAIL  100-roll dice path makes a valid 24-word phrase");
  }

  console.log("");
  console.log(numberOfChecksPassed + "/" + numberOfChecksTotal + " checks passed.");

  const allChecksPassed = numberOfChecksPassed === numberOfChecksTotal;
  process.exit(allChecksPassed ? 0 : 1);
}

// ---------------------------------------------------------------------
// PART 5: The main program
// ---------------------------------------------------------------------

async function runInteractiveProgram(skipInternetCheck) {
  console.log("======================================================================");
  console.log("dice_to_seed (simplified): offline BIP-39 seed phrase generator");
  console.log("======================================================================");

  if (skipInternetCheck) {
    console.log("Skipping the internet check, as requested. Please make sure this");
    console.log("computer is actually disconnected from the internet before continuing.");
  } else {
    console.log("Checking whether this computer is online, please wait...");
    const online = await isThisComputerOnline();
    if (online) {
      console.log("");
      console.log("This computer appears to be online. For your safety, please disconnect");
      console.log("from the internet (Wi-Fi, Ethernet, Bluetooth) and run this again.");
      console.log("If you are sure you are offline, re-run with --skip-internet-check.");
      process.exitCode = 1;
      return;
    }
    console.log("No internet connection detected. For maximum safety, physically");
    console.log("disconnect this computer from all networks before continuing.");
  }

  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const waitForNextLine = createLineWaiter(readlineInterface);

  const numberOfRolls = await askHowManyDiceRolls(waitForNextLine);

  // Real terminal: use the live-updating grid from lib/dice-input.js. It reads keystrokes directly, so we
  // must close this readline interface first (the two cannot both read stdin at the same time).
  // Piped input (for example a script or a test): the grid has no meaning without a real terminal, so
  // lib/dice-input.js falls back to reading one plain line, using the same waitForNextLine queue as above.
  let diceDigits;
  if (process.stdin.isTTY) {
    readlineInterface.close();
    console.log("Type each die face as you roll it - the grid below tracks your progress.\n");
    diceDigits = await collectDiceRollsInteractive(numberOfRolls);
  } else {
    diceDigits = await collectDiceRollsFromLines(waitForNextLine, numberOfRolls);
    readlineInterface.close();
  }

  const settings = DICE_ROLL_SETTINGS[numberOfRolls];
  const mnemonic = convertDiceDigitsToMnemonic(diceDigits, settings.numberOfEntropyBits);

  printMnemonic(mnemonic);

  console.log("");
  console.log("Write this down on paper now. Do not store it digitally, screenshot it,");
  console.log("or type it anywhere else. Clear your terminal scrollback when done.");
}

// Only run the program automatically if this file was launched directly
// (for example "node dice_to_seed.js"), not if some other file requires it.
if (require.main === module) {
  const commandLineArguments = process.argv;
  if (commandLineArguments.includes("--selftest")) {
    runSelfTest();
  } else {
    const skipInternetCheck = commandLineArguments.includes("--skip-internet-check");
    runInteractiveProgram(skipInternetCheck);
  }
}

module.exports = {
  convertDiceDigitsToBigNumber,
  convertBigNumberToBinaryText,
  convertBinaryTextToByteNumbers,
  convertEntropyBytesToMnemonic,
  convertDiceDigitsToMnemonic,
};

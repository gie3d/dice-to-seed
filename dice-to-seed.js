#!/usr/bin/env node

// dice-to-seed.js
//
// This program turns physical six-sided dice rolls into a BIP-39 seed phrase
// (also called a "mnemonic"). A seed phrase is a list of 12 or 24 English
// words that can be used to create a Bitcoin wallet.
//
// It is written to be EASY TO READ. It avoids "clever" tricks like
// bit-shifting (<<, >>) or bitwise AND (&). Instead it only uses everyday
// math and simple text-based binary numbers (strings of "0" and "1"). The
// goal is that anyone learning to code can read this file top to bottom and
// understand exactly what is happening, and so decide for themselves whether
// to trust it with real money.
//
// HOW TO RUN
// ----------
//   node dice-to-seed.js              -> normal interactive program
//   node dice-to-seed.js --selftest   -> checks this program against known
//                                        correct answers, so you can trust it
//                                        before using real dice rolls
//   node dice-to-seed.js --skip-internet-check
//                                      -> skip the "are you online" check
//                                        (--ignore-internet-check also works)
//
// NO INSTALL NEEDED
// ------------------
// This program only uses features that are already built into Node.js
// ("crypto", "net", and "readline"), plus two files that live right next to
// it: wordlist.js (the 2048 official BIP-39 words) and dice-input.js (the
// part that actually collects dice rolls from the keyboard). There is
// nothing to install and no "npm install" to run, so there is no third-party
// code anywhere in the path between your dice and your seed phrase.
//
// THE BIG PICTURE (the algorithm)
// --------------------------------
// 1. You roll a die 64 times (for 12 words) or 128 times (for 24 words) and
//    type the faces in, giving a line of text such as "6142...".
// 2. That text is hashed with SHA-256. The first 16 bytes of the hash (for
//    12 words) or all 32 bytes (for 24 words) become your "entropy" - the
//    randomness the seed phrase is built from.
// 3. SHA-256 of the entropy provides a few extra "checksum" bits, which are
//    glued onto the end of the entropy bits. This lets wallets detect typos.
// 4. The combined bits (entropy + checksum) are cut into groups of 11 bits.
//    Each group is a number from 0 to 2047, which points at one word in the
//    official 2048-word BIP-39 word list.
// 5. Those words, in order, are your seed phrase.
//
// WHY HASH THE ROLLS, AND WHY SO MANY ROLLS?
// -------------------------------------------
// An earlier version of this program read the rolls as one big base-6 number
// and cut it down to 128 or 256 bits with a remainder ("mod") operation. That
// is simple to explain, but it has two real problems:
//
//   * Modulo bias. 64 rolls of a die cannot be split evenly into 2^128
//     equally likely values, so some seed phrases came out more likely than
//     others. With 50 rolls the worst case was 1.5x more likely - not a break,
//     but not the uniform randomness the whole exercise is for.
//   * Real dice are not perfectly fair. A slightly biased die passed that
//     bias straight through into the seed. Hashing spreads the randomness of
//     the whole sequence across every output bit, so a small lean in one face
//     no longer lines up with any particular part of the entropy.
//
// Hashing only helps if you feed it comfortably more randomness than you take
// out, which is why the roll counts went up:
//
//   * 64 rolls carry about 165 bits of randomness (64 x log2(6)) and we take
//     128 bits out - a margin of about 37 bits.
//   * 128 rolls carry about 331 bits and we take 256 bits out - a margin of
//     about 75 bits.
//
// A bonus of hashing: your seed is now reproducible on any other computer,
// which is the best protection against a bug in THIS program. See
// printHowToVerifyElsewhere below.

"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const readline = require("node:readline");
const WORDLIST = require("./wordlist.js");
const {
  collectDiceRollsInteractive,
  collectDiceRollsFromLines,
} = require("./dice-input.js");

// ---------------------------------------------------------------------
// PART 1: Turning dice rolls into a seed phrase (the core math)
// ---------------------------------------------------------------------

// Settings for each supported number of dice rolls. See "WHY HASH THE ROLLS"
// above for where 64 and 128 come from.
const DICE_ROLL_SETTINGS = {
  64: { numberOfEntropyBytes: 16, numberOfWords: 12 },
  128: { numberOfEntropyBytes: 32, numberOfWords: 24 },
};

// The roll counts we accept, as a readable list for error messages: "64 or 128".
const SUPPORTED_ROLL_COUNTS = Object.keys(DICE_ROLL_SETTINGS).map(Number);

// Checks that a piece of text really is a sequence of die faces of the
// expected length. Used by the functions below so that a mistake made by
// OTHER code (a future script calling into this file, say) fails loudly
// instead of quietly producing a weak seed phrase.
//
// Returns an error message, or null when everything is fine.
function findProblemWithDiceRollText(diceRollText, expectedNumberOfRolls) {
  if (typeof diceRollText !== "string") {
    return "Dice rolls must be given as text, for example \"6142...\".";
  }
  if (diceRollText.length !== expectedNumberOfRolls) {
    return (
      "Expected exactly " +
      expectedNumberOfRolls +
      " dice rolls, got " +
      diceRollText.length +
      "."
    );
  }
  for (let index = 0; index < diceRollText.length; index = index + 1) {
    const character = diceRollText[index];
    if (character < "1" || character > "6") {
      return (
        "Dice rolls may only contain the digits 1-6; found " +
        JSON.stringify(character) +
        " at position " +
        (index + 1) +
        "."
      );
    }
  }
  return null;
}

// A safety net against input that cannot plausibly have come from real dice:
// somebody testing the program and forgetting it was for real, a stuck key,
// or a misunderstanding of the instructions. Rolling the same face 64 times
// in a row is possible in theory, but the odds are worse than 1 in 10^49 - so
// if we see it, something has gone wrong in the room, not in the dice.
//
// Note this check looks at the ROLLS, not at the hashed entropy. After
// hashing, even "1111..." produces random-looking entropy, so by then the
// mistake is invisible - this is the only place it can still be caught.
//
// Returns an error message, or null when the rolls look plausible.
function findProblemWithDiceRandomness(diceRollText) {
  // How many different faces appeared at all. Fewer than three different
  // faces over 64+ rolls is astronomically unlikely (below 1 in 10^29).
  const facesSeen = new Set(diceRollText.split(""));
  if (facesSeen.size === 1) {
    return (
      "every one of your " +
      diceRollText.length +
      " rolls is the digit " +
      diceRollText[0] +
      "."
    );
  }
  if (facesSeen.size < 3) {
    return (
      "your rolls only ever use " +
      facesSeen.size +
      " different die faces (" +
      Array.from(facesSeen).sort().join(", ") +
      ")."
    );
  }

  // A short repeating pattern, such as "123456123456123456..." - the sign of
  // a person typing a pattern rather than reading dice off a table.
  //
  // The comparison below repeats the pattern past the end and then trims, so
  // a sequence that stops part-way through a repeat ("...1234561234", where 64
  // rolls is not a whole number of six-digit patterns) is caught just the same.
  for (let patternLength = 1; patternLength <= 8; patternLength = patternLength + 1) {
    const pattern = diceRollText.slice(0, patternLength);
    const timesToRepeat = Math.ceil(diceRollText.length / patternLength);
    const patternStretchedOut = pattern.repeat(timesToRepeat).slice(0, diceRollText.length);
    if (patternStretchedOut === diceRollText) {
      return 'your rolls are just "' + pattern + '" repeated over and over.';
    }
  }

  return null;
}

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

// ---------------------------------------------------------------------
// PART 2: Talking to the user (asking questions, printing the result)
// ---------------------------------------------------------------------
//
// The actual "type your dice rolls" part lives in dice-input.js, next to
// this file. It gives us:
//   - collectDiceRollsInteractive(rollCount) - used on a real terminal.
//     Draws a live grid that updates after every keystroke, so a 64 or
//     128-digit sequence is easy to enter correctly.
//   - collectDiceRollsFromLines(waitForNextLine, rollCount) - used when input
//     is piped in (for example from a script or a test), where a live-updating
//     grid would not make sense.
// Both of them hand back the same thing: the die faces you typed, as text.
// Only the "how many dice rolls?" question below is specific to this program,
// so it still lives here.

// Node's readline has a built-in `.question()` helper, but it only listens
// for ONE line at a time. If the user's input is piped in from a file or a
// script (instead of typed by a real person), Node can hand us several
// lines all at once, before we have asked our next question - and the
// `.question()` helper would silently lose whichever lines arrived early.
//
// To avoid that, we keep our own simple waiting list ("queue") of lines
// that have arrived but have not been used yet. This works correctly no
// matter how fast or slow the lines arrive.
//
// It also handles the opposite problem: input that ENDS before we have asked
// everything (a piped file with too few lines, or the user pressing Ctrl+D).
// Waiting forever for a line that can never arrive would leave the program
// hanging or, worse, exiting quietly as if it had succeeded. Instead every
// waiting question is failed with a clear error, which the main program turns
// into a message and a non-zero exit code.
function createLineWaiter(readlineInterface) {
  const linesThatArrivedEarly = [];
  const questionsWaitingForALine = [];
  let theInputHasEnded = false;

  function makeInputEndedError() {
    return new Error("Input ended before all the questions had been answered.");
  }

  readlineInterface.on("line", function (line) {
    if (questionsWaitingForALine.length > 0) {
      const waitingQuestion = questionsWaitingForALine.shift();
      waitingQuestion.resolve(line);
    } else {
      linesThatArrivedEarly.push(line);
    }
  });

  readlineInterface.on("close", function () {
    theInputHasEnded = true;
    while (questionsWaitingForALine.length > 0) {
      const waitingQuestion = questionsWaitingForALine.shift();
      waitingQuestion.reject(makeInputEndedError());
    }
  });

  function waitForNextLine() {
    if (linesThatArrivedEarly.length > 0) {
      const line = linesThatArrivedEarly.shift();
      return Promise.resolve(line);
    }
    if (theInputHasEnded) {
      return Promise.reject(makeInputEndedError());
    }
    return new Promise(function (resolve, reject) {
      questionsWaitingForALine.push({ resolve: resolve, reject: reject });
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

// Keeps asking "64 or 128?" until the user types exactly one of those.
async function askHowManyDiceRolls(waitForNextLine) {
  while (true) {
    const answer = await askQuestion(
      waitForNextLine,
      "How many dice rolls will you enter - 64 (12 words) or 128 (24 words)? "
    );
    const trimmedAnswer = answer.trim();
    if (trimmedAnswer === "64" || trimmedAnswer === "128") {
      return Number(trimmedAnswer);
    }
    console.log('Please type exactly "64" or "128".');
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

// Explains how to re-create the same seed phrase somewhere else. This is the
// single best protection against a bug in this program: if a second,
// unrelated tool turns the same dice rolls into the same words, then both
// tools would have to be wrong in exactly the same way to lose your money.
//
// The command below deliberately does NOT contain your real dice rolls. A
// ready-made command is easy to paste, and pasting it writes your rolls into
// your shell's history file, in plain text, on disk - somewhere they have
// never been, because this program reads them from stdin rather than as a
// command-line argument. Your rolls are your seed phrase in another form, so
// a convenience that quietly makes them outlive the session is not worth it.
//
// Instead the shape of the command is shown with a made-up example, which is
// enough to type your own. The entropy IS printed, because you need it to
// compare against - and it deserves exactly the same care as the words.
function printHowToVerifyElsewhere(numberOfRolls, entropyHexText) {
  console.log("");
  console.log("----------------------------------------------------------------------");
  console.log("Optional but recommended: check this seed phrase against another tool.");
  console.log("");
  console.log("  1. Your entropy, in hexadecimal, is:");
  console.log("       " + entropyHexText);
  console.log("");
  console.log("  2. Any computer can recompute it from your rolls with:");
  console.log("");
  console.log("       printf '<all " + numberOfRolls + " of your rolls>' | shasum -a 256");
  console.log("");
  console.log("     For example, rolls that began 5, 3, 1, 6, 2 would be typed as");
  console.log("     (this is an example, NOT your rolls):");
  console.log("");
  console.log("       printf '53162...' | shasum -a 256");
  console.log("");
  console.log("     The first " + entropyHexText.length + " characters of that hash must equal the line above.");
  console.log("");
  console.log("     Your own rolls are not printed here on purpose: a ready-made");
  console.log("     command is easy to paste, and pasting it writes your rolls into");
  console.log("     your shell's history file, on disk, where they would outlive");
  console.log("     this session. Type the command out with a leading space (most");
  console.log("     shells then keep it out of history), or clear that history");
  console.log("     afterwards.");
  console.log("");
  console.log("  3. Paste that entropy into any other offline BIP-39 tool. If it");
  console.log("     shows the same words, two independent programs agree.");
  console.log("");
  console.log("Your rolls, that hex string and the words above are three ways of");
  console.log("writing the same secret. Never type any of them into anything");
  console.log("connected to a network.");
  console.log("----------------------------------------------------------------------");
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
// Three kinds of check run here:
//   1. Official BIP-39 test vectors: known entropy values paired with the
//      exact seed phrase they must produce.
//   2. Known dice vectors: fixed roll sequences with the entropy and words
//      they must produce, so any accidental change to the dice-to-entropy
//      step is caught. You can verify these by hand - see the printed
//      shasum command.
//   3. Refusal checks: input this program must REJECT rather than quietly
//      turn into a weak seed phrase.

// A tiny helper so every check below reads the same way and gets counted.
function makeChecker() {
  const tally = { passed: 0, total: 0 };

  function check(didPass, description, extraDetail) {
    tally.total = tally.total + 1;
    if (didPass) {
      tally.passed = tally.passed + 1;
      console.log("PASS  " + description);
    } else {
      console.log("FAIL  " + description);
      if (extraDetail) {
        console.log(extraDetail);
      }
    }
  }

  return { check: check, tally: tally };
}

// Runs a function that is EXPECTED to throw, and reports whether it did.
function checkThatItRefuses(check, description, functionThatShouldThrow) {
  let itThrew = false;
  try {
    functionThatShouldThrow();
  } catch (error) {
    itThrew = true;
  }
  check(itThrew, description);
}

function runSelfTest() {
  const { check, tally } = makeChecker();

  // --- 1. Official BIP-39 test vectors -------------------------------
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
      entropyHexText: "80".repeat(16),
      expectedMnemonic:
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
    },
    {
      entropyHexText: "ff".repeat(16),
      expectedMnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
    },
    {
      entropyHexText: "9e885d952ad362caeb4efe34a8e91bd2",
      expectedMnemonic: "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic",
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
    {
      entropyHexText: "68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c",
      expectedMnemonic:
        "hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length",
    },
  ];

  for (let index = 0; index < officialTestVectors.length; index = index + 1) {
    const testVector = officialTestVectors[index];
    const entropyByteNumbers = Array.from(Buffer.from(testVector.entropyHexText, "hex"));
    const actualMnemonic = convertEntropyBytesToMnemonic(entropyByteNumbers);
    check(
      actualMnemonic === testVector.expectedMnemonic,
      "BIP-39 vector " + testVector.entropyHexText.slice(0, 16) + "...",
      "  expected: " + testVector.expectedMnemonic + "\n  actual:   " + actualMnemonic
    );
  }

  // --- 2. Known dice vectors -----------------------------------------
  // Fixed roll sequences and the exact entropy and words they must produce.
  // Verify the entropy yourself, offline, with the printed command.
  const diceTestVectors = [
    {
      diceRollText: "2266221566312421226244661114266333224653225432333531631656251526",
      expectedEntropyHexText: "eb53dd9a8255867c26499b1686e24b2a",
      expectedMnemonic: "twice page grit again flash dignity odor cricket bird damage name few",
    },
    {
      diceRollText: "46651126466545645251443634641651424433234344664525542262521656626444433446163315543416255315322213564412456536456256412313516366",
      expectedEntropyHexText: "c142dfb09873256104e72a0cf33905ae7568a334575c3191281eae960fbb8d4e",
      expectedMnemonic: "scout black umbrella couch crane rack bean torch artefact oil door friend final face spend twist cover matter amateur frog genius tape cry sentence",
    },
  ];

  for (let index = 0; index < diceTestVectors.length; index = index + 1) {
    const testVector = diceTestVectors[index];
    const numberOfRolls = testVector.diceRollText.length;
    const settings = DICE_ROLL_SETTINGS[numberOfRolls];
    const entropyByteNumbers = convertDiceRollsToEntropyBytes(
      testVector.diceRollText,
      settings.numberOfEntropyBytes
    );
    const actualEntropyHexText = convertBytesToHexText(entropyByteNumbers);
    const actualMnemonic = convertDiceRollsToMnemonic(testVector.diceRollText, numberOfRolls);

    check(
      actualEntropyHexText === testVector.expectedEntropyHexText,
      numberOfRolls + " rolls -> entropy " + testVector.expectedEntropyHexText.slice(0, 16) + "...",
      "  expected: " + testVector.expectedEntropyHexText + "\n  actual:   " + actualEntropyHexText
    );
    check(
      actualMnemonic === testVector.expectedMnemonic,
      numberOfRolls + " rolls -> " + settings.numberOfWords + " words",
      "  expected: " + testVector.expectedMnemonic + "\n  actual:   " + actualMnemonic
    );
    check(
      actualMnemonic.split(" ").length === settings.numberOfWords &&
        actualMnemonic.split(" ").every(function (word) {
          return WORDLIST.includes(word);
        }),
      numberOfRolls + " rolls -> every word is a real BIP-39 word"
    );
  }

  // --- 3. Things this program must refuse to do ----------------------
  const goodRolls64 = diceTestVectors[0].diceRollText;

  checkThatItRefuses(check, "refuses an unsupported roll count", function () {
    convertDiceRollsToMnemonic(goodRolls64, 50);
  });
  checkThatItRefuses(check, "refuses too few rolls for the count given", function () {
    convertDiceRollsToMnemonic(goodRolls64.slice(0, 40), 64);
  });
  checkThatItRefuses(check, "refuses an empty roll sequence", function () {
    convertDiceRollsToMnemonic("", 64);
  });
  checkThatItRefuses(check, "refuses a die face outside 1-6", function () {
    convertDiceRollsToMnemonic("7" + goodRolls64.slice(1), 64);
  });
  checkThatItRefuses(check, "refuses 64 identical rolls", function () {
    convertDiceRollsToMnemonic("4".repeat(64), 64);
  });
  checkThatItRefuses(check, "refuses rolls using only two die faces", function () {
    convertDiceRollsToMnemonic("12".repeat(32), 64);
  });
  checkThatItRefuses(check, 'refuses a repeated pattern like "12345612345..."', function () {
    convertDiceRollsToMnemonic("12345612".repeat(8), 64);
  });
  checkThatItRefuses(check, "refuses a pattern that stops part-way through a repeat", function () {
    // "123456" ten times, then "1234" - 64 rolls, but not a whole number of repeats.
    convertDiceRollsToMnemonic("123456".repeat(11).slice(0, 64), 64);
  });
  checkThatItRefuses(check, "refuses entropy that is not a BIP-39 size", function () {
    convertEntropyBytesToMnemonic([1, 2, 3]);
  });
  checkThatItRefuses(check, "refuses an entropy byte outside 0-255", function () {
    convertEntropyBytesToMnemonic(new Array(16).fill(999));
  });

  // --- 4. The word list itself ---------------------------------------
  check(WORDLIST.length === 2048, "word list holds exactly 2048 words");
  check(new Set(WORDLIST).size === 2048, "every word in the list is unique");

  console.log("");
  console.log(tally.passed + "/" + tally.total + " checks passed.");
  console.log("");
  console.log("You can verify the dice vectors above by hand, offline:");
  console.log("  printf '" + diceTestVectors[0].diceRollText + "' | shasum -a 256");
  console.log("  -> must start with " + diceTestVectors[0].expectedEntropyHexText);

  const allChecksPassed = tally.passed === tally.total;
  process.exit(allChecksPassed ? 0 : 1);
}

// ---------------------------------------------------------------------
// PART 5: The main program
// ---------------------------------------------------------------------

async function runInteractiveProgram(skipInternetCheck) {
  console.log("======================================================================");
  console.log("dice-to-seed: offline BIP-39 seed phrase generator from dice rolls");
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

  // Real terminal: use the live-updating grid from dice-input.js. It reads keystrokes directly, so we
  // must close this readline interface first (the two cannot both read stdin at the same time).
  // Piped input (for example a script or a test): the grid has no meaning without a real terminal, so
  // dice-input.js falls back to reading one plain line, using the same waitForNextLine queue as above.
  let diceRollText;
  if (process.stdin.isTTY) {
    readlineInterface.close();
    console.log("Type each die face as you roll it - the grid below tracks your progress.\n");
    diceRollText = await collectDiceRollsInteractive(numberOfRolls);
  } else {
    try {
      diceRollText = await collectDiceRollsFromLines(waitForNextLine, numberOfRolls);
    } finally {
      readlineInterface.close();
    }
  }

  // This is the step that checks the rolls and can refuse them, so it comes
  // first: nothing is computed or printed from input that will be rejected.
  const mnemonic = convertDiceRollsToMnemonic(diceRollText, numberOfRolls);
  // The same entropy again, this time so it can be shown for cross-checking.
  const settings = DICE_ROLL_SETTINGS[numberOfRolls];
  const entropyByteNumbers = convertDiceRollsToEntropyBytes(
    diceRollText,
    settings.numberOfEntropyBytes
  );

  printMnemonic(mnemonic);
  printHowToVerifyElsewhere(numberOfRolls, convertBytesToHexText(entropyByteNumbers));

  console.log("");
  console.log("Write this down on paper now. Do not store it digitally, screenshot it,");
  console.log("or type it anywhere else. Clear your terminal scrollback when done.");
}

// Only run the program automatically if this file was launched directly
// (for example "node dice-to-seed.js"), not if some other file requires it.
if (require.main === module) {
  const commandLineArguments = process.argv;
  if (commandLineArguments.includes("--selftest")) {
    runSelfTest();
  } else {
    // Both spellings are accepted: --skip-internet-check is the documented
    // name, --ignore-internet-check is what earlier versions of this program
    // used. Silently ignoring an unrecognised spelling would be dangerous
    // here - the user would believe they had skipped the check when they had
    // not - so it is better to answer to both names.
    const skipInternetCheck =
      commandLineArguments.includes("--skip-internet-check") ||
      commandLineArguments.includes("--ignore-internet-check");
    // Any failure - input ending early, a rejected roll sequence, an
    // unexpected bug - is reported on the error stream and exits with a
    // non-zero code, so a script can never mistake a missing seed phrase for
    // a successful run.
    runInteractiveProgram(skipInternetCheck).catch(function (error) {
      process.stderr.write("\nCould not generate a seed phrase: " + error.message + "\n");
      process.exitCode = 1;
    });
  }
}

module.exports = {
  DICE_ROLL_SETTINGS,
  findProblemWithDiceRollText,
  findProblemWithDiceRandomness,
  convertDiceRollsToEntropyBytes,
  convertBytesToHexText,
  convertEntropyBytesToMnemonic,
  convertDiceRollsToMnemonic,
};

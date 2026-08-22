#!/usr/bin/env node

// selftest.ts
//
// Proof that the maths in libs/mnemonic.ts is correct, kept in its own file
// so that the program itself contains nothing but the program. Test vectors, expected
// answers and check-counting machinery are not part of generating a seed
// phrase, and mixing them in would make the file you are asked to read
// before trusting your money longer than it needs to be.
//
// A real run never loads this file at all: dice-to-seed.ts only imports it
// when you actually ask for --selftest.
//
// HOW TO RUN
// ----------
//   node selftest.ts                 -> run every check
//   node dice-to-seed.ts --selftest  -> exactly the same thing
//
// Either way the process exits with status 0 if every check passed and 1 if
// any check failed, so a script can rely on it.

import { WORDLIST } from "./wordlist.ts";
import {
  settingsForRollCount,
  convertDiceRollsToEntropyBytes,
  convertBytesToHexText,
  convertEntropyBytesToMnemonic,
  convertDiceRollsToMnemonic,
} from "./libs/mnemonic.ts";

// A known entropy value and the exact words BIP-39 says it must produce.
type EntropyVector = {
  entropyHexText: string;
  expectedMnemonic: string;
};

// A known roll sequence and the exact entropy and words it must produce.
type DiceVector = {
  diceRollText: string;
  expectedEntropyHexText: string;
  expectedMnemonic: string;
};

// Records one check and prints its result. `extraDetail` is only printed when
// the check failed, to show what was expected against what came out.
type Check = (didPass: boolean, description: string, extraDetail?: string) => void;

// ---------------------------------------------------------------------
// What is checked
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
function makeChecker(): { check: Check; tally: { passed: number; total: number } } {
  const tally = { passed: 0, total: 0 };

  function check(didPass: boolean, description: string, extraDetail?: string): void {
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
function checkThatItRefuses(
  check: Check,
  description: string,
  functionThatShouldThrow: () => unknown
): void {
  let itThrew = false;
  try {
    functionThatShouldThrow();
  } catch (error) {
    itThrew = true;
  }
  check(itThrew, description);
}

export function runSelfTest(): boolean {
  const { check, tally } = makeChecker();

  // --- 1. Official BIP-39 test vectors -------------------------------
  const officialTestVectors: EntropyVector[] = [
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

  for (const testVector of officialTestVectors) {
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
  const diceTestVectors: DiceVector[] = [
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

  for (const testVector of diceTestVectors) {
    const numberOfRolls = testVector.diceRollText.length;
    const settings = settingsForRollCount(numberOfRolls);
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
        actualMnemonic.split(" ").every(function (word: string): boolean {
          return WORDLIST.includes(word);
        }),
      numberOfRolls + " rolls -> every word is a real BIP-39 word"
    );
  }

  // --- 3. Things this program must refuse to do ----------------------
  const firstDiceVector = diceTestVectors[0];
  if (firstDiceVector === undefined) {
    throw new Error("the dice test vectors above are missing");
  }
  const goodRolls64 = firstDiceVector.diceRollText;

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
  console.log("  printf '" + firstDiceVector.diceRollText + "' | shasum -a 256");
  console.log("  -> must start with " + firstDiceVector.expectedEntropyHexText);

  // Report rather than exiting here, so that whoever called this decides what
  // to do with the answer (both callers below turn it into an exit status).
  return tally.passed === tally.total;
}

// Run the checks when this file is launched directly ("node selftest.ts").
// When dice-to-seed.ts --selftest imports it instead, that file calls
// runSelfTest() and handles the exit status the same way.
if (import.meta.main) {
  const allChecksPassed = runSelfTest();
  process.exit(allChecksPassed ? 0 : 1);
}

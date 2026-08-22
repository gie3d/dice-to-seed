#!/usr/bin/env node

// dice-to-seed.ts
//
// This program turns physical six-sided dice rolls into a BIP-39 seed phrase
// (also called a "mnemonic"). A seed phrase is a list of 12 or 24 English
// words that can be used to create a Bitcoin wallet.
//
// This file is only the FLOW: the order things happen in, from the opening
// banner to the printed words. Every step below is one call into libs/, so
// that this file can be read start to finish in a minute and each piece can
// then be read on its own.
//
// HOW TO RUN
// ----------
//   node dice-to-seed.ts              -> normal interactive program
//   node dice-to-seed.ts --selftest   -> check this program against known
//                                        correct answers before trusting it
//                                        with real dice rolls
//   node dice-to-seed.ts --skip-internet-check
//                                      -> skip the "are you online" check
//                                        (--ignore-internet-check also works)
//
// Yes, Node runs the .ts files directly. Node strips the type annotations as
// it loads each file and runs what is left; nothing is compiled to disk and
// nothing is installed. This needs Node 22.18 or newer (24 recommended - see
// .nvmrc). The types are there to be read, and to stop whole classes of
// mistake before they can reach your dice: see libs/validate.ts for the
// clearest example.
//
// WHERE EVERYTHING LIVES
// -----------------------
//   libs/mnemonic.ts      The maths: dice rolls -> entropy -> seed phrase.
//                         Read this one first if you read only one.
//   libs/validate.ts      What counts as acceptable input, and why bad input
//                         is refused rather than quietly repaired.
//   libs/dice-input.ts    Collecting the rolls: the live grid on a real
//                         terminal, the plain line reader when piped.
//   libs/prompts.ts       Asking questions and reading answers safely.
//   libs/connectivity.ts  The offline check - the only networking code here.
//   libs/output.ts        Everything the program prints, including the
//                         safety advice at the end.
//   wordlist.ts           The official 2048-word BIP-39 English list.
//   selftest.ts           The test vectors and checks. A real run never
//                         loads this file.
//
// NO INSTALL NEEDED
// ------------------
// Only features already built into Node.js are used ("crypto", "net" and
// "readline"), plus the files listed above. There is nothing to install and
// no "npm install" to run, so there is no third-party code anywhere in the
// path between your dice and your seed phrase.
//
// THE BIG PICTURE
// ----------------
// 1. You roll a die 64 times (for 12 words) or 128 times (for 24 words) and
//    type the faces in, giving a line of text such as "6142...".
// 2. That text is hashed with SHA-256, and the hash becomes your entropy.
// 3. A few checksum bits are appended, and the result is cut into groups of
//    11 bits, each naming one word from the official BIP-39 word list.
// See libs/mnemonic.ts for the details, and for why the rolls are hashed
// rather than read as one big base-6 number.

import { isThisComputerOnline } from "./libs/connectivity.ts";
import { startAskingQuestions, askHowManyDiceRolls } from "./libs/prompts.ts";
import { collectDiceRolls } from "./libs/dice-input.ts";
import { buildSeedPhraseFromDiceRolls } from "./libs/mnemonic.ts";
import {
  printBanner,
  printInternetCheckSkipped,
  printCheckingForInternet,
  printOnlineRefusal,
  printOfflineReminder,
  printMnemonic,
  printHowToVerifyElsewhere,
  printFinalAdvice,
} from "./libs/output.ts";

// Step 1 of the flow, kept separate because it is the one step that can end
// the program before anything else happens. Returns true if it is safe to
// carry on, false if this computer looks like it is online.
async function confirmThisComputerIsOffline(skipInternetCheck: boolean): Promise<boolean> {
  if (skipInternetCheck) {
    printInternetCheckSkipped();
    return true;
  }

  printCheckingForInternet();
  if (await isThisComputerOnline()) {
    printOnlineRefusal();
    return false;
  }

  printOfflineReminder();
  return true;
}

// The whole program, in the order it happens.
async function runInteractiveProgram(skipInternetCheck: boolean): Promise<void> {
  printBanner();

  // 1. Refuse to go any further if this computer can reach the internet.
  const safeToContinue = await confirmThisComputerIsOffline(skipInternetCheck);
  if (!safeToContinue) {
    process.exitCode = 1;
    return;
  }

  // 2. Ask how long a seed phrase the user wants, in dice rolls.
  const { readlineInterface, waitForNextLine } = startAskingQuestions();
  const numberOfRolls = await askHowManyDiceRolls(waitForNextLine);

  // 3. Collect that many die faces, live grid or piped line as appropriate.
  const diceRollText = await collectDiceRolls(numberOfRolls, waitForNextLine, readlineInterface);

  // 4. Turn them into the seed phrase. This step also checks the rolls, and
  //    throws rather than build a seed phrase out of unusable input.
  const { mnemonic, entropyHexText } = buildSeedPhraseFromDiceRolls(diceRollText, numberOfRolls);

  // 5. Show the words, how to check them against another program, and what to
  //    do with them now.
  printMnemonic(mnemonic);
  printHowToVerifyElsewhere(numberOfRolls, entropyHexText);
  printFinalAdvice();
}

// Only run automatically if this file was launched directly (for example
// "node dice-to-seed.ts"), not if some other file imported it.
if (import.meta.main) {
  const commandLineArguments = process.argv;

  if (commandLineArguments.includes("--selftest")) {
    // Imported here rather than at the top of the file, so that a real run
    // never even loads the test code.
    const { runSelfTest } = await import("./selftest.ts");
    process.exit(runSelfTest() ? 0 : 1);
  } else {
    // Both spellings are accepted: --skip-internet-check is the documented
    // name, --ignore-internet-check is what earlier versions used. Silently
    // ignoring an unrecognised spelling would be dangerous here - the user
    // would believe they had skipped the check when they had not.
    const skipInternetCheck =
      commandLineArguments.includes("--skip-internet-check") ||
      commandLineArguments.includes("--ignore-internet-check");

    // Any failure - input ending early, a rejected roll sequence, an
    // unexpected bug - is reported on the error stream and exits non-zero, so
    // a script can never mistake a missing seed phrase for a successful run.
    runInteractiveProgram(skipInternetCheck).catch(function (error: Error): void {
      process.stderr.write("\nCould not generate a seed phrase: " + error.message + "\n");
      process.exitCode = 1;
    });
  }
}

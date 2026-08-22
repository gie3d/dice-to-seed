// libs/output.ts
//
// Everything the program prints. Keeping the wording here means the flow in
// dice-to-seed.ts stays readable as a flow, and it makes the safety advice
// easy to find, read and check in one place - it is as much a part of this
// program as the maths is.

// A line of "=" the same width as the banner text below it.
export function printBanner(): void {
  console.log("======================================================================");
  console.log("dice-to-seed: offline BIP-39 seed phrase generator from dice rolls");
  console.log("======================================================================");
}

// Shown when the user passed --skip-internet-check: the responsibility for
// being offline is now entirely theirs, so say so plainly.
export function printInternetCheckSkipped(): void {
  console.log("Skipping the internet check, as requested. Please make sure this");
  console.log("computer is actually disconnected from the internet before continuing.");
}

// Shown while the two connection probes are running (they take a moment).
export function printCheckingForInternet(): void {
  console.log("Checking whether this computer is online, please wait...");
}

// Shown when a probe succeeded, i.e. this computer can reach the internet.
// The program stops here: no dice are asked for, nothing is generated.
export function printOnlineRefusal(): void {
  console.log("");
  console.log("This computer appears to be online. For your safety, please disconnect");
  console.log("from the internet (Wi-Fi, Ethernet, Bluetooth) and run this again.");
  console.log("If you are sure you are offline, re-run with --skip-internet-check.");
}

// Shown when both probes failed, i.e. this computer looks offline. Still worth
// a reminder, because "looks offline" is not the same as "is offline".
export function printOfflineReminder(): void {
  console.log("No internet connection detected. For maximum safety, physically");
  console.log("disconnect this computer from all networks before continuing.");
}

// Prints the finished seed phrase, one numbered word per line.
export function printMnemonic(mnemonic: string): void {
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
export function printHowToVerifyElsewhere(
  numberOfRolls: number,
  entropyHexText: string
): void {
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

// The last thing printed: what to do with what is now on the screen.
export function printFinalAdvice(): void {
  console.log("");
  console.log("Write this down on paper now. Do not store it digitally, screenshot it,");
  console.log("or type it anywhere else. Clear your terminal scrollback when done.");
}

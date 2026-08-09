#!/usr/bin/env node
// ^ Must stay on line 1 (a shebang only works as the file's very first line): tells Unix-like shells to
// run this file with Node.js when executed directly (e.g. `./dice-to-seed.js`).

// Enables JS strict mode for this file: catches silent bugs like assigning to an undeclared variable.
"use strict";

/**
 * dice-to-seed.js
 *
 * Entry point. Converts physical six-sided dice rolls into a BIP-39
 * English mnemonic seed phrase, with a correctly computed checksum.
 *
 *   50 dice rolls  -> 128-bit entropy -> 12-word mnemonic
 *   100 dice rolls -> 256-bit entropy -> 24-word mnemonic
 *
 * This file only wires the pieces together and handles command-line
 * dispatch; the actual logic lives in ./lib/:
 *   - lib/mnemonic.js     Core dice-digits -> entropy -> BIP-39 conversion.
 *   - lib/validate.js     Dice-input validation (reject and re-prompt, never "fix").
 *   - lib/connectivity.js Offline check (the only networking code in this program).
 *   - lib/cli.js          Interactive prompt flow.
 *   - lib/selftest.js     Offline self-test against official BIP-39 test vectors.
 *   - wordlist.js         The official 2048-word BIP-39 English wordlist.
 *
 * SECURITY / PRIVACY NOTES
 * -------------------------
 * - Zero external dependencies. Only Node's built-in `crypto`,
 *   `readline`, and `net` modules are used (all ship with Node itself;
 *   nothing is installed from npm). See ./wordlist.js for the embedded
 *   BIP-39 English wordlist, sourced and hash-verified from the
 *   official bitcoin/bips repository (see that file's header comment).
 * - The only networking code in this program is an outbound-connection
 *   *probe*, run once at startup, before any dice input is requested,
 *   to confirm the machine is actually offline (see lib/connectivity.js).
 *   It opens plain TCP connections to two well-known IPs (1.1.1.1 and
 *   8.8.8.8, port 443) and immediately discards them — no data is sent
 *   beyond the TCP handshake, and nothing related to dice input or the
 *   mnemonic ever touches this code path (it hasn't been collected yet
 *   when the probe runs). If either connection succeeds, the program
 *   refuses to continue. This is a best-effort convenience check, not a
 *   guarantee: a machine behind a filtered network could still be online
 *   while both probes fail. For maximum assurance, physically disconnect/
 *   disable networking on the machine before running this, rather than
 *   relying on this check alone.
 * - Nothing is written to disk, logged, or transmitted anywhere.
 *   Output goes only to your terminal (stdout). Your dice input is
 *   read from stdin and is not written to any file or shell history
 *   (it is not passed as a command-line argument).
 * - Your raw dice input is never silently "corrected" or reinterpreted.
 *   It is validated (must be exactly 50 or 100 characters, each 1-6)
 *   and rejected with a re-prompt on any invalid entry; whatever
 *   digits you provide are used exactly as entered, in the order
 *   entered.
 *
 * SELF-TEST
 * ---------
 * Run `node dice-to-seed.js --selftest` to verify this implementation
 * against official BIP-39 test vectors (entropy -> mnemonic), entirely
 * offline, before you trust it with real dice rolls.
 *
 * FLAGS
 * -----
 * --selftest              Run the self-test above instead of the interactive flow.
 * --ignore-internet-check Skip the startup connectivity probe (see lib/connectivity.js)
 *                          and proceed even if the machine may be online. Only use
 *                          this if you've confirmed offline status some other way (e.g. you
 *                          trust your own network disconnection) and accept the risk of the
 *                          probe being wrong.
 */

const { checkInternetConnection } = require("./lib/connectivity.js");
const { main } = require("./lib/cli.js");
const { selfTest } = require("./lib/selftest.js");

// Runs the pre-flight connectivity check (unless explicitly bypassed), then either refuses to continue
// (if online) or hands off to the normal interactive flow. Kept separate from main() so the network
// probe always runs first and unconditionally — before any dice input is ever requested — whenever it
// runs at all.
async function run(skipInternetCheck) {
  // --ignore-internet-check bypasses the probe entirely: the user is asserting the machine is offline
  // and accepting the risk if that assertion is wrong. Nothing is probed or announced here in that case;
  // main() shows a one-line reminder of the bypass instead.
  if (!skipInternetCheck) {
    // Best-effort check for a working internet connection (see lib/connectivity.js).
    const isOnline = await checkInternetConnection();
    if (isOnline) {
      // Refuse to proceed: this tool is meant to be run air-gapped. Announce why and stop here —
      // no dice-roll prompt, no entropy generation, nothing else happens.
      console.log(
        "Internet connection detected. For your safety, this program will not run\n" +
          "while the machine appears to be online.\n\n" +
          "Disconnect Wi-Fi/Ethernet/Bluetooth (or use airplane mode / an air-gapped\n" +
          "machine), then run this again. If you understand the risk and want to\n" +
          "proceed anyway, re-run with --ignore-internet-check."
      );
      // Signal failure to the shell without treating it as a crash.
      process.exitCode = 1;
      return;
    }
  }
  // No connectivity detected (or the check was explicitly skipped) — proceed with the normal
  // interactive dice-to-mnemonic flow.
  await main(skipInternetCheck);
}

// True only when this file is run directly (e.g. `node dice-to-seed.js`), not when it's `require()`'d
// as a module from another file (as the exports below are, and as a future test file might).
if (require.main === module) {
  // Checks whether the `--selftest` flag was passed on the command line.
  if (process.argv.includes("--selftest")) {
    // Run the offline verification suite instead of the interactive prompt.
    selfTest();
  } else {
    // Checks whether the user explicitly opted to bypass the connectivity check, accepting the risk.
    const skipInternetCheck = process.argv.includes("--ignore-internet-check");
    // Run the connectivity check first (unless bypassed), then the interactive flow.
    run(skipInternetCheck);
  }
}

// Exposes the core conversion/validation functions so they can be re-used programmatically (e.g. by an
// automated test) without going through the interactive CLI.
module.exports = {
  ...require("./lib/mnemonic.js"),
  ...require("./lib/validate.js"),
};

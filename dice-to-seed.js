#!/usr/bin/env node
// ^ Must stay on line 1 (a shebang only works as the file's very first line): tells Unix-like shells to
// run this file with Node.js when executed directly (e.g. `./dice-to-seed.js`).

// Enables JS strict mode for this file: catches silent bugs like assigning to an undeclared variable.
"use strict";

/**
 * dice-to-seed.js
 *
 * Converts physical six-sided dice rolls into a BIP-39 English mnemonic
 * seed phrase, with a correctly computed checksum.
 *
 *   50 dice rolls  -> 128-bit entropy -> 12-word mnemonic
 *   100 dice rolls -> 256-bit entropy -> 24-word mnemonic
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
 *   to confirm the machine is actually offline (see
 *   checkInternetConnection() below). It opens plain TCP connections to
 *   two well-known IPs (1.1.1.1 and 8.8.8.8, port 443) and immediately
 *   discards them — no data is sent beyond the TCP handshake, and
 *   nothing related to dice input or the mnemonic ever touches this
 *   code path (it hasn't been collected yet when the probe runs). If
 *   either connection succeeds, the program refuses to continue. This
 *   is a best-effort convenience check, not a guarantee: a machine
 *   behind a filtered network could still be online while both probes
 *   fail. For maximum assurance, physically disconnect/disable
 *   networking on the machine before running this, rather than relying
 *   on this check alone.
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
 * --ignore-internet-check Skip the startup connectivity probe (see checkInternetConnection()
 *                          below) and proceed even if the machine may be online. Only use
 *                          this if you've confirmed offline status some other way (e.g. you
 *                          trust your own network disconnection) and accept the risk of the
 *                          probe being wrong.
 */

// Node's built-in cryptography module (ships with Node, not npm) — used only for its SHA-256 hash function.
const crypto = require("node:crypto");
// Node's built-in module for reading lines of text from stdin — used to prompt the user interactively.
const readline = require("node:readline");
// Node's built-in networking module — used only for the outbound connectivity probe described above.
const net = require("node:net");
// Loads the local 2048-word official BIP-39 English wordlist (see wordlist.js) as a plain array of strings.
const WORDLIST = require("./wordlist.js");

// Maps each supported dice-roll count to how many entropy bits it produces and how many words that yields.
const CONFIGS = {
  // 50 dice rolls -> 128 bits of entropy -> a 12-word mnemonic.
  50: { entropyBits: 128, wordCount: 12 },
  // 100 dice rolls -> 256 bits of entropy -> a 24-word mnemonic.
  100: { entropyBits: 256, wordCount: 24 },
};

// ---------------------------------------------------------------------
// Core conversion: dice digits (each 0-5) -> BIP-39 mnemonic string
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Input validation — rejects and re-prompts, never "fixes" your input
// ---------------------------------------------------------------------

// Validates a raw line of user input against the expected dice-roll count; never alters the digits themselves.
function parseDiceInput(raw, expectedCount) {
  // Removes all whitespace (spaces, tabs) so the user can type rolls with or without separators between them.
  const stripped = raw.replace(/\s+/g, "");
  // Reject outright if the digit count doesn't exactly match what was expected (50 or 100).
  if (stripped.length !== expectedCount) {
    // Explains precisely why the input was rejected, so the user can fix it themselves.
    return {
      ok: false,
      error: `Expected exactly ${expectedCount} digits, got ${stripped.length}.`,
    };
  }
  // Reject if any character isn't a digit 1 through 6 (the only valid faces on a six-sided die).
  if (!/^[1-6]+$/.test(stripped)) {
    return {
      ok: false,
      error: "Only digits 1-6 are allowed (one per die face).",
    };
  }
  // Convert each character ("1".."6") into a zero-based base-6 digit (0-5) for use by diceDigitsToEntropy.
  const digits = Array.from(stripped, (digitChar) => Number(digitChar) - 1); // 0-5
  // Input passed validation; return the converted digits for the caller to use unchanged.
  return { ok: true, digits };
}

// ---------------------------------------------------------------------
// Offline check — refuses to run if a network connection is detected
// ---------------------------------------------------------------------

// Attempts a raw TCP connection to a single host:port and resolves true/false depending on whether it
// connects before `timeoutMs` elapses. Never sends any data — the socket is destroyed the instant the
// outcome (connect, timeout, or error) is known.
function probeHost(host, port, timeoutMs) {
  return new Promise((resolve) => {
    // Starts an outbound TCP connection attempt to a fixed IP address (no DNS lookup involved).
    const socket = net.createConnection({ host, port });
    // Guards against calling `resolve` more than once (connect/timeout/error could otherwise race).
    let settled = false;
    // Shared cleanup: destroys the socket and resolves the promise exactly once.
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    // Caps how long we wait for a handshake before treating the host as unreachable.
    socket.setTimeout(timeoutMs);
    // A completed TCP handshake means this host is reachable, i.e. the machine is online.
    socket.once("connect", () => finish(true));
    // No response within timeoutMs — treat as unreachable.
    socket.once("timeout", () => finish(false));
    // Connection refused, network unreachable, etc. — treat as unreachable.
    socket.once("error", () => finish(false));
  });
}

// Best-effort check for whether this machine currently has a working internet connection. Probes two
// well-known, independently-operated IPs in parallel (Cloudflare and Google public DNS, port 443) so a
// single provider outage or block doesn't produce a false "offline" reading. Returns true if either
// probe succeeds. This cannot prove the machine is offline (a sufficiently filtered network could block
// both probes while other traffic still gets through) — see the header comment for that caveat.
async function checkInternetConnection(timeoutMs = 3000) {
  const results = await Promise.all([
    probeHost("1.1.1.1", 443, timeoutMs),
    probeHost("8.8.8.8", 443, timeoutMs),
  ]);
  return results.some(Boolean);
}

// ---------------------------------------------------------------------
// Interactive CLI
// ---------------------------------------------------------------------

// A persistent 'line' listener with a small queue, rather than chained
// rl.question() calls. rl.question() registers a fresh one-shot 'line'
// listener per call; when stdin is not a TTY (piped or redirected input,
// as opposed to a human typing at a real terminal), Node can emit several
// buffered 'line' events synchronously before the *next* question() has
// had a chance to register its listener, silently dropping that input.
// Queuing lines as they arrive avoids that race regardless of timing.
// Builds a small helper that lets us `await` one line of input at a time from a readline interface.
function createLineReader(readlineInterface) {
  // Holds lines that have already arrived from stdin but haven't been consumed by the caller yet.
  const bufferedLines = [];
  // Holds pending Promise `resolve` callbacks for callers who asked for a line before one was available.
  const pendingResolvers = [];
  // Fires every time the user (or piped input) completes a line of text ending in Enter/newline.
  readlineInterface.on("line", (line) => {
    // If someone is already waiting for a line, hand it to the oldest waiter immediately.
    if (pendingResolvers.length) pendingResolvers.shift()(line);
    // Otherwise, nobody has asked for it yet — buffer it in the queue for the next call to nextLine().
    else bufferedLines.push(line);
  });
  // Returns a Promise that resolves with the next available line of input.
  return function nextLine() {
    // If a line is already buffered, resolve immediately with it (removing it from the queue).
    if (bufferedLines.length) return Promise.resolve(bufferedLines.shift());
    // Otherwise, park this `resolve` in the pendingResolvers list until the 'line' event above delivers one.
    return new Promise((resolve) => pendingResolvers.push(resolve));
  };
}

// Prints a prompt to the terminal, then waits for and returns the user's next line of input.
async function ask(nextLine, prompt) {
  // Write the prompt without a trailing newline, so the user's typed answer appears on the same line.
  process.stdout.write(prompt);
  // Wait for (and return) the next line of input via the queued line reader above.
  return nextLine();
}

// Entry point for interactive use: walks the user through entering dice rolls and prints the mnemonic.
// `connectivityCheckSkipped` is true only when the caller bypassed checkInternetConnection() because the
// user passed --ignore-internet-check, and only changes the banner text below — it has no other effect.
async function main(connectivityCheckSkipped) {
  // Prints a visual divider line of 70 '=' characters.
  console.log("=".repeat(70));
  // Prints the program's title/banner.
  console.log("dice-to-seed: offline BIP-39 mnemonic generator from dice rolls");
  // Prints a matching divider line below the title.
  console.log("=".repeat(70));
  // A safety reminder shown before any input is requested, reflecting whether the connectivity probe
  // actually ran (see checkInternetConnection() and run() above/below) or was explicitly bypassed.
  if (connectivityCheckSkipped) {
    console.log(
      "Internet connectivity check was skipped (--ignore-internet-check). You\n" +
        "have asserted this machine is offline and accepted the risk if it is not.\n"
    );
  } else {
    console.log(
      "No internet connection was detected. For maximum assurance, physically\n" +
        "disconnect this machine from all networks before continuing.\n"
    );
  }

  // Creates a readline interface bound to the process's actual stdin/stdout streams.
  const readlineInterface = readline.createInterface({
    // Read user input from standard input (keyboard, or a pipe/redirect).
    input: process.stdin,
    // Write prompts/output to standard output (the terminal).
    output: process.stdout,
  });
  // Wraps that readline interface with our queue-based line reader (see createLineReader above).
  const nextLine = createLineReader(readlineInterface);

  // Wrapped in try/finally so the readline interface is always closed, even if something throws.
  try {
    // Will hold the validated roll count (50 or 100) once the user answers correctly.
    let rollCount;
    // Keep asking until we get a valid answer — invalid answers are rejected, never guessed or auto-corrected.
    while (true) {
      // Prompt the user and wait for their typed response, then trim leading/trailing whitespace from it.
      const answer = (
        await ask(nextLine, "How many dice rolls will you enter — 50 (12 words) or 100 (24 words)? ")
      ).trim();
      // Only these two exact strings are accepted.
      if (answer === "50" || answer === "100") {
        // Convert the validated string ("50"/"100") into the actual number 50 or 100.
        rollCount = Number(answer);
        // Valid answer received — exit the retry loop.
        break;
      }
      // Explain the expected format and loop back to ask again.
      console.log('Please answer exactly "50" or "100".');
    }

    // Will hold the validated, converted dice digits (array of 0-5 values) once entry succeeds.
    let digits;
    // Keep asking until the dice-roll input passes validation.
    while (true) {
      // Prompt mentions the exact count expected, based on the answer from the previous question.
      const raw = await ask(
        nextLine,
        `Enter your ${rollCount} dice rolls (digits 1-6, spaces optional): `
      );
      // Validate (but never silently fix) the raw typed line against the required roll count.
      const result = parseDiceInput(raw, rollCount);
      // Validation succeeded.
      if (result.ok) {
        // Store the converted 0-5 digit array for use in the entropy calculation.
        digits = result.digits;
        // Exit the retry loop.
        break;
      }
      // Validation failed — show exactly why, and require the user to type the entire sequence again
      // (rather than trying to patch just the bad part, which could introduce ambiguity).
      console.log("Invalid input: " + result.error + " Please re-enter all rolls.");
    }

    // Run the full dice-digits -> entropy -> BIP-39-mnemonic pipeline on the validated input.
    const mnemonic = diceRollsToMnemonic(rollCount, digits);
    // Zero out the raw dice-digit array in memory now that it's no longer needed (best-effort scrubbing).
    digits.fill(0);

    // Announce the result, including how many words it should contain, for the user to visually double check.
    console.log("\nYour mnemonic (" + CONFIGS[rollCount].wordCount + " words):\n");
    // Print the actual mnemonic phrase — this is the only place it's ever output, and only to the terminal.
    console.log(mnemonic);
    // Final safety reminder about handling the generated seed phrase securely.
    console.log(
      "\nWrite this down on paper now. Do not store it digitally, screenshot it,\n" +
        "or type it anywhere else. Clear your terminal scrollback when done."
    );
  } finally {
    // Releases the readline interface so the Node process can exit cleanly instead of hanging on open stdin.
    readlineInterface.close();
  }
}

// ---------------------------------------------------------------------
// Offline self-test against official BIP-39 test vectors
// ---------------------------------------------------------------------

// Verifies this file's BIP-39 implementation against known-correct official test vectors, fully offline.
function selfTest() {
  // Hex strings are built with repeat(), never hand-typed, so the byte
  // length can't silently drift from what each vector requires.
  // Each entry pairs a known entropy value (as hex) with the official mnemonic it must produce.
  const testVectors = [
    {
      // 16 bytes of 0x00 repeated = 128 bits of all-zero entropy.
      entropyHex: "00".repeat(16),
      // The official BIP-39 mnemonic for all-zero 128-bit entropy.
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    },
    {
      // 16 bytes of 0x7f repeated = 128 bits of entropy.
      entropyHex: "7f".repeat(16),
      mnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
    },
    {
      // 16 bytes of 0xff repeated = 128 bits of all-one entropy.
      entropyHex: "ff".repeat(16),
      mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
    },
    {
      // 32 bytes of 0x00 repeated = 256 bits of all-zero entropy.
      entropyHex: "00".repeat(32),
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    },
    {
      // 32 bytes of 0x7f repeated = 256 bits of entropy.
      entropyHex: "7f".repeat(32),
      mnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
    },
    {
      // 32 bytes of 0xff repeated = 256 bits of all-one entropy.
      entropyHex: "ff".repeat(32),
      mnemonic:
        "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
    },
  ];

  // Counts how many of the official test vectors matched exactly.
  let passCount = 0;
  // Check each vector in turn.
  for (const testVector of testVectors) {
    // Decode the vector's hex string back into raw entropy bytes.
    const entropy = Buffer.from(testVector.entropyHex, "hex");
    // Run our BIP-39 implementation on that entropy.
    const actualMnemonic = entropyToMnemonic(entropy);
    // Compare our output to the official expected mnemonic, character for character.
    const matches = actualMnemonic === testVector.mnemonic;
    // Print a PASS/FAIL line identifying which vector this was (by the start of its hex).
    console.log((matches ? "PASS" : "FAIL") + "  " + testVector.entropyHex.slice(0, 16) + "...");
    // On mismatch, show exactly what was expected vs. what we computed, to aid debugging.
    if (!matches) {
      console.log("  expected: " + testVector.mnemonic);
      console.log("  got:      " + actualMnemonic);
    } else {
      // Tally a passing vector.
      passCount++;
    }
  }

  // Sanity check on the dice path itself: 50 zeros (die face "1" repeated,
  // i.e. base-6 digit 0 repeated) must still deterministically produce a
  // valid, checksummed 12-word mnemonic drawn from the wordlist.
  // Simulates 50 dice rolls that all came up base-6 digit 0 (i.e. the user rolled "1" fifty times).
  const allZeroDigits50 = new Array(50).fill(0);
  // Runs the full dice-input pipeline (not just entropyToMnemonic) end to end for the 50-roll/12-word path.
  const mnemonic50 = diceRollsToMnemonic(50, allZeroDigits50);
  // Confirms the result is exactly 12 words and that every word is actually in the official wordlist.
  const isValid50 =
    mnemonic50.split(" ").length === 12 &&
    mnemonic50.split(" ").every((word) => WORDLIST.includes(word));
  // Reports the result of this structural check.
  console.log((isValid50 ? "PASS" : "FAIL") + "  50-roll dice path structural check");

  // Same idea, but simulating 100 dice rolls of base-6 digit 0 for the 24-word path.
  const allZeroDigits100 = new Array(100).fill(0);
  // Runs the full pipeline for the 100-roll/24-word path.
  const mnemonic100 = diceRollsToMnemonic(100, allZeroDigits100);
  // Confirms exactly 24 words, all drawn from the official wordlist.
  const isValid100 =
    mnemonic100.split(" ").length === 24 &&
    mnemonic100.split(" ").every((word) => WORDLIST.includes(word));
  // Reports the result of this structural check.
  console.log((isValid100 ? "PASS" : "FAIL") + "  100-roll dice path structural check");

  // Total number of checks run: the official vectors plus the 2 structural dice-path checks.
  const totalChecks = testVectors.length + 2;
  // Total number of checks that actually passed.
  const passedChecks = passCount + (isValid50 ? 1 : 0) + (isValid100 ? 1 : 0);
  // Prints a final summary line.
  console.log(`\n${passedChecks}/${totalChecks} checks passed.`);
  // Exits with status 0 (success) only if every single check passed; otherwise exits with status 1 (failure),
  // so this can be used as a pass/fail gate (e.g. in a script or CI check).
  process.exit(passedChecks === totalChecks ? 0 : 1);
}

// Runs the pre-flight connectivity check (unless explicitly bypassed), then either refuses to continue
// (if online) or hands off to the normal interactive flow. Kept separate from main() so the network
// probe always runs first and unconditionally — before any dice input is ever requested — whenever it
// runs at all.
async function run(skipInternetCheck) {
  // --ignore-internet-check bypasses the probe entirely: the user is asserting the machine is offline
  // and accepting the risk if that assertion is wrong. Nothing is probed or announced here in that case;
  // main() below shows a one-line reminder of the bypass instead.
  if (!skipInternetCheck) {
    // Best-effort check for a working internet connection (see checkInternetConnection() above).
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
// as a module from another file (as the self-test's own exports are, and as a future test file might).
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

// Exposes these functions so they can be re-used programmatically (e.g. by the self-test above, or by
// an automated test) without going through the interactive CLI.
module.exports = {
  diceDigitsToEntropy,
  entropyToMnemonic,
  diceRollsToMnemonic,
  parseDiceInput,
};

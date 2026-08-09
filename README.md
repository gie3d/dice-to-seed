# dice-to-seed

Generate a BIP-39 mnemonic seed phrase (12 or 24 words) from physical
six-sided dice rolls, entirely offline.

```
50  dice rolls  ->  128-bit entropy  ->  12-word mnemonic
100 dice rolls  ->  256-bit entropy  ->  24-word mnemonic
```

## Why dice instead of software randomness?

Most wallet software generates a seed using the operating system's random
number generator (RNG). That RNG is trustworthy in the vast majority of
cases — but it is also a black box: you cannot see it, and its output
depends on the OS, the hardware, and (for some embedded/hardware wallets)
firmware you did not write. Physical dice let you generate randomness
**you personally witnessed**, with a source of entropy that has been
used and studied for thousands of years and cannot be silently biased by
software, firmware, or a supply-chain compromise. This is the same
reasoning used by several hardware-wallet vendors and by longstanding
"roll your own entropy" guidance in the Bitcoin community.

This script's only job is arithmetic: turn your dice rolls into a
BIP-39-checksummed word list, correctly, and do nothing else.

## Design principles

- **Zero dependencies.** No `npm install`, no `package.json`, no
  `node_modules`. The only modules used are Node's own built-ins:
  `crypto` (for SHA-256, part of the BIP-39 checksum), `readline` (to
  prompt you interactively), and `net` (only for the offline check
  below). Nothing is fetched from the internet at install time.
- **Refuses to run if it detects an internet connection.** Before
  asking for any dice input, the script probes two well-known IPs
  (Cloudflare's `1.1.1.1` and Google's `8.8.8.8`, port 443) with a bare
  TCP handshake — no data is sent, nothing about your dice rolls or the
  mnemonic exists yet at this point. If either probe succeeds, it
  prints a warning and exits without proceeding. This is the *only*
  networking code in the program, and it is best-effort: a filtered
  network could in principle block both probes while other traffic
  still gets through, so it's a convenience backstop, not a substitute
  for physically disconnecting (see below).
- **No disk writes, no logs, no telemetry.** The mnemonic is printed to
  your terminal and nowhere else. Nothing is written to a file, a
  history, or a socket.
- **Your input is never "corrected."** Dice rolls are validated (must
  be exactly 50 or 100 digits, each 1–6) and rejected with a re-prompt
  if invalid. Whatever digits you type are used exactly as entered, in
  the order entered — the script never reinterprets or "fixes" them.
- **The wordlist is verifiable, not hand-typed.** `wordlist.js`
  contains the official 2048-word BIP-39 English list, sourced from the
  canonical [`bitcoin/bips`](https://github.com/bitcoin/bips) repository
  and checked against its well-known SHA-256 hash
  (`2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`)
  rather than retyped by hand, to remove transcription risk. See the
  header comment in that file.
- **Every line is commented**, explaining what it does and why — so you
  (or anyone you trust) can read the entire implementation and verify
  it does only what this README says.

## Files

```
dice-to-seed.js       Entry point: command-line dispatch, wires the pieces below together.
lib/mnemonic.js       Core conversion: dice digits -> entropy -> BIP-39 mnemonic.
lib/validate.js       Dice-input validation (reject and re-prompt, never "fix").
lib/connectivity.js   Offline check — the only networking code in this program.
lib/cli.js            Interactive prompt flow (readline-based).
lib/selftest.js       Offline self-test against official BIP-39 test vectors.
wordlist.js           The official 2048-word BIP-39 English wordlist.
```

## How it works

1. Each die roll (1–6) becomes a base-6 digit (0–5).
2. All digits are folded into one big integer (`accumulator = accumulator
   * 6 + digit`, using JavaScript's native arbitrary-precision `BigInt`
   — no library needed). 50 rolls carry ≈129.2 bits of entropy
   (`50 × log2(6)`); 100 rolls carry ≈258.5 bits. Both exceed the 128 /
   256 bits actually needed, so the result is truncated to exactly N
   bits. This is the same technique used by established dice→BIP-39
   tools.
3. The checksum is the first `N/32` bits of `SHA-256(entropy)`, per the
   [BIP-39 spec](https://github.com/bitcoin/bips/blob/master/bip-0039/bip-0039.mediawiki).
4. Entropy bits + checksum bits are concatenated and split into groups
   of 11 bits; each group (0–2047) indexes one word in the official
   English wordlist.

Run the built-in self-test at any time to verify this implementation
against official BIP-39 test vectors, fully offline:

```
node dice-to-seed.js --selftest
```

It should print `8/8 checks passed.`

## Requirements

- Node.js (any reasonably modern version; `.nvmrc` in this repo pins
  the version this was built and tested against — run `nvm use` if you
  use nvm). `BigInt` has been available in Node since v10.4, so this
  will work on far older versions too.
- No internet connection required — and, per the best practices below,
  none should be present while you run it. The script actively checks
  for this and refuses to run if it detects one (see above).

## Usage

```
node dice-to-seed.js
```

If the script detects an internet connection, it refuses to run and exits
before asking anything. If you're certain the machine is actually offline
(e.g. you've already disconnected it and trust the connectivity check to
be a false positive) and want to bypass the probe, pass
`--ignore-internet-check`:

```
node dice-to-seed.js --ignore-internet-check
```

This does not disable any other safety behavior — it only skips the
startup network probe. Only use it if you accept the risk that the probe
could be wrong in the other direction too (i.e. you could in fact be
online and this flag would let the script run anyway).

You'll be asked how many rolls you'll provide (50 or 100), then to type
them in as a string of digits 1–6 (spaces optional, e.g.
`3 1 6 2 5 4 ...` or `316254...`). The mnemonic is printed once, to your
terminal only.

## Best practices for generating a real seed

Take these seriously if the phrase you're about to generate will secure
real funds. None of this is enforced by the script — it's on you.

### Before you run it

- **Use real, physical dice**, not a phone app or "random.org." A
  standard casino/gaming d6, rolled on a hard flat surface, is fine.
  Prefer dice with sharp edges over rounded "fudge" dice, which can be
  slightly biased. If a die lands leaning against something or off the
  table, re-roll just that one and note it — don't guess.
- **Disconnect the network** before you start: turn off Wi-Fi, unplug
  Ethernet, and disable Bluetooth. Airplane mode is not always
  sufficient on every OS/driver combination — physically disconnecting
  is stronger. The script will refuse to run if it detects a
  connection, but that check only covers this one process — an
  air-gapped machine removes the network as a variable entirely,
  including from every *other* process running on that machine.
- **Consider a clean, disposable environment.** The strongest setup is
  a machine booted from a read-only or amnesiac live OS (e.g. Tails, or
  any live USB Linux distro) with no persistent storage, so nothing
  written during the session can survive a reboot. If that's not
  practical, at minimum use a machine you trust and have kept patched,
  and close every other application first.
- **Read the source first**, or have someone you trust read it — every
  line across `dice-to-seed.js` and `lib/` is commented specifically so
  this is practical to do yourself rather than take on faith (see
  [Files](#files) above for what lives where). Run
  `node dice-to-seed.js --selftest` and confirm `8/8 checks passed.`
  before entering real dice rolls.

### While you run it

- Type the dice digits yourself. Don't dictate them to voice input,
  don't let a cloud-synced keyboard (e.g. a phone keyboard app with
  cloud prediction/sync enabled) handle the input, and disable
  clipboard managers that sync to the cloud.
- The dice digits and resulting mnemonic are never written to a file or
  shell history by this script — but your *shell itself* may keep
  history of commands you run (not the dice digits you type into the
  prompt, since those go to stdin, not argv). If you're being
  extremely careful, run it from a shell with history disabled, or
  clear history afterward regardless.

### After you run it

- **Write the mnemonic on paper (or stamp it in metal) immediately.**
  Do not screenshot it, photograph it, paste it into a notes app, email
  it to yourself, or store it in any cloud service, password manager,
  or messaging app — even "for now."
- **Clear your terminal scrollback** (not just the visible screen —
  scrollback buffers persist and are sometimes saved to disk by
  terminal emulators). Close the terminal window/tab afterward.
- **Wipe or reboot the machine** if it's a shared or otherwise
  untrusted machine, especially if you used a live/amnesiac OS session
  — simply rebooting a RAM-only live session discards everything.
  If you ran this on your regular daily machine, the mnemonic passed
  through that machine's RAM; a persistent, sophisticated attacker with
  existing access to that machine could theoretically have observed it
  while the process was running. This is why a disposable/air-gapped
  environment is the stronger choice for high-value wallets.
- **Verify before you trust it.** Import the resulting mnemonic into an
  offline wallet (e.g. a hardware wallet in an air-gapped setup, or
  offline wallet software) and confirm it derives the addresses you
  expect, *before* you send any funds to it. Never type a real seed
  phrase into any device that is or will be connected to the internet.
- **Never re-enter or re-type your seed phrase into an online device**
  for "convenience" (e.g. to import into a hot wallet or exchange). If
  a workflow ever asks for it, treat that as a red flag.
- Consider whether a single paper copy is a single point of failure
  (fire, flood, loss) — many people keep a metal backup and/or split
  the phrase across secure locations. This script only generates the
  phrase; how you store it is a separate decision worth thinking
  through deliberately.

## What this script deliberately does *not* do

- It does not derive addresses, connect to any wallet software, or
  validate the mnemonic against a specific coin/derivation path — it
  only produces the BIP-39 mnemonic itself, so it has as small a job
  (and as small an attack surface) as possible.
- It does not save, cache, or remember anything between runs. Every run
  is independent and stateless.
- It will not "helpfully" fix malformed dice input — invalid input is
  always rejected and re-prompted, never guessed.

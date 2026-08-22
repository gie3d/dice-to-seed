# dice-to-seed

Generate a BIP-39 mnemonic seed phrase (12 or 24 words) from physical
six-sided dice rolls, entirely offline.

```
64  dice rolls  ->  SHA-256  ->  128-bit entropy  ->  12-word mnemonic
128 dice rolls  ->  SHA-256  ->  256-bit entropy  ->  24-word mnemonic
```

Written in TypeScript, and run directly: `node dice-to-seed.ts`. Node strips
the type annotations as it loads each file — there is no build step, no
compiler and no `node_modules` involved in generating a seed. This needs
Node 22.18 or newer (24 recommended; `.nvmrc` pins the tested version).

> **Changed from earlier versions.** This tool used to take 50/100 rolls
> and fold them into a big base-6 number. It now takes 64/128 rolls and
> hashes them with SHA-256. The results are different: **the same dice
> sequence produces a different seed phrase than it did before.** If you
> generated a seed with an older version, that seed is still perfectly
> valid — just don't expect this version to reproduce it from the same
> rolls. See [How it works](#how-it-works) for why this changed.

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
  `node_modules` — and no compiler, despite being TypeScript: Node
  runs the `.ts` files by erasing the types as it reads them. The
  `tsconfig.json` is only for editors and for an optional
  `tsc --noEmit` check you can run elsewhere; it is never needed to
  generate a seed. The only modules used are Node's own built-ins:
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
  be exactly 64 or 128 digits, each 1–6) and rejected with a re-prompt
  if invalid. Whatever digits you type are used exactly as entered, in
  the order entered — the script never reinterprets or "fixes" them.
- **Input that cannot have come from real dice is refused outright.**
  All 64 rolls the same digit, only two faces ever appearing, or a
  short repeating pattern (`123456123456…`) is rejected rather than
  hashed into a real-looking seed phrase. Genuine dice produce such a
  sequence with probability below 1 in 10²⁹ — so in practice it means
  something went wrong in the room, and the tool says so instead of
  handing you a seed you'd have trusted.
- **Every result is reproducible elsewhere.** Your entropy is just
  `SHA-256` of the digits you typed, so any second tool can confirm
  this program got it right (see [Verifying your seed](#verifying-your-seed-independently)).
- **The wordlist is verifiable, not hand-typed.** `wordlist.ts`
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
dice-to-seed.ts       The flow, and nothing else: the order things happen in,
                      from the opening banner to the printed words. ~150 lines,
                      readable in a minute.

libs/mnemonic.ts      The maths: dice rolls -> entropy -> seed phrase. Read
                      this one first if you read only one.
libs/validate.ts      What counts as acceptable input, and why bad input is
                      refused rather than quietly repaired.
libs/dice-input.ts    Collecting the rolls: the live grid on a real terminal,
                      the plain line reader when piped.
libs/prompts.ts       Asking questions and reading answers safely.
libs/connectivity.ts  The offline check — the only networking code here.
libs/output.ts        Everything the program prints, including the safety
                      advice at the end.

wordlist.ts           The official 2048-word BIP-39 English wordlist.
selftest.ts           Test vectors and checks. Not part of generating a seed —
                      a real run never loads this file.
tsconfig.json         Optional: settings for editors and for `tsc --noEmit`.
                      Never needed to run the program.
```

No dependencies, and every line is commented for a reader who is not a
cryptographer. Start at `dice-to-seed.ts` to see what happens in what
order, then open whichever step you want to check — the point is that you
can read all of it before trusting it with money.

## How it works

1. You type your rolls as digits, giving a line of text like `6142…`
   — 64 characters for 12 words, 128 for 24.
2. That text is hashed: `SHA-256("6142…")`. The first 16 bytes of the
   hash are your entropy for a 12-word phrase; all 32 bytes are your
   entropy for a 24-word phrase.
3. The checksum is the first `N/32` bits of `SHA-256(entropy)`, per the
   [BIP-39 spec](https://github.com/bitcoin/bips/blob/master/bip-0039/bip-0039.mediawiki).
4. Entropy bits + checksum bits are concatenated and split into groups
   of 11 bits; each group (0–2047) indexes one word in the official
   English wordlist.

### Why hashing, and why 64/128 rolls?

Earlier versions read the rolls as one big base-6 number and truncated
it with `mod 2^128`. That is easier to explain, but it has two real
problems:

- **Modulo bias.** 50 rolls carry ≈129.2 bits (`50 × log2(6)`), and
  `6^50 / 2^128 ≈ 2.375` — so some residues were reachable three ways
  and others only two. Concretely: **some 12-word seeds were exactly
  1.5× more likely than others**, and min-entropy was 127.66 bits
  rather than 128. Not a break, but not the uniform randomness the
  whole dice exercise exists to provide.
- **Real dice aren't perfectly fair.** Base-6 accumulation passes a
  die's physical bias straight through to the entropy. Hashing spreads
  the randomness of the entire sequence across every output bit, so a
  slight lean on one face no longer maps onto any particular part of
  the seed.

Hashing only helps if you feed it comfortably more randomness than you
take out — which is why the roll counts went up:

| Rolls | Entropy in | Entropy out | Margin |
|-------|-----------|-------------|--------|
| 64    | ≈165.4 bits (`64 × log2(6)`) | 128 bits | ≈37 bits |
| 128   | ≈330.8 bits | 256 bits | ≈75 bits |

At the old 50 rolls, hashing 129.2 bits down to 128 would have been a
thin extraction with no real margin — more rolls is what makes the hash
a clean conditioner rather than a cosmetic step.

## Verifying your seed independently

The strongest protection against a bug in *this* program is a second
program that agrees with it. Because your entropy is a plain SHA-256 of
the digits you typed, anything can recompute it:

```
printf '<your dice rolls>' | shasum -a 256
```

The tool shows you the shape of this command with a made-up example, but
deliberately **does not** fill in your actual rolls. Your rolls are your
seed phrase in another form, and a ready-to-paste command is easy to
paste — which would record them in your shell's history file, on disk,
the one place they have never been (the program reads them from stdin,
never as an argument). Type the command out yourself, with a leading
space (most shells then keep it out of history) or in a shell with
history disabled, and clear the history afterwards.

The first 32 hex characters (12-word) or all 64 (24-word) must match the
entropy the tool prints. Paste that entropy into any other offline
BIP-39 implementation and you should get the same words. Two independent
tools agreeing means both would have to be wrong in exactly the same way
to cost you money.

The entropy hex is another way of writing your seed phrase — treat it
with exactly the same care as the words.

Run the self-test at any time to verify this implementation against
official BIP-39 test vectors, fully offline — either way works:

```
node dice-to-seed.ts --selftest
node selftest.ts
```

It should print `27/27 checks passed.` The suite covers official BIP-39
test vectors, fixed dice→entropy→words vectors you can re-check by hand
with `shasum`, the wordlist's size and uniqueness, and — just as
important — the inputs the program must *refuse* (wrong roll counts,
short sequences, out-of-range faces, and non-random-looking rolls).

## Requirements

- **Node.js 22.18 or newer** (24 recommended; `.nvmrc` pins the version
  this was built and tested against — run `nvm use` if you use nvm).
  That floor is where Node began running `.ts` files directly by
  stripping their types; on anything older these files will not start.
  Everything else used is a long-standing built-in (`crypto`,
  `readline`, `net`).
- **No TypeScript compiler.** You do not need `tsc`, and you do not need
  `npm install`, to run this. If you *want* the compiler to check the
  types, install it outside this repo (`npm install --no-save
  typescript @types/node`, then `npx tsc --noEmit`) — and do that on
  your everyday machine, not the air-gapped one.
- No internet connection required — and, per the best practices below,
  none should be present while you run it. The script actively checks
  for this and refuses to run if it detects one (see above).

## Usage

```
node dice-to-seed.ts
```

If the script detects an internet connection, it refuses to run and exits
before asking anything. If you're certain the machine is actually offline
(e.g. you've already disconnected it and trust the connectivity check to
be a false positive) and want to bypass the probe, pass
`--skip-internet-check`:

```
node dice-to-seed.ts --skip-internet-check
```

(`--ignore-internet-check`, the name earlier versions used, is still
accepted.)

This does not disable any other safety behavior — it only skips the
startup network probe. Only use it if you accept the risk that the probe
could be wrong in the other direction too (i.e. you could in fact be
online and this flag would let the script run anyway).

You'll be asked how many rolls you'll provide (64 or 128). Then, in a real
terminal, a live grid appears and tracks your progress one roll at a time:

```
Roll 37 of 64 - type the die face (1-6).

   1-10: 3 1 6 2 5 4 3 2 1 6
  11-20: 2 4 1 5 3 6 2 1 4 3
  21-30: 5 6 1 2 4 3 6 5 1 2
  31-40: 4 3 · · · · · · · ·
  41-50: · · · · · · · · · ·
  51-60: · · · · · · · · · ·
  61-64: · · · ·
```

Just type each digit as you roll it — no need to press Enter between
rolls. The grid always shows exactly which roll you're on and everything
entered so far, so it's easy to keep your place through a long sequence
and to visually double-check it before committing. Backspace corrects
the most recent roll; once all of them are entered, press Enter to
confirm (or keep using Backspace to fix something first). Ctrl+C cancels
at any point.

(If stdin isn't a real terminal — e.g. you're piping input from a script
or test — the grid is skipped and rolls are instead read as one line of
digits. If that piped input ends before every question is answered, the
script says so on stderr and exits non-zero; it never exits quietly
without a seed phrase.)

The mnemonic is printed once, to your terminal only, followed by the
entropy hex and instructions for checking it against another tool.

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
  line is commented specifically so this is practical to do yourself
  rather than take on faith. `dice-to-seed.ts` shows the whole flow in
  about 150 lines; `libs/mnemonic.ts` is the one that actually turns
  your dice into words (see [Files](#files) above for what lives where).
  The types are part of the explanation: `libs/validate.ts` uses one to
  make "accepted rolls" and "reason they were refused" mutually
  exclusive by construction.
  Run `node dice-to-seed.ts --selftest` and confirm
  `27/27 checks passed.` before entering real dice rolls.

### While you run it

- Type the dice digits yourself. Don't dictate them to voice input,
  don't let a cloud-synced keyboard (e.g. a phone keyboard app with
  cloud prediction/sync enabled) handle the input, and disable
  clipboard managers that sync to the cloud.
- The dice digits and resulting mnemonic are never written to a file or
  shell history by this script — but your *shell itself* may keep
  history of commands you run (not the dice digits you type into the
  prompt, since those go to stdin, not argv). The one thing that can
  break this is the verification step: a `printf '<your rolls>' | shasum`
  command you type yourself *does* put your rolls in that history, which
  is why the tool shows only an example and leaves the typing to you.
  Either way, if you're being extremely careful, run everything from a
  shell with history disabled, or clear history afterward regardless.

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
- **Check it against a second tool.** Type
  `printf '<your rolls>' | shasum -a 256` with your own digits, and feed
  the resulting entropy to another offline BIP-39 implementation,
  confirming you get the same words (see
  [Verifying your seed](#verifying-your-seed-independently)). Do this on
  the same air-gapped machine — never type your rolls, the entropy, or
  the words into anything networked — and keep that command out of your
  shell history (leading space, or clear it afterwards).
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
- It does not add any randomness of its own. Your seed comes from your
  dice and nothing else: no `Math.random`, no OS RNG, no timestamps. Run
  it twice with the same rolls and you get the same phrase, which is
  exactly what makes it checkable against another tool.
- It cannot wipe the mnemonic from your computer's memory afterwards.
  JavaScript strings are immutable and the runtime may keep copies, so
  the only real defence is a machine that forgets — a live/amnesiac OS,
  or a reboot of a RAM-only session.

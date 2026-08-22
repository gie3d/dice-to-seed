// node-types.d.ts
//
// The Node.js features this program uses, described for the type checker.
//
// WHY THIS FILE EXISTS
// ---------------------
// Without it, an editor or `tsc` says "Cannot find name 'process'. Do you
// need to install type definitions for node?" and suggests
// `npm i --save-dev @types/node`. That package is perfectly fine, but this
// project deliberately installs nothing, so instead the handful of things
// actually used are written out here.
//
// It is not a copy of @types/node. It describes only what these files really
// touch, which has a pleasant side effect: this file doubles as an exact
// inventory of the program's contact with the outside world. If something is
// not described here, the program does not use it - and you can check that
// claim by deleting a line and watching what fails to compile.
//
// This file affects type checking ONLY. Node itself ignores it completely,
// and nothing here changes what the program does when it runs.
//
// IF YOU EVER DO INSTALL @types/node
// -----------------------------------
// Delete this file and put "types": ["node"] back in tsconfig.json. Keeping
// both will produce "duplicate identifier" errors, because they describe the
// same globals twice.

// ---------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------

// Only .log is used, and only ever with strings.
declare var console: {
  log(...values: unknown[]): void;
};

// The pieces of `process` this program touches. Anything not listed here -
// environment variables, the file system, signals - is not used at all.
declare var process: {
  // The command line, read once for --selftest and --skip-internet-check.
  argv: string[];
  // Set instead of exiting immediately, so pending output still gets printed.
  exitCode: number | undefined;
  // Used where the program must stop right now (a failed self-test, Ctrl+C).
  exit(code?: number): never;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
};

// Node's byte array. SHA-256 hands one back, and the BIP-39 step reads bytes
// out of it. Declared as Iterable so `for (const byte of hash)` and
// `Array.from(hash)` both work.
interface Buffer extends Iterable<number> {
  readonly length: number;
  // The first `end - start` bytes, used to keep the first 16 or 32 bytes of a
  // hash.
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
}

declare var Buffer: {
  // Bytes from a list of numbers (the entropy), or from hex text (test
  // vectors).
  from(data: readonly number[] | Buffer): Buffer;
  from(text: string, encoding: "hex"): Buffer;
  // The runtime check that guards convertEntropyBytesToMnemonic.
  isBuffer(value: unknown): value is Buffer;
};

// Node 22.18+ sets this to true in the file you launched, and false in every
// file that was imported. It is how each entry point knows whether to run.
interface ImportMeta {
  main: boolean;
}

declare namespace NodeJS {
  // Somewhere text can be written: process.stdout and process.stderr.
  interface WriteStream {
    write(text: string): boolean;
  }

  // The keyboard, in the two modes this program needs: ordinary lines, and
  // raw per-keystroke input for the live dice grid.
  interface ReadStream {
    // Undefined when input is piped in rather than typed at a terminal, which
    // is exactly what decides between the grid and the plain line reader.
    isTTY?: boolean;
    // Raw mode delivers keystrokes immediately and stops the terminal echoing
    // them, so the grid is the only thing drawing on screen.
    setRawMode(mode: boolean): void;
    resume(): void;
    pause(): void;
    on(
      event: "keypress",
      listener: (
        character: string | undefined,
        key: { name?: string; ctrl?: boolean } | undefined
      ) => void
    ): ReadStream;
    removeListener(event: "keypress", listener: (...args: never[]) => void): ReadStream;
  }
}

// ---------------------------------------------------------------------
// Built-in modules
// ---------------------------------------------------------------------

// Used for SHA-256 twice: once to turn dice rolls into entropy, once for the
// BIP-39 checksum. No random number generation anywhere - the randomness is
// your dice.
declare module "node:crypto" {
  export interface Hash {
    update(data: string | Buffer, inputEncoding?: "utf8"): Hash;
    digest(): Buffer;
  }
  export function createHash(algorithm: "sha256"): Hash;
}

// The entire networking surface of this program: open a TCP connection to see
// whether the machine is online, then throw it away. Nothing is ever sent.
declare module "node:net" {
  export interface Socket {
    setTimeout(milliseconds: number): Socket;
    on(event: "connect" | "timeout" | "error", listener: () => void): Socket;
    destroy(): void;
  }
  export function createConnection(options: { host: string; port: number }): Socket;
}

// Reading the keyboard, and moving the cursor around to redraw the dice grid
// in place.
declare module "node:readline" {
  export interface Interface {
    on(event: "line", listener: (line: string) => void): Interface;
    on(event: "close", listener: () => void): Interface;
    close(): void;
  }
  export function createInterface(options: {
    input: NodeJS.ReadStream;
    output: NodeJS.WriteStream;
  }): Interface;
  // Turns stdin's raw bytes into 'keypress' events.
  export function emitKeypressEvents(stream: NodeJS.ReadStream): void;
  export function moveCursor(stream: NodeJS.WriteStream, dx: number, dy: number): void;
  export function cursorTo(stream: NodeJS.WriteStream, x: number, y?: number): void;
  export function clearScreenDown(stream: NodeJS.WriteStream): void;
}

// libs/prompts.ts
//
// Asking the user questions, one line at a time.
//
// This is only about reading lines of text safely. The dice rolls themselves
// are collected in libs/dice-input.ts, which needs to read the keyboard in a
// different way.

import * as readline from "node:readline";
import { SUPPORTED_ROLL_COUNTS, settingsForRollCount } from "./mnemonic.ts";

// Awaiting one line of what the user types. It can also reject - see
// createLineWaiter below for why input that ends early has to be an error
// rather than a wait that never finishes.
export type WaitForNextLine = () => Promise<string>;

// The two halves of the conversation with the user: the readline interface
// itself (libs/dice-input.ts has to close it at the right moment) and the
// function for awaiting the next line.
export type Conversation = {
  readlineInterface: readline.Interface;
  waitForNextLine: WaitForNextLine;
};

// One question that is waiting for a line that has not arrived yet.
type WaitingQuestion = {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
};

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
function createLineWaiter(readlineInterface: readline.Interface): WaitForNextLine {
  const linesThatArrivedEarly: string[] = [];
  const questionsWaitingForALine: WaitingQuestion[] = [];
  let theInputHasEnded = false;

  function makeInputEndedError(): Error {
    return new Error("Input ended before all the questions had been answered.");
  }

  readlineInterface.on("line", function (line: string): void {
    // Hand the line to whoever asked first; if nobody is waiting for it yet,
    // keep it until somebody does.
    const waitingQuestion = questionsWaitingForALine.shift();
    if (waitingQuestion) {
      waitingQuestion.resolve(line);
    } else {
      linesThatArrivedEarly.push(line);
    }
  });

  readlineInterface.on("close", function (): void {
    theInputHasEnded = true;
    // splice(0) empties the list and hands back everything that was in it, so
    // every unanswered question is failed exactly once.
    for (const waitingQuestion of questionsWaitingForALine.splice(0)) {
      waitingQuestion.reject(makeInputEndedError());
    }
  });

  function waitForNextLine(): Promise<string> {
    const lineThatArrivedEarly = linesThatArrivedEarly.shift();
    if (lineThatArrivedEarly !== undefined) {
      return Promise.resolve(lineThatArrivedEarly);
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

// Opens the line-by-line conversation with the user and hands back both halves
// of it: the readline interface (which libs/dice-input.ts needs to close at
// the right moment) and the function for awaiting the next line.
export function startAskingQuestions(): Conversation {
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    readlineInterface: readlineInterface,
    waitForNextLine: createLineWaiter(readlineInterface),
  };
}

// Prints a question, then waits for (and returns) the user's next line.
async function askQuestion(
  waitForNextLine: WaitForNextLine,
  questionText: string
): Promise<string> {
  process.stdout.write(questionText);
  const answer = await waitForNextLine();
  return answer;
}

// Keeps asking until the user types exactly one of the supported roll counts.
// The wording is built from DICE_ROLL_SETTINGS, so the question can never
// drift out of step with the roll counts the maths actually accepts.
export async function askHowManyDiceRolls(waitForNextLine: WaitForNextLine): Promise<number> {
  const choices = SUPPORTED_ROLL_COUNTS.map(function (rollCount: number): string {
    return rollCount + " (" + settingsForRollCount(rollCount).numberOfWords + " words)";
  }).join(" or ");
  const exactAnswers = SUPPORTED_ROLL_COUNTS.map(function (rollCount: number): string {
    return '"' + rollCount + '"';
  }).join(" or ");

  while (true) {
    const answer = await askQuestion(
      waitForNextLine,
      "How many dice rolls will you enter - " + choices + "? "
    );
    const trimmedAnswer = answer.trim();
    // Compared as text on purpose: "64" is accepted, "064" and "64.0" are not,
    // so there is never any doubt about what the user meant.
    const matchingRollCount = SUPPORTED_ROLL_COUNTS.find(function (rollCount: number): boolean {
      return String(rollCount) === trimmedAnswer;
    });
    if (matchingRollCount !== undefined) {
      return matchingRollCount;
    }
    console.log("Please type exactly " + exactAnswers + ".");
  }
}

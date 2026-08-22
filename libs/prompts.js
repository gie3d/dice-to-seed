// libs/prompts.js
//
// Asking the user questions, one line at a time.
//
// This is only about reading lines of text safely. The dice rolls themselves
// are collected in libs/dice-input.js, which needs to read the keyboard in a
// different way.

"use strict";

const readline = require("node:readline");
const { DICE_ROLL_SETTINGS, SUPPORTED_ROLL_COUNTS } = require("./mnemonic.js");

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

// Opens the line-by-line conversation with the user and hands back both halves
// of it: the readline interface (which libs/dice-input.js needs to close at
// the right moment) and the function for awaiting the next line.
function startAskingQuestions() {
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
async function askQuestion(waitForNextLine, questionText) {
  process.stdout.write(questionText);
  const answer = await waitForNextLine();
  return answer;
}

// Keeps asking until the user types exactly one of the supported roll counts.
// The wording is built from DICE_ROLL_SETTINGS, so the question can never
// drift out of step with the roll counts the maths actually accepts.
async function askHowManyDiceRolls(waitForNextLine) {
  const choices = SUPPORTED_ROLL_COUNTS.map(function (rollCount) {
    return rollCount + " (" + DICE_ROLL_SETTINGS[rollCount].numberOfWords + " words)";
  }).join(" or ");
  const exactAnswers = SUPPORTED_ROLL_COUNTS.map(function (rollCount) {
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
    const matchingRollCount = SUPPORTED_ROLL_COUNTS.find(function (rollCount) {
      return String(rollCount) === trimmedAnswer;
    });
    if (matchingRollCount !== undefined) {
      return matchingRollCount;
    }
    console.log("Please type exactly " + exactAnswers + ".");
  }
}

module.exports = {
  createLineWaiter,
  startAskingQuestions,
  askHowManyDiceRolls,
};

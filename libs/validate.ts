// libs/validate.ts
//
// Everything that decides whether input is acceptable. Nothing here changes
// your dice rolls; it only answers "may we use these?" and, when the answer is
// no, says exactly why so you can fix it yourself.
//
// Two audiences:
//   - checkTypedDiceRolls() checks one line a person typed, and is used to
//     re-prompt them.
//   - findProblemWith...() are used deeper in, by libs/mnemonic.ts, so that
//     even code calling this project directly cannot slip a short or
//     impossible roll sequence past the maths.
//
// The types below are also part of the explanation: DiceRollCheck says, in a
// way the compiler enforces, that a result carries EITHER accepted rolls OR a
// reason they were refused - never both, and never neither.

// The answer from checkTypedDiceRolls. Reading `isValid` tells you which of
// the two shapes you have, so there is no way to read `diceRollText` off a
// result that was actually a refusal.
export type DiceRollCheck =
  | { isValid: true; diceRollText: string }
  | { isValid: false; reasonItIsInvalid: string };

// Looks at one line the user typed and decides whether it is a valid set of
// dice rolls. It never repairs the input: if anything is wrong it explains
// what, and the caller asks again for the whole line.
//
// It returns an object shaped like one of these two:
//   { isValid: true,  diceRollText: "6142..." }
//   { isValid: false, reasonItIsInvalid: "..." }
export function checkTypedDiceRolls(
  typedLine: string,
  expectedNumberOfRolls: number
): DiceRollCheck {
  // Remove every space and tab, so "1 2 3" and "123" are both accepted.
  const withoutSpaces = typedLine.replace(/\s+/g, "");

  // The count has to match exactly. Too few rolls would mean less
  // randomness than promised; too many would mean some were ignored.
  if (withoutSpaces.length !== expectedNumberOfRolls) {
    return {
      isValid: false,
      reasonItIsInvalid:
        "Expected exactly " +
        expectedNumberOfRolls +
        " digits, got " +
        withoutSpaces.length +
        ".",
    };
  }

  // Every character has to be a real die face: 1, 2, 3, 4, 5 or 6.
  for (const character of withoutSpaces) {
    if (character < "1" || character > "6") {
      return {
        isValid: false,
        reasonItIsInvalid: "Only digits 1-6 are allowed (one per die face).",
      };
    }
  }

  // All good: hand back the faces exactly as typed, minus the spaces.
  return { isValid: true, diceRollText: withoutSpaces };
}

// Checks that a piece of text really is a sequence of die faces of the
// expected length. Used by the functions below so that a mistake made by
// OTHER code (a future script calling into this file, say) fails loudly
// instead of quietly producing a weak seed phrase.
//
// Returns an error message, or null when everything is fine.
export function findProblemWithDiceRollText(
  diceRollText: unknown,
  expectedNumberOfRolls: number
): string | null {
  if (typeof diceRollText !== "string") {
    return "Dice rolls must be given as text, for example \"6142...\".";
  }
  if (diceRollText.length !== expectedNumberOfRolls) {
    return (
      "Expected exactly " +
      expectedNumberOfRolls +
      " dice rolls, got " +
      diceRollText.length +
      "."
    );
  }
  for (let index = 0; index < diceRollText.length; index = index + 1) {
    // charAt rather than [index] because charAt always hands back a string;
    // reading past the end of a string with [index] would give `undefined`,
    // and comparing that to "1" would quietly do the wrong thing.
    const character = diceRollText.charAt(index);
    if (character < "1" || character > "6") {
      return (
        "Dice rolls may only contain the digits 1-6; found " +
        JSON.stringify(character) +
        " at position " +
        (index + 1) +
        "."
      );
    }
  }
  return null;
}

// A safety net against input that cannot plausibly have come from real dice:
// somebody testing the program and forgetting it was for real, a stuck key,
// or a misunderstanding of the instructions. Rolling the same face 64 times
// in a row is possible in theory, but the odds are worse than 1 in 10^49 - so
// if we see it, something has gone wrong in the room, not in the dice.
//
// Note this check looks at the ROLLS, not at the hashed entropy. After
// hashing, even "1111..." produces random-looking entropy, so by then the
// mistake is invisible - this is the only place it can still be caught.
//
// Returns an error message, or null when the rolls look plausible.
export function findProblemWithDiceRandomness(diceRollText: string): string | null {
  // How many different faces appeared at all. Fewer than three different
  // faces over 64+ rolls is astronomically unlikely (below 1 in 10^29).
  const facesSeen = new Set(diceRollText.split(""));
  if (facesSeen.size === 1) {
    return (
      "every one of your " +
      diceRollText.length +
      " rolls is the digit " +
      diceRollText.charAt(0) +
      "."
    );
  }
  if (facesSeen.size < 3) {
    return (
      "your rolls only ever use " +
      facesSeen.size +
      " different die faces (" +
      Array.from(facesSeen).sort().join(", ") +
      ")."
    );
  }

  // A short repeating pattern, such as "123456123456123456..." - the sign of
  // a person typing a pattern rather than reading dice off a table.
  //
  // The comparison below repeats the pattern past the end and then trims, so
  // a sequence that stops part-way through a repeat ("...1234561234", where 64
  // rolls is not a whole number of six-digit patterns) is caught just the same.
  for (let patternLength = 1; patternLength <= 8; patternLength = patternLength + 1) {
    const pattern = diceRollText.slice(0, patternLength);
    const timesToRepeat = Math.ceil(diceRollText.length / patternLength);
    const patternStretchedOut = pattern.repeat(timesToRepeat).slice(0, diceRollText.length);
    if (patternStretchedOut === diceRollText) {
      return 'your rolls are just "' + pattern + '" repeated over and over.';
    }
  }

  return null;
}

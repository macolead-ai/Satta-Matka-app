// Matka result + bid settlement helpers.
//
// A full result is declared as an OPEN panna and a CLOSE panna (each a
// 3-digit number). From those we derive:
//   openAnk  = (sum of open panna digits) % 10        // 0-9
//   closeAnk = (sum of close panna digits) % 10        // 0-9
//   jodi     = openAnk followed by closeAnk             // "00"-"99"
//   value    = "OPEN-JODI-CLOSE"  e.g. "128-14-590"
//
// Winning rules used by the auto-settlement (documented so the operator
// can verify them against the client's exact payout policy before going
// live — getting these wrong pays out real money):
//   Single Digit : a picked digit wins if it equals the open ank OR the
//                  close ank. Credited once per matching selection.
//   Jodi Digits  : the 2-digit pick wins if it equals the jodi.
//   Panna (Single/Double/Triple): the 3-digit pick wins if it equals the
//                  declared open panna OR close panna.
//   Motor / Sangam and any other type: NOT auto-settled — flagged for
//                  manual settlement so nothing is credited on a guess.
//
// Payout: a winning selection pays stake x rate (the stake was already
// deducted when the bid was placed, so only the winnings are credited).

const RATES = {
  'Single Digit': 9.5,
  'Jodi Digits': 95,
  'Single Panna': 142,
  'Double Panna': 285,
  'Triple Panna': 700,
};

const digitSum = (s) => String(s).split('').reduce((a, c) => a + (Number(c) || 0), 0);
const ankOf = (panna) => digitSum(panna) % 10;

// Derive every number the settlement needs from the two pannas.
function deriveResult(openPanna, closePanna) {
  const op = String(openPanna), cp = String(closePanna);
  const openAnk = ankOf(op), closeAnk = ankOf(cp);
  const jodi = `${openAnk}${closeAnk}`;
  return { openPanna: op, closePanna: cp, openAnk, closeAnk, jodi, value: `${op}-${jodi}-${cp}` };
}

// For one bid, return { auto, win } where `auto` is false for game types we
// don't settle automatically, and `win` is the total winnings (0 = lost).
function bidWin(gameType, selections, d) {
  const rate = RATES[gameType];
  if (!rate) return { auto: false, win: 0 };
  let win = 0;
  for (const [key, amtRaw] of Object.entries(selections || {})) {
    const amt = Math.floor(Number(amtRaw));
    if (!amt || amt <= 0) continue;
    let hit = false;
    if (gameType === 'Single Digit') {
      const k = Number(key);
      hit = k === d.openAnk || k === d.closeAnk;
    } else if (gameType === 'Jodi Digits') {
      hit = String(key).padStart(2, '0') === d.jodi;
    } else {
      hit = String(key) === d.openPanna || String(key) === d.closePanna;
    }
    if (hit) win += amt * rate;
  }
  return { auto: true, win: Math.round(win) };
}

module.exports = { RATES, deriveResult, bidWin };

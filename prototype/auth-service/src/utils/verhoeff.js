/**
 * Verhoeff dihedral group D5 checksum validator for 12-digit Aadhaar UIDs.
 * Detects all single-digit errors and all adjacent transposition errors.
 */

const MULTIPLICATION_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const PERMUTATION_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const INVERSE_TABLE = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function computeVerhoeffChecksum(digits) {
  let c = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const digit = Number(digits[digits.length - 1 - i]);
    c = MULTIPLICATION_TABLE[c][PERMUTATION_TABLE[i % 8][digit]];
  }
  return c;
}

/**
 * Validates that a candidate string is 12 digits and passes the Verhoeff checksum.
 */
function isValidAadhaarUid(uid) {
  if (typeof uid !== 'string' || !/^\d{12}$/.test(uid)) {
    return false;
  }
  return computeVerhoeffChecksum(uid) === 0;
}

/**
 * Generates a valid 12-digit Verhoeff UID given an 11-digit base string.
 */
function appendVerhoeffDigit(base11Digits) {
  if (typeof base11Digits !== 'string' || !/^\d{11}$/.test(base11Digits)) {
    throw new Error('Expected an 11-digit numeric string');
  }
  let c = 0;
  for (let i = 0; i < base11Digits.length; i += 1) {
    const digit = Number(base11Digits[base11Digits.length - 1 - i]);
    c = MULTIPLICATION_TABLE[c][PERMUTATION_TABLE[(i + 1) % 8][digit]];
  }
  return `${base11Digits}${INVERSE_TABLE[c]}`;
}

function maskUid(uid) {
  if (typeof uid !== 'string' || uid.length < 4) return '****';
  return `${'*'.repeat(uid.length - 4)}${uid.slice(-4)}`;
}

module.exports = {
  isValidAadhaarUid,
  appendVerhoeffDigit,
  maskUid,
};

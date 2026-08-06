/**
 * The account students transfer their fees to.
 *
 * Payments are manual: a student transfers here, uploads the receipt, and an
 * admin confirms it. There is no payment gateway in the loop, so these details
 * are the whole payment instruction — they are served to both clients from one
 * place rather than typed into each UI, because an account number that drifts
 * between the app and the website sends money nowhere recoverable.
 *
 * A `settings/bankAccount` Firestore document overrides any of these fields, so
 * the account can be changed without a deploy. The constants below are what the
 * clients fall back to when Firestore is unreachable.
 */
const DEFAULT_BANK_ACCOUNT = {
  accountNumber: '8270157607',
  bankName:      'Moniepoint',
  accountName:   'NLTC Global Service- Next level tutorial',
  // Shown under the details so a student knows what to expect after uploading.
  note:          'Transfer the exact amount, then upload your receipt below. Confirmation usually takes under 2 hours.',
};

/** Fields a `settings/bankAccount` doc may override. Anything else is ignored. */
const OVERRIDABLE = ['accountNumber', 'bankName', 'accountName', 'note'];

/**
 * Merges a Firestore override over the defaults, dropping blanks.
 *
 * An empty string in the settings doc is treated as "not set" rather than as a
 * deliberate blank, so a half-filled document cannot erase the account number.
 */
function resolveBankAccount(override) {
  const out = { ...DEFAULT_BANK_ACCOUNT };
  if (override && typeof override === 'object') {
    for (const key of OVERRIDABLE) {
      const val = override[key];
      if (typeof val === 'string' && val.trim()) out[key] = val.trim();
    }
  }
  return out;
}

module.exports = { DEFAULT_BANK_ACCOUNT, OVERRIDABLE, resolveBankAccount };

// helpers/oxpayHelper.js
const crypto = require('crypto');

/**
 * Generate a random nonce string.
 */
const generateNonce = () => {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
};

/**
 * Build the OXPay MD5 signature.
 *
 * Rules (from docs §4):
 *  - Exclude the `sign` field
 *  - Exclude null / undefined / empty-string values
 *  - Sort remaining keys by ASCII order
 *  - Join as key=value&key=value…&secret=<secretKey>
 *  - MD5 the UTF-8 string, upper-case the hex result
 *
 * @param {Object} params     All request parameters (without `sign`)
 * @param {string} secretKey  Merchant secret key
 * @returns {string}
 */
const generateSign = (params, secretKey) => {
    const filtered = Object.entries(params)
        .filter(([k, v]) => k !== 'sign' && v !== null && v !== undefined && v !== '');

    filtered.sort(([a], [b]) => a.localeCompare(b));

    const queryString = filtered.map(([k, v]) => `${k}=${v}`).join('&');
    const raw = `${queryString}&secret=${secretKey}`;

    console.log('🔏 OXPay sign raw string:', raw);

    return crypto.createHash('md5').update(raw, 'utf8').digest('hex').toUpperCase();
};

/**
 * Verify a signature received from OXPay (webhooks / query responses).
 *
 * @param {Object} params        Fields to verify (must NOT include `sign`)
 * @param {string} receivedSign
 * @param {string} secretKey
 * @returns {boolean}
 */
const verifySign = (params, receivedSign, secretKey) => {
    const expected = generateSign(params, secretKey);
    const valid = expected === receivedSign?.toUpperCase();
    if (!valid) {
        console.warn('⚠️  OXPay signature mismatch');
        console.warn('   Expected :', expected);
        console.warn('   Received :', receivedSign?.toUpperCase());
    }
    return valid;
};

module.exports = { generateNonce, generateSign, verifySign };
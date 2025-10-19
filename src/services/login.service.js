const bcrypt = require('bcrypt');
const { Account } = require('../models');

/**
 * Find an account using email or phone number
 */
async function findAccountByIdentifier(identifier) {
    console.log(`\n[DEBUG] Searching for account with identifier: ${identifier}`);

    // Check if identifier is email or phone
    const where = identifier.includes('@') ? { email: identifier } : { phone_e164: identifier };
    console.log(`[DEBUG] Account search criteria:`, where);

    try {
        const account = await Account.findOne({ where });

        if (account) {
            console.log(`[DEBUG] Account found:`, account.dataValues);
        } else {
            console.warn(`[WARNING] No account found for identifier: ${identifier}`);
        }

        return account;
    } catch (error) {
        console.error(`[ERROR] Failed to fetch account for identifier: ${identifier}`);
        console.error(`[ERROR DETAILS]`, error);
        throw error;
    }
}

/**
 * Compare a plain password with a hashed password
 */
async function verifyPassword(plain, hash) {
    console.log(`\n[DEBUG] Verifying password...`);
    console.log(`[DEBUG] Plain password: ${plain}`);
    console.log(`[DEBUG] Stored hash: ${hash}`);

    try {
        const match = await bcrypt.compare(plain, hash);
        console.log(`[DEBUG] Password verification result: ${match}`);
        return match;
    } catch (error) {
        console.error(`[ERROR] Password verification failed`);
        console.error(`[ERROR DETAILS]`, error);
        throw error;
    }
}

module.exports = { findAccountByIdentifier, verifyPassword };

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Drop the stale account_uuid → accounts foreign key(s) on verification_codes.
//
// During signup an OTP is issued against a pending_signups UUID — the real
// account only exists AFTER the OTP is verified. The VerificationCode model
// intentionally has NO reference to accounts, but old sequelize.sync({alter})
// runs created (and duplicated 20+ times) an account_uuid FK, which rejected
// every signup OTP insert with ER_NO_REFERENCED_ROW_2.
//
// This drops ALL such constraints. Idempotent — safe to run repeatedly.
// Run with scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    async up(queryInterface) {
        const sequelize = queryInterface.sequelize;
        const [fks] = await sequelize.query(
            "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_codes' " +
            "AND REFERENCED_TABLE_NAME = 'accounts'"
        );
        let dropped = 0;
        for (const row of fks) {
            try {
                await sequelize.query(
                    `ALTER TABLE verification_codes DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``
                );
                dropped++;
            } catch (e) {
                console.warn(`  ⚠️  ${row.CONSTRAINT_NAME}: ${e.message}`);
            }
        }
        console.log(`  ✔ dropped ${dropped} stale verification_codes→accounts FK constraint(s)`);
    },

    async down() {
        // Intentionally NOT re-added — OTPs legitimately reference pending signups
        // that do not (yet) have an accounts row.
    },
};

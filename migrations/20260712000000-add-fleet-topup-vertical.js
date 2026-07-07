'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Add 'fleet_topup' to the wego_payments.vertical ENUM.
//
// Fleet owners now top up a driver's wallet through CamPay (real MoMo/OM
// collection from the partner's number). Each attempt creates a WegoPayment
// row with vertical='fleet_topup' and vertical_id = the pending
// DriverWalletTransaction.id. The driver's wallet is credited only when the
// collection is confirmed SUCCESSFUL. Idempotent.
// ═══════════════════════════════════════════════════════════════════════════

const ENUM_WITH = "ENUM('trip','delivery','service_request','rental','listing_fee','delivery_topup','fleet_topup')";
const ENUM_WITHOUT = "ENUM('trip','delivery','service_request','rental','listing_fee','delivery_topup')";

module.exports = {
    async up(queryInterface) {
        const q = queryInterface.sequelize;

        // Only alter if the value isn't already present (safe to re-run).
        const [[col]] = await q.query(
            "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wego_payments' AND COLUMN_NAME = 'vertical'"
        );

        if (col && String(col.t).includes('fleet_topup')) {
            console.log("  ✔ wego_payments.vertical already includes 'fleet_topup' — nothing to do");
            return;
        }

        await q.query(
            `ALTER TABLE wego_payments MODIFY COLUMN vertical ${ENUM_WITH} NULL ` +
            `COMMENT 'Which WeGo vertical triggered this payment. NULL for disbursements.'`
        );
        console.log("  ✔ added 'fleet_topup' to wego_payments.vertical");
    },

    async down(queryInterface) {
        const q = queryInterface.sequelize;
        // Revert only if no rows use the new value (avoids data loss).
        const [[row]] = await q.query(
            "SELECT COUNT(*) AS n FROM wego_payments WHERE vertical = 'fleet_topup'"
        );
        if (row && Number(row.n) > 0) {
            console.warn(`  ⚠️  ${row.n} fleet_topup payment(s) exist — leaving ENUM as-is`);
            return;
        }
        await q.query(`ALTER TABLE wego_payments MODIFY COLUMN vertical ${ENUM_WITHOUT} NULL`);
        console.log("  ✔ removed 'fleet_topup' from wego_payments.vertical");
    },
};

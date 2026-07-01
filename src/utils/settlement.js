'use strict';

// ═══════════════════════════════════════════════════════════════════════
// PURE SETTLEMENT MATH — money-critical, dependency-free, unit-tested.
// ───────────────────────────────────────────────────────────────────────
// WeGo ride-hailing money model:
//   The passenger ALWAYS pays the driver directly (cash, MTN MoMo or Orange
//   Money are all peer-to-peer transfers that never touch WeGo). WeGo's only
//   cut is its commission, collected from the driver's prepaid wallet.
//
//   directToDriver = true  (every ride): the fare is NOT credited to the
//                    wallet; we only DEBIT the commission and CREDIT bonuses.
//                      wallet delta = bonuses − commission   (can be negative)
//   directToDriver = false (reserved for any future "platform-collected" flow):
//                    we credit the net fare.
//                      wallet delta = fare − commission + bonuses
//
// All amounts are integer XAF.
// ═══════════════════════════════════════════════════════════════════════
function computeSettlement({ grossFare, commissionAmount, bonusTotal = 0, directToDriver = true }) {
    const fareCredit = directToDriver ? 0 : Math.max(0, Math.round(grossFare));
    const commission = Math.max(0, Math.round(commissionAmount));
    const bonus      = Math.max(0, Math.round(bonusTotal));
    const driverNet  = fareCredit - commission + bonus;
    return { fareCredit, commission, bonus, driverNet };
}

module.exports = { computeSettlement };

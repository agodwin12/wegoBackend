// src/services/earningsEngineService.js
//
// ═══════════════════════════════════════════════════════════════════════
// EARNINGS ENGINE SERVICE
// ═══════════════════════════════════════════════════════════════════════
//
// The single entry point for all driver earnings logic.
// Called once per completed trip — automatically handles:
//
//   1. Idempotency check      → abort if already processed
//   2. Wallet provisioning    → create wallet if driver has none yet
//   3. Rule evaluation        → commission + per-trip bonuses
//   4. Receipt creation       → idempotency anchor (UNIQUE tripId)
//   5. Wallet ledger entries  → TRIP_FARE, COMMISSION, BONUS_TRIP rows
//   6. Quest evaluation       → check daily/weekly targets
//   7. Quest bonus posting    → BONUS_QUEST rows if threshold crossed
//   8. Wallet balance update  → atomic increment via Sequelize literal
//
// Everything runs inside ONE database transaction passed in from
// driver.controller.js completeTrip. If anything fails, the whole
// transaction rolls back — trip stays COMPLETED but no partial earnings
// are posted. Next retry will start fresh.
//
// HOW TO CALL:
//   const t = await sequelize.transaction();
//   try {
//     trip.status = 'COMPLETED';
//     await trip.save({ transaction: t });
//     await EarningsEngineService.processTrip(trip, t);
//     await t.commit();
//   } catch (err) {
//     await t.rollback();
//     throw err;
//   }
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 }   = require('uuid');
const { Op, literal }  = require('sequelize');
const { redisClient }  = require('../config/redis');

const {
    sequelize,
    Trip,
    Account,
    TripReceipt,
    DriverWallet,
    DriverWalletTransaction,
    EarningRule,
    BonusProgram,
    BonusAward,
} = require('../models');

// ── Redis cache key for earning rules ─────────────────────────────────
// Rules are loaded from DB and cached for 5 minutes.
// Admin changing a rule takes effect within 5 minutes — no restart needed.
const RULES_CACHE_KEY    = 'earnings:rules:active';
const RULES_CACHE_TTL_S  = 300; // 5 minutes

// ── Redis cache key for bonus programs ────────────────────────────────
const PROGRAMS_CACHE_KEY   = 'earnings:programs:active';
const PROGRAMS_CACHE_TTL_S = 300;

class EarningsEngineService {

    // ═══════════════════════════════════════════════════════════════════
    // PUBLIC: PROCESS TRIP
    // Main entry point — call this from completeTrip
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Process earnings for a completed trip.
     *
     * @param {object} trip       - Sequelize Trip instance (already COMPLETED)
     * @param {object} transaction - Active Sequelize transaction
     * @returns {object} result   - { receipt, walletEntries, questAwards }
     */
    async processTrip(trip, transaction) {
        console.log('\n════════════════════════════════════════════');
        console.log('💰 [EARNINGS ENGINE] processTrip started');
        console.log(`   Trip ID  : ${trip.id}`);
        console.log(`   Driver   : ${trip.driverId}`);
        console.log(`   Fare     : ${trip.fareFinal || trip.fareEstimate} XAF`);
        console.log('════════════════════════════════════════════\n');

        // ── STEP 1: Idempotency check ──────────────────────────────────
        // If receipt already exists, this trip was already processed.
        // Return the existing receipt silently — no error, no duplicate.
        const existingReceipt = await TripReceipt.findOne({
            where:       { tripId: trip.id },
            transaction,
        });

        if (existingReceipt) {
            console.log(`⚠️  [EARNINGS ENGINE] Trip ${trip.id} already processed — skipping`);
            console.log(`   Receipt ID : ${existingReceipt.id}`);
            console.log(`   Status     : ${existingReceipt.status}\n`);
            return {
                alreadyProcessed: true,
                receipt:          existingReceipt,
                walletEntries:    [],
                questAwards:      [],
            };
        }

        // ── STEP 2: Resolve gross fare ─────────────────────────────────
        // Use fareFinal if available, fall back to fareEstimate.
        // Both are stored as integers (XAF has no decimal).
        const grossFare = Math.round(trip.fareFinal || trip.fareEstimate || 0);

        if (grossFare <= 0) {
            console.warn(`⚠️  [EARNINGS ENGINE] Trip ${trip.id} has zero fare — skipping engine`);
            return { alreadyProcessed: false, receipt: null, walletEntries: [], questAwards: [] };
        }

        // ── STEP 3: Ensure driver has a wallet ────────────────────────
        const wallet = await this._ensureWallet(trip.driverId, transaction);

        // ── STEP 4: Load and evaluate earning rules ────────────────────
        const rules = await this._loadActiveRules();

        // Build trip context for rule matching
        const tripTime      = trip.tripCompletedAt || trip.tripStartedAt || new Date();
        const tripContext   = {
            tripHour:      tripTime.getUTCHours(),
            tripDayOfWeek: tripTime.getUTCDay(),
            city:          this._extractCity(trip.pickupAddress),
            fare:          grossFare,
            distanceM:     trip.distanceM || 0,
            paymentMethod: trip.paymentMethod || 'CASH',
            driverTier:    'STANDARD', // future: load from DriverProfile
            pickupZone:    null,       // future: geofence detection
        };

        console.log('🔍 [EARNINGS ENGINE] Trip context:');
        console.log(`   Hour: ${tripContext.tripHour} | Day: ${tripContext.tripDayOfWeek} | City: ${tripContext.city}`);
        console.log(`   Fare: ${grossFare} XAF | Payment: ${tripContext.paymentMethod}\n`);

        // Evaluate all rules
        const { commissionRule, commissionRate, commissionAmount, bonusRules } =
            this._evaluateRules(rules, tripContext, grossFare);

        // ── STEP 5: Calculate final amounts ───────────────────────────
        const bonusTotal = bonusRules.reduce((sum, b) => sum + b.bonusAmount, 0);
        const driverNet  = grossFare - commissionAmount + bonusTotal;

        console.log('📊 [EARNINGS ENGINE] Calculation:');
        console.log(`   Gross fare       : +${grossFare} XAF`);
        console.log(`   Commission (${(commissionRate * 100).toFixed(0)}%) : -${commissionAmount} XAF`);
        console.log(`   Bonuses          : +${bonusTotal} XAF (${bonusRules.length} rules)`);
        console.log(`   Driver net       : ${driverNet} XAF\n`);

        // ── STEP 6: Create receipt (idempotency anchor) ────────────────
        // If two requests arrive simultaneously, only ONE can insert
        // because tripId has a UNIQUE constraint. The second will throw
        // a SequelizeUniqueConstraintError which we catch above.
        const appliedRulesSnapshot = [
            commissionRule ? {
                ruleId:  commissionRule.id,
                type:    commissionRule.type,
                name:    commissionRule.name,
                value:   commissionRule.value,
                applied: true,
            } : null,
            ...bonusRules.map(b => ({
                ruleId:  b.rule.id,
                type:    b.rule.type,
                name:    b.rule.name,
                value:   b.rule.value,
                applied: true,
                bonusXaf: b.bonusAmount,
            })),
        ].filter(Boolean);

        const receipt = await TripReceipt.create({
            id:               uuidv4(),
            tripId:           trip.id,
            driverId:         trip.driverId,
            passengerId:      trip.passengerId,
            grossFare,
            commissionRate,
            commissionAmount,
            bonusTotal,
            driverNet,
            paymentMethod:    trip.paymentMethod || 'CASH',
            commissionRuleId: commissionRule?.id || null,
            appliedRules:     appliedRulesSnapshot,
            status:           'PENDING',
        }, { transaction });

        console.log(`✅ [EARNINGS ENGINE] Receipt created: ${receipt.id}\n`);

        // ── STEP 7: Write wallet ledger entries ────────────────────────
        const walletEntries = [];
        let   runningBalance = wallet.balance;

        // 7a. TRIP_FARE — gross fare credit
        runningBalance += grossFare;
        const fareEntry = await this._writeWalletEntry({
            driverId:     trip.driverId,
            walletId:     wallet.id,
            tripId:       trip.id,
            receiptId:    receipt.id,
            ruleId:       null,
            type:         'TRIP_FARE',
            amount:       grossFare,
            balanceAfter: runningBalance,
            reference:    `TRIP_FARE:${trip.id}`,
            description:  `Trip fare — ${trip.pickupAddress || 'pickup'} → ${trip.dropoffAddress || 'dropoff'}`,
            metadata: {
                grossFare,
                pickup:  trip.pickupAddress,
                dropoff: trip.dropoffAddress,
                distanceM: trip.distanceM,
            },
        }, transaction);
        walletEntries.push(fareEntry);

        // 7b. COMMISSION — deduction
        runningBalance -= commissionAmount;
        const commissionEntry = await this._writeWalletEntry({
            driverId:     trip.driverId,
            walletId:     wallet.id,
            tripId:       trip.id,
            receiptId:    receipt.id,
            ruleId:       commissionRule?.id || null,
            type:         'COMMISSION',
            amount:       -commissionAmount,
            balanceAfter: runningBalance,
            reference:    `COMMISSION:${trip.id}`,
            description:  `WEGO commission (${(commissionRate * 100).toFixed(0)}%) — Trip ${trip.id.substring(0, 8)}`,
            metadata: {
                rate:      commissionRate,
                ruleId:    commissionRule?.id,
                ruleName:  commissionRule?.name,
            },
        }, transaction);
        walletEntries.push(commissionEntry);

        // 7c. BONUS_TRIP — one entry per matching bonus rule
        for (const bonus of bonusRules) {
            runningBalance += bonus.bonusAmount;
            const bonusEntry = await this._writeWalletEntry({
                driverId:     trip.driverId,
                walletId:     wallet.id,
                tripId:       trip.id,
                receiptId:    receipt.id,
                ruleId:       bonus.rule.id,
                type:         'BONUS_TRIP',
                amount:       bonus.bonusAmount,
                balanceAfter: runningBalance,
                reference:    `BONUS_TRIP:${bonus.rule.id}:${trip.id}`,
                description:  `${bonus.rule.name} — Trip ${trip.id.substring(0, 8)}`,
                metadata: {
                    ruleName:  bonus.rule.name,
                    ruleType:  bonus.rule.type,
                    ruleValue: bonus.rule.value,
                },
            }, transaction);
            walletEntries.push(bonusEntry);
        }

        console.log(`✅ [EARNINGS ENGINE] ${walletEntries.length} wallet entries written\n`);

        // ── STEP 8: Update wallet balance + lifetime stats ─────────────
        await DriverWallet.update(
            {
                balance:         literal(`balance + ${driverNet}`),
                totalEarned:     literal(`totalEarned + ${grossFare + bonusTotal}`),
                totalCommission: literal(`totalCommission + ${commissionAmount}`),
                totalBonuses:    literal(`totalBonuses + ${bonusTotal}`),
            },
            {
                where:       { id: wallet.id },
                transaction,
            }
        );

        console.log(`✅ [EARNINGS ENGINE] Wallet balance updated (+${driverNet} XAF)\n`);

        // ── STEP 9: Mark receipt as SETTLED ───────────────────────────
        await TripReceipt.update(
            { status: 'SETTLED', processedAt: new Date() },
            { where: { id: receipt.id }, transaction }
        );

        // ── STEP 10: Evaluate quest / milestone bonuses ────────────────
        const questAwards = await this._evaluateQuestBonuses(
            trip,
            wallet,
            runningBalance,
            transaction
        );

        console.log('\n════════════════════════════════════════════');
        console.log('✅ [EARNINGS ENGINE] processTrip complete');
        console.log(`   Wallet entries : ${walletEntries.length}`);
        console.log(`   Quest awards   : ${questAwards.length}`);
        console.log(`   Driver net     : ${driverNet} XAF`);
        console.log('════════════════════════════════════════════\n');

        return {
            alreadyProcessed: false,
            receipt,
            walletEntries,
            questAwards,
            summary: {
                grossFare,
                commissionAmount,
                bonusTotal,
                driverNet,
                questBonusTotal: questAwards.reduce((s, a) => s + a.awardedAmount, 0),
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: ENSURE WALLET
    // Create wallet if driver doesn't have one yet
    // ═══════════════════════════════════════════════════════════════════

    async _ensureWallet(driverId, transaction) {
        // findOrCreate is atomic — safe against race conditions
        const [wallet, created] = await DriverWallet.findOrCreate({
            where:       { driverId },
            defaults: {
                id:       uuidv4(),
                driverId,
                balance:         0,
                totalEarned:     0,
                totalCommission: 0,
                totalBonuses:    0,
                totalPayouts:    0,
                status:          'ACTIVE',
                currency:        'XAF',
            },
            transaction,
        });

        if (created) {
            console.log(`🆕 [EARNINGS ENGINE] Wallet created for driver ${driverId}`);
        } else {
            console.log(`✅ [EARNINGS ENGINE] Wallet found — balance: ${wallet.balance} XAF`);
        }

        return wallet;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: LOAD ACTIVE RULES (with Redis cache)
    // ═══════════════════════════════════════════════════════════════════

    async _loadActiveRules() {
        try {
            // Try Redis cache first
            const cached = await redisClient.get(RULES_CACHE_KEY);
            if (cached) {
                const rules = JSON.parse(cached);
                console.log(`🧠 [EARNINGS ENGINE] Rules loaded from cache (${rules.length} rules)`);
                // Re-attach matchesContext method (lost in JSON serialization)
                return rules.map(r => this._attachRuleMethods(r));
            }
        } catch (e) {
            console.warn('⚠️  [EARNINGS ENGINE] Redis cache miss for rules — loading from DB');
        }

        // Load from DB
        const today = new Date().toISOString().split('T')[0];

        const rules = await EarningRule.findAll({
            where: {
                isActive: true,
                [Op.and]: [
                    { [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: today } }] },
                    { [Op.or]: [{ validTo:   null }, { validTo:   { [Op.gte]: today } }] },
                ],
            },
            order: [['priority', 'DESC']],
        });

        console.log(`✅ [EARNINGS ENGINE] ${rules.length} active rules loaded from DB`);

        // Cache the plain objects (methods are re-attached on read)
        try {
            await redisClient.setex(
                RULES_CACHE_KEY,
                RULES_CACHE_TTL_S,
                JSON.stringify(rules.map(r => r.toJSON()))
            );
        } catch (e) {
            console.warn('⚠️  [EARNINGS ENGINE] Failed to cache rules in Redis');
        }

        return rules;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: LOAD ACTIVE BONUS PROGRAMS (with Redis cache)
    // ═══════════════════════════════════════════════════════════════════

    async _loadActivePrograms() {
        try {
            const cached = await redisClient.get(PROGRAMS_CACHE_KEY);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (e) {
            console.warn('⚠️  [EARNINGS ENGINE] Redis cache miss for programs');
        }

        const today = new Date().toISOString().split('T')[0];

        const programs = await BonusProgram.findAll({
            where: {
                isActive: true,
                [Op.and]: [
                    { [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: today } }] },
                    { [Op.or]: [{ validTo:   null }, { validTo:   { [Op.gte]: today } }] },
                ],
            },
        });

        console.log(`✅ [EARNINGS ENGINE] ${programs.length} active bonus programs loaded from DB`);

        try {
            await redisClient.setex(
                PROGRAMS_CACHE_KEY,
                PROGRAMS_CACHE_TTL_S,
                JSON.stringify(programs.map(p => p.toJSON()))
            );
        } catch (e) {
            console.warn('⚠️  [EARNINGS ENGINE] Failed to cache programs in Redis');
        }

        return programs.map(p => p.toJSON ? p.toJSON() : p);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: EVALUATE RULES
    // Returns the commission rule + all matching bonus rules
    // ═══════════════════════════════════════════════════════════════════

    _evaluateRules(rules, tripContext, grossFare) {
        let   commissionRule   = null;
        let   commissionRate   = 0.10; // fallback if no rule found
        let   commissionAmount = 0;
        const bonusRules       = [];

        for (const rule of rules) {
            // Re-attach matchesContext if it was lost (loaded from cache)
            const ruleObj = this._attachRuleMethods(rule);

            if (!ruleObj.matchesContext(tripContext)) continue;

            if (ruleObj.type === 'COMMISSION_PERCENT') {
                // Rules are ordered by priority DESC, so first match = highest priority
                if (!commissionRule) {
                    commissionRule   = ruleObj;
                    commissionRate   = parseFloat(ruleObj.value);
                    commissionAmount = Math.round(grossFare * commissionRate);
                    console.log(`   ✅ Commission rule matched: "${ruleObj.name}" (${(commissionRate * 100).toFixed(1)}%)`);
                }

            } else if (ruleObj.type === 'BONUS_FLAT') {
                const bonusAmount = Math.round(parseFloat(ruleObj.value));
                bonusRules.push({ rule: ruleObj, bonusAmount });
                console.log(`   ✅ Bonus rule matched: "${ruleObj.name}" (+${bonusAmount} XAF)`);

            } else if (ruleObj.type === 'BONUS_MULTIPLIER') {
                // value is a fraction of gross fare: e.g. 0.05 = 5% of fare
                const bonusAmount = Math.round(grossFare * parseFloat(ruleObj.value));
                bonusRules.push({ rule: ruleObj, bonusAmount });
                console.log(`   ✅ Bonus multiplier matched: "${ruleObj.name}" (+${bonusAmount} XAF)`);

            } else if (ruleObj.type === 'PENALTY') {
                // Penalty is a flat deduction — treated as a negative bonus
                const penaltyAmount = -Math.round(parseFloat(ruleObj.value));
                bonusRules.push({ rule: ruleObj, bonusAmount: penaltyAmount });
                console.log(`   ⚠️  Penalty rule matched: "${ruleObj.name}" (${penaltyAmount} XAF)`);
            }
        }

        // If no commission rule matched, use the default fallback
        if (!commissionRule) {
            console.log(`   ⚠️  No commission rule matched — using fallback ${(commissionRate * 100)}%`);
            commissionAmount = Math.round(grossFare * commissionRate);
        }

        return { commissionRule, commissionRate, commissionAmount, bonusRules };
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: EVALUATE QUEST BONUSES
    // Check all active programs and award if driver crossed a threshold
    // ═══════════════════════════════════════════════════════════════════

    async _evaluateQuestBonuses(trip, wallet, currentBalance, transaction) {
        const programs   = await this._loadActivePrograms();
        const questAwards = [];

        if (programs.length === 0) {
            console.log('ℹ️  [EARNINGS ENGINE] No active bonus programs — skipping quest evaluation');
            return questAwards;
        }

        console.log(`\n🎯 [EARNINGS ENGINE] Evaluating ${programs.length} bonus programs...`);

        for (const program of programs) {
            try {
                const award = await this._evaluateSingleProgram(
                    program,
                    trip,
                    wallet,
                    currentBalance,
                    transaction
                );
                if (award) {
                    questAwards.push(award);
                    // Update running balance after quest bonus
                    currentBalance += award.awardedAmount;
                }
            } catch (err) {
                // A unique constraint error means the award was already given
                // (race condition or retry) — skip silently
                if (err.name === 'SequelizeUniqueConstraintError') {
                    console.log(`   ⚠️  Program "${program.name}" already awarded — skipping`);
                } else {
                    // Log but don't crash the whole engine for a quest bonus failure
                    console.error(`   ❌ Quest evaluation error for program "${program.name}":`, err.message);
                }
            }
        }

        return questAwards;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: EVALUATE A SINGLE BONUS PROGRAM
    // ═══════════════════════════════════════════════════════════════════

    async _evaluateSingleProgram(program, trip, wallet, currentBalance, transaction) {
        const periodKey = BonusProgram.getPeriodKey(program.period);

        // Check if driver already earned this program this period
        const existing = await BonusAward.findOne({
            where:       { driverId: trip.driverId, programId: program.id, periodKey },
            transaction,
        });

        if (existing) {
            return null; // Already awarded this period
        }

        // ── Count the metric ──────────────────────────────────────────
        const metric = await this._countProgramMetric(program, trip.driverId, transaction);

        console.log(`   Program: "${program.name}" | Target: ${program.targetValue} | Current: ${metric}`);

        if (metric < program.targetValue) {
            return null; // Target not yet reached
        }

        // ── Target reached — create award ──────────────────────────────
        console.log(`   🏆 Target reached! Awarding ${program.bonusAmount} XAF`);

        const awardId      = uuidv4();
        const newBalance   = currentBalance + program.bonusAmount;
        const reference    = `BONUS_QUEST:${program.id}:${periodKey}:${trip.driverId}`;

        // Create the BonusAward record (UNIQUE constraint is idempotency guard)
        const award = await BonusAward.create({
            id:               awardId,
            driverId:         trip.driverId,
            programId:        program.id,
            periodKey,
            awardedAmount:    program.bonusAmount,
            triggerTripId:    trip.id,
            metricAtAward:    metric,
            awardedAt:        new Date(),
            createdAt:        new Date(),
        }, { transaction });

        // Write wallet entry
        const walletEntry = await this._writeWalletEntry({
            driverId:       trip.driverId,
            walletId:       wallet.id,
            tripId:         trip.id,
            receiptId:      null,
            ruleId:         null,
            bonusProgramId: program.id,
            bonusAwardId:   award.id,
            type:           'BONUS_QUEST',
            amount:         program.bonusAmount,
            balanceAfter:   newBalance,
            reference,
            description:    `${program.iconEmoji || '🏆'} ${program.name} bonus — ${periodKey}`,
            metadata: {
                programName:  program.name,
                programType:  program.type,
                period:       program.period,
                periodKey,
                target:       program.targetValue,
                achieved:     metric,
            },
        }, transaction);

        // Update BonusAward with wallet transaction reference
        await BonusAward.update(
            { walletTransactionId: walletEntry.id },
            { where: { id: award.id }, transaction }
        );

        // Update wallet balance for the quest bonus
        await DriverWallet.update(
            {
                balance:      literal(`balance + ${program.bonusAmount}`),
                totalBonuses: literal(`totalBonuses + ${program.bonusAmount}`),
            },
            { where: { id: wallet.id }, transaction }
        );

        return { ...award.toJSON(), awardedAmount: program.bonusAmount };
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: COUNT METRIC FOR A PROGRAM
    // ═══════════════════════════════════════════════════════════════════

    async _countProgramMetric(program, driverId, transaction) {
        const now        = new Date();
        const periodStart = this._getPeriodStart(program.period, now);

        const baseWhere = {
            driverId,
            status:          'COMPLETED',
            tripCompletedAt: { [Op.gte]: periodStart },
        };

        if (program.type === 'DAILY_TRIPS' ||
            program.type === 'WEEKLY_TRIPS' ||
            program.type === 'MONTHLY_TRIPS') {
            return await Trip.count({ where: baseWhere, transaction });
        }

        if (program.type === 'LIFETIME_TRIPS') {
            return await Trip.count({
                where: { driverId, status: 'COMPLETED' },
                transaction,
            });
        }

        if (program.type === 'DAILY_EARNINGS'  ||
            program.type === 'WEEKLY_EARNINGS' ||
            program.type === 'MONTHLY_EARNINGS') {
            const result = await Trip.sum('fareFinal', { where: baseWhere, transaction });
            return Math.round(result || 0);
        }

        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: WRITE A SINGLE WALLET LEDGER ENTRY
    // ═══════════════════════════════════════════════════════════════════

    async _writeWalletEntry(data, transaction) {
        return await DriverWalletTransaction.create({
            id:             uuidv4(),
            driverId:       data.driverId,
            walletId:       data.walletId,
            tripId:         data.tripId       || null,
            receiptId:      data.receiptId    || null,
            ruleId:         data.ruleId       || null,
            bonusProgramId: data.bonusProgramId || null,
            bonusAwardId:   data.bonusAwardId || null,
            type:           data.type,
            amount:         data.amount,
            balanceAfter:   data.balanceAfter,
            description:    data.description,
            reference:      data.reference,
            metadata:       data.metadata     || null,
            adjustedBy:     data.adjustedBy   || null,
            adjustmentNote: data.adjustmentNote || null,
            payoutMethod:   data.payoutMethod || null,
            payoutRef:      data.payoutRef    || null,
            payoutStatus:   data.payoutStatus || null,
            createdAt:      new Date(),
        }, { transaction });
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: GET PERIOD START DATE
    // ═══════════════════════════════════════════════════════════════════

    _getPeriodStart(period, now = new Date()) {
        const d = new Date(now);

        if (period === 'DAILY') {
            d.setUTCHours(0, 0, 0, 0);
            return d;
        }

        if (period === 'WEEKLY') {
            // Rewind to Monday (ISO week)
            const day = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() - day + 1);
            d.setUTCHours(0, 0, 0, 0);
            return d;
        }

        if (period === 'MONTHLY') {
            d.setUTCDate(1);
            d.setUTCHours(0, 0, 0, 0);
            return d;
        }

        // LIFETIME — epoch
        return new Date(0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: ATTACH matchesContext METHOD TO A PLAIN RULE OBJECT
    // Needed because JSON.parse loses class methods
    // ═══════════════════════════════════════════════════════════════════

    _attachRuleMethods(rule) {
        if (typeof rule.matchesContext === 'function') return rule; // already a class instance

        // Attach the same logic as EarningRule.matchesContext
        rule.matchesContext = function(context) {
            const c = this.conditions;
            if (!c || Object.keys(c).length === 0) return true;

            if (c.city !== undefined && c.city !== context.city)              return false;

            if (c.hour_from !== undefined && c.hour_to !== undefined) {
                const h = context.tripHour;
                const inWindow = c.hour_from > c.hour_to
                    ? (h >= c.hour_from || h < c.hour_to)
                    : (h >= c.hour_from && h < c.hour_to);
                if (!inWindow) return false;
            }

            if (c.day_of_week !== undefined) {
                const allowed = Array.isArray(c.day_of_week) ? c.day_of_week : [c.day_of_week];
                if (!allowed.includes(context.tripDayOfWeek))                return false;
            }

            if (c.min_fare      !== undefined && context.fare      < c.min_fare)       return false;
            if (c.max_fare      !== undefined && context.fare      > c.max_fare)       return false;
            if (c.min_distance_m !== undefined && context.distanceM < c.min_distance_m) return false;
            if (c.payment_method !== undefined && c.payment_method !== context.paymentMethod) return false;
            if (c.driver_tier   !== undefined && c.driver_tier    !== context.driverTier)    return false;
            if (c.pickup_zone   !== undefined && c.pickup_zone    !== context.pickupZone)    return false;

            return true;
        };

        return rule;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PRIVATE: EXTRACT CITY FROM ADDRESS STRING
    // Simple heuristic — improve with geofencing later
    // ═══════════════════════════════════════════════════════════════════

    _extractCity(address) {
        if (!address) return null;
        const lower = address.toLowerCase();
        if (lower.includes('douala'))  return 'Douala';
        if (lower.includes('yaoundé') || lower.includes('yaounde')) return 'Yaoundé';
        if (lower.includes('bafoussam')) return 'Bafoussam';
        if (lower.includes('garoua'))  return 'Garoua';
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PUBLIC: INVALIDATE RULES CACHE
    // Call this from admin panel after updating a rule
    // ═══════════════════════════════════════════════════════════════════

    async invalidateRulesCache() {
        try {
            await redisClient.del(RULES_CACHE_KEY);
            await redisClient.del(PROGRAMS_CACHE_KEY);
            console.log('✅ [EARNINGS ENGINE] Rules + programs cache invalidated');
        } catch (e) {
            console.warn('⚠️  [EARNINGS ENGINE] Failed to invalidate cache:', e.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PUBLIC: GET DRIVER WALLET SUMMARY (for API)
    // ═══════════════════════════════════════════════════════════════════

    async getWalletSummary(driverId) {
        const wallet = await DriverWallet.findOne({ where: { driverId } });
        if (!wallet) return null;

        // Today's earnings from wallet transactions
        const today      = new Date(); today.setUTCHours(0, 0, 0, 0);
        const tomorrow   = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const weekStart  = this._getPeriodStart('WEEKLY');
        const monthStart = this._getPeriodStart('MONTHLY');

        const [todayNet, weekNet, monthNet, todayTrips, weekTrips] = await Promise.all([
            DriverWalletTransaction.sum('amount', {
                where: { driverId, type: { [Op.in]: ['TRIP_FARE', 'BONUS_TRIP', 'BONUS_QUEST'] }, createdAt: { [Op.between]: [today, tomorrow] } }
            }),
            DriverWalletTransaction.sum('amount', {
                where: { driverId, type: { [Op.in]: ['TRIP_FARE', 'BONUS_TRIP', 'BONUS_QUEST'] }, createdAt: { [Op.gte]: weekStart } }
            }),
            DriverWalletTransaction.sum('amount', {
                where: { driverId, type: { [Op.in]: ['TRIP_FARE', 'BONUS_TRIP', 'BONUS_QUEST'] }, createdAt: { [Op.gte]: monthStart } }
            }),
            Trip.count({ where: { driverId, status: 'COMPLETED', tripCompletedAt: { [Op.between]: [today, tomorrow] } } }),
            Trip.count({ where: { driverId, status: 'COMPLETED', tripCompletedAt: { [Op.gte]: weekStart } } }),
        ]);

        return {
            balance:         wallet.balance,
            totalEarned:     wallet.totalEarned,
            totalCommission: wallet.totalCommission,
            totalBonuses:    wallet.totalBonuses,
            totalPayouts:    wallet.totalPayouts,
            currency:        wallet.currency,
            status:          wallet.status,
            lastPayoutAt:    wallet.lastPayoutAt,
            today: {
                net:   Math.round(todayNet   || 0),
                trips: todayTrips,
            },
            week: {
                net:   Math.round(weekNet    || 0),
                trips: weekTrips,
            },
            month: {
                net:   Math.round(monthNet   || 0),
            },
        };
    }
}

module.exports = new EarningsEngineService();
// src/services/cleanup.service.js
const { Op } = require('sequelize');
const { PendingSignup, VerificationCode } = require('../models');
const { deleteFromR2 } = require('../utils/r2Upload');



async function cleanupExpiredPendingSignups() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🧹 [CLEANUP] Starting expired pending signups cleanup...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`⏰ Current time: ${new Date().toISOString()}`);

    const now = new Date();

    try {
        // ─────────────────────────────────────────────────────────────
        // STEP 1: Find all expired pending signups
        // ─────────────────────────────────────────────────────────────
        console.log('🔍 [CLEANUP] Finding expired pending signups...');

        const expiredSignups = await PendingSignup.findAll({
            where: {
                expires_at: {
                    [Op.lt]: now, // Expired before now
                },
            },
        });

        if (expiredSignups.length === 0) {
            console.log('✅ [CLEANUP] No expired pending signups found');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            return {
                success: true,
                deleted: 0,
                filesDeleted: 0,
                message: 'No expired signups to clean up',
            };
        }

        console.log(`⚠️  [CLEANUP] Found ${expiredSignups.length} expired pending signup(s)`);

        // ─────────────────────────────────────────────────────────────
        // STEP 2: Delete files from R2 for each expired signup
        // ─────────────────────────────────────────────────────────────
        let filesDeleted = 0;

        for (const signup of expiredSignups) {
            console.log(`\n📋 [CLEANUP] Processing signup: ${signup.uuid}`);
            console.log(`   User Type: ${signup.user_type}`);
            console.log(`   Email: ${signup.email || 'N/A'}`);
            console.log(`   Phone: ${signup.phone_e164 || 'N/A'}`);
            console.log(`   Expired at: ${signup.expires_at.toISOString()}`);

            // Collect all file URLs to delete
            const filesToDelete = [];

            if (signup.avatar_url) {
                filesToDelete.push({ url: signup.avatar_url, type: 'Avatar' });
            }

            if (signup.license_document_url) {
                filesToDelete.push({ url: signup.license_document_url, type: 'License' });
            }

            if (signup.insurance_document_url) {
                filesToDelete.push({ url: signup.insurance_document_url, type: 'Insurance' });
            }

            if (signup.vehicle_photo_url) {
                filesToDelete.push({ url: signup.vehicle_photo_url, type: 'Vehicle Photo' });
            }

            // Delete files from R2
            if (filesToDelete.length > 0) {
                console.log(`🗑️  [CLEANUP] Deleting ${filesToDelete.length} file(s) from R2...`);

                for (const file of filesToDelete) {
                    try {
                        await deleteFromR2(file.url);
                        console.log(`   ✅ Deleted ${file.type}: ${file.url}`);
                        filesDeleted++;
                    } catch (err) {
                        console.warn(`   ⚠️  Failed to delete ${file.type}: ${err.message}`);
                        // Continue even if file deletion fails
                    }
                }
            } else {
                console.log('   ℹ️  No files to delete for this signup');
            }
        }

        // ─────────────────────────────────────────────────────────────
        // STEP 3: Delete pending signup records
        // ─────────────────────────────────────────────────────────────
        console.log('\n💾 [CLEANUP] Deleting pending signup records from database...');

        const deletedCount = await PendingSignup.destroy({
            where: {
                expires_at: {
                    [Op.lt]: now,
                },
            },
        });

        console.log(`✅ [CLEANUP] Deleted ${deletedCount} pending signup record(s)`);

        // ─────────────────────────────────────────────────────────────
        // STEP 4: Clean up orphaned OTP codes (optional)
        // ─────────────────────────────────────────────────────────────
        console.log('\n🔐 [CLEANUP] Cleaning up expired OTP codes...');

        const deletedOtpCount = await VerificationCode.destroy({
            where: {
                expires_at: {
                    [Op.lt]: now,
                },
            },
        });

        console.log(`✅ [CLEANUP] Deleted ${deletedOtpCount} expired OTP code(s)`);

        // ─────────────────────────────────────────────────────────────
        // SUMMARY
        // ─────────────────────────────────────────────────────────────
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [CLEANUP] Cleanup completed successfully!');
        console.log(`📊 Summary:`);
        console.log(`   - Pending signups deleted: ${deletedCount}`);
        console.log(`   - Files deleted from R2: ${filesDeleted}`);
        console.log(`   - OTP codes deleted: ${deletedOtpCount}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            success: true,
            deleted: deletedCount,
            filesDeleted,
            otpCodesDeleted: deletedOtpCount,
            message: `Cleaned up ${deletedCount} expired signup(s) and ${filesDeleted} file(s)`,
        };
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [CLEANUP] Error during cleanup:', err.message);
        console.error('❌ [STACK]:', err.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            success: false,
            error: err.message,
            message: 'Cleanup failed',
        };
    }
}

/**
 * ═══════════════════════════════════════════════════════════════
 * CLEANUP SPECIFIC PENDING SIGNUP BY UUID
 * ═══════════════════════════════════════════════════════════════
 * Used when a signup fails or needs to be manually removed
 */
async function cleanupPendingSignupByUuid(uuid) {
    console.log(`\n🧹 [CLEANUP] Cleaning up pending signup: ${uuid}`);

    try {
        const signup = await PendingSignup.findOne({ where: { uuid } });

        if (!signup) {
            console.log('❌ [CLEANUP] Pending signup not found');
            return { success: false, message: 'Pending signup not found' };
        }

        // Delete files from R2
        const filesToDelete = [
            signup.avatar_url,
            signup.license_document_url,
            signup.insurance_document_url,
            signup.vehicle_photo_url,
        ].filter(Boolean);

        let filesDeleted = 0;
        for (const url of filesToDelete) {
            try {
                await deleteFromR2(url);
                filesDeleted++;
                console.log(`✅ [CLEANUP] Deleted file: ${url}`);
            } catch (err) {
                console.warn(`⚠️  [CLEANUP] Failed to delete file: ${err.message}`);
            }
        }

        // Delete pending signup record
        await PendingSignup.destroy({ where: { uuid } });

        // Delete associated OTP codes
        await VerificationCode.destroy({
            where: { account_uuid: uuid },
        });

        console.log('✅ [CLEANUP] Pending signup cleaned up successfully\n');

        return {
            success: true,
            filesDeleted,
            message: `Pending signup ${uuid} cleaned up`,
        };
    } catch (err) {
        console.error('❌ [CLEANUP] Error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * ═══════════════════════════════════════════════════════════════
 * GET CLEANUP STATS
 * ═══════════════════════════════════════════════════════════════
 * Returns statistics about pending signups
 */
async function getCleanupStats() {
    try {
        const now = new Date();

        const [
            totalPending,
            expiredPending,
            expiredOtps,
        ] = await Promise.all([
            PendingSignup.count(),
            PendingSignup.count({
                where: {
                    expires_at: { [Op.lt]: now },
                },
            }),
            VerificationCode.count({
                where: {
                    expires_at: { [Op.lt]: now },
                },
            }),
        ]);

        return {
            success: true,
            stats: {
                totalPendingSignups: totalPending,
                expiredPendingSignups: expiredPending,
                expiredOtpCodes: expiredOtps,
                needsCleanup: expiredPending > 0 || expiredOtps > 0,
            },
        };
    } catch (err) {
        console.error('❌ [CLEANUP STATS] Error:', err.message);
        return {
            success: false,
            error: err.message,
        };
    }
}

module.exports = {
    cleanupExpiredPendingSignups,
    cleanupPendingSignupByUuid,
    getCleanupStats,
};
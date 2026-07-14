// backend/src/controllers/backoffice/topupTrace.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// Platform-wide PAYMENT / TOP-UP TRACE (backoffice)
//
// A single audit trail of every money-in event on the platform, normalized
// into one list:
//   • wallet top-ups — ride drivers (DriverWalletTransaction type=TOP_UP)
//                      and delivery agents (DeliveryWalletTopUp)
//   • purchases      — services listing/ad plans (WegoPayment listing_fee)
//                      and car rentals           (WegoPayment rental)
//
// For each top-up we surface: who did it, their role, the amount, the method,
// the number that was charged, the CamPay reference, the operator, the status
// and the date. The charged number + operator come from the WegoPayment ledger
// (the CamPay record), joined by campay_ref, because that is where the real
// charged MoMo/OM number lives.
//
// GET /api/services/admin/topups
//   ?source=driver|delivery  ?status=success|pending|failed
//   ?search=<name|phone|reference>  ?page  ?limit
// ─────────────────────────────────────────────────────────────────────────────

const { Op } = require('sequelize');
const {
    DriverWalletTransaction,
    DeliveryWalletTopUp,
    WegoPayment,
    Account,
    Driver,
} = require('../../models');

// Normalize the many raw statuses into 3 buckets for filtering + display.
function driverStatusGroup(s) {
    const v = String(s || '').toUpperCase();
    if (v === 'COMPLETED') return 'success';
    if (v === 'FAILED' || v === 'EXPIRED') return 'failed';
    return 'pending';
}
function deliveryStatusGroup(s) {
    const v = String(s || '').toLowerCase();
    if (v === 'credited') return 'success';
    if (v === 'rejected' || v === 'campay_failed') return 'failed';
    return 'pending';
}
function wegoStatusGroup(s) {
    const v = String(s || '').toUpperCase();
    if (v === 'SUCCESSFUL') return 'success';
    if (v === 'FAILED' || v === 'EXPIRED') return 'failed';
    return 'pending';
}
// CamPay ledger verticals we surface here as "purchases" (not wallet top-ups).
const PURCHASE_VERTICALS = {
    listing_fee: { source: 'services', label: 'Services purchase' },
    rental:      { source: 'rental',   label: 'Car rental' },
};

function fullName(a) {
    if (!a) return 'Unknown';
    return `${a.first_name || ''} ${a.last_name || ''}`.trim() || a.email || 'Unknown';
}

// Who triggered a driver top-up: self, or the fleet owner (fleet/partner path).
function driverInitiator(reference) {
    const r = String(reference || '');
    if (r.startsWith('TOP_UP:FLEET') || r.startsWith('TOP_UP:PARTNER')) return 'Fleet owner';
    return 'Self';
}

exports.getAllTopups = async (req, res) => {
    try {
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(100, parseInt(req.query.limit) || 25);
        const source = req.query.source;                     // 'driver' | 'delivery'
        const status = req.query.status;                     // 'success'|'pending'|'failed'
        const search = (req.query.search || '').toLowerCase().trim();

        // Cap the raw pull per source; the merged view is admin-facing and
        // filtered/paginated in memory. (Volumes are small; revisit with a
        // UNION view if top-ups ever reach the millions.)
        const RAW_CAP = 5000;

        const wantDriver   = !source || source === 'driver';
        const wantDelivery = !source || source === 'delivery';
        const wantServices = !source || source === 'services';
        const wantRental   = !source || source === 'rental';

        // ── 1. Ride-hailing driver top-ups ──────────────────────────────────
        const driverRows = !wantDriver ? [] : await DriverWalletTransaction.findAll({
            where:      { type: 'TOP_UP' },
            attributes: ['id', 'driverId', 'amount', 'topUpMethod', 'topUpStatus', 'topUpRef', 'metadata', 'reference', 'createdAt'],
            order:      [['createdAt', 'DESC']],
            limit:      RAW_CAP,
            raw:        true,
        });

        // ── 2. Delivery-agent top-ups ───────────────────────────────────────
        const delRows = !wantDelivery ? [] : await DeliveryWalletTopUp.findAll({
            attributes: ['id', 'driver_id', 'amount', 'payment_channel', 'status', 'campay_ref', 'topup_code', 'sender_phone', 'created_at'],
            order:      [['created_at', 'DESC']],
            limit:      RAW_CAP,
            raw:        true,
        });

        // ── 3. Services purchases + car rentals (from the CamPay ledger) ─────
        const wpVerticals = [];
        if (wantServices) wpVerticals.push('listing_fee');
        if (wantRental)   wpVerticals.push('rental');
        const wpRows = wpVerticals.length ? await WegoPayment.findAll({
            where:      { vertical: { [Op.in]: wpVerticals } },
            attributes: ['id', 'vertical', 'amount', 'phone', 'operator', 'campay_ref', 'status', 'initiated_by', 'createdAt'],
            order:      [['createdAt', 'DESC']],
            limit:      RAW_CAP,
            raw:        true,
        }) : [];

        // ── Resolve "who": ride drivers are Accounts (driverId = Account.uuid);
        //    delivery agents are Drivers whose userId → Account. ────────────
        const delDriverIds = [...new Set(delRows.map(r => r.driver_id).filter(Boolean))];
        const delDrivers   = delDriverIds.length
            ? await Driver.findAll({ where: { id: { [Op.in]: delDriverIds } }, attributes: ['id', 'userId'], raw: true })
            : [];
        const delDriverById = new Map(delDrivers.map(d => [d.id, d]));

        const acctIds = [...new Set([
            ...driverRows.map(r => r.driverId),
            ...delDrivers.map(d => d.userId),
            ...wpRows.map(r => r.initiated_by),
        ].filter(Boolean))];
        const accts = acctIds.length
            ? await Account.findAll({ where: { uuid: { [Op.in]: acctIds } }, attributes: ['uuid', 'first_name', 'last_name', 'email', 'user_type'], raw: true })
            : [];
        const acctByUuid = new Map(accts.map(a => [a.uuid, a]));

        // ── Charged number + operator from the CamPay ledger (by campay_ref) ─
        const refs = [...new Set([
            ...driverRows.map(r => r.topUpRef),
            ...delRows.map(r => r.campay_ref),
        ].filter(Boolean))];
        const payments = refs.length
            ? await WegoPayment.findAll({ where: { campay_ref: { [Op.in]: refs } }, attributes: ['campay_ref', 'phone', 'operator'], raw: true })
            : [];
        const payByRef = new Map(payments.map(p => [p.campay_ref, p]));

        // ── Normalize both sources into one shape ───────────────────────────
        const rows = [];

        for (const r of driverRows) {
            const a   = acctByUuid.get(r.driverId);
            const pay = r.topUpRef ? payByRef.get(r.topUpRef) : null;
            rows.push({
                id:           `D-${r.id}`,
                source:       'driver',
                source_label: 'Ride driver',
                who_name:     fullName(a),
                who_email:    a?.email || null,
                who_role:     a?.user_type || 'DRIVER',
                initiated_by: driverInitiator(r.reference),
                amount:       parseInt(r.amount, 10),
                method:       r.topUpMethod || null,
                phone:        (r.metadata && r.metadata.phone) || pay?.phone || null,
                operator:     pay?.operator || null,
                reference:    r.topUpRef || null,
                code:         null,
                status:       r.topUpStatus || 'COMPLETED',
                status_group: driverStatusGroup(r.topUpStatus),
                created_at:   r.createdAt,
            });
        }

        for (const r of delRows) {
            const drv = delDriverById.get(r.driver_id);
            const a   = drv ? acctByUuid.get(drv.userId) : null;
            const pay = r.campay_ref ? payByRef.get(r.campay_ref) : null;
            rows.push({
                id:           `A-${r.id}`,
                source:       'delivery',
                source_label: 'Delivery agent',
                who_name:     fullName(a),
                who_email:    a?.email || null,
                who_role:     'DELIVERY_AGENT',
                initiated_by: 'Self',
                amount:       parseInt(r.amount, 10),
                method:       r.payment_channel || null,
                phone:        pay?.phone || r.sender_phone || null,
                operator:     pay?.operator || null,
                reference:    r.campay_ref || null,
                code:         r.topup_code || null,
                status:       r.status || 'pending',
                status_group: deliveryStatusGroup(r.status),
                created_at:   r.created_at,
            });
        }

        for (const r of wpRows) {
            const meta = PURCHASE_VERTICALS[r.vertical] || { source: 'other', label: r.vertical };
            const a    = acctByUuid.get(r.initiated_by);
            rows.push({
                id:           `P-${r.id}`,
                source:       meta.source,
                source_label: meta.label,
                who_name:     fullName(a),
                who_email:    a?.email || null,
                who_role:     a?.user_type || '—',
                initiated_by: 'Self',
                amount:       parseInt(r.amount, 10),
                method:       r.operator === 'MTN' ? 'MTN_MOMO' : r.operator === 'ORANGE' ? 'ORANGE_MONEY' : 'Mobile Money',
                phone:        r.phone || null,
                operator:     r.operator || null,
                reference:    r.campay_ref || null,
                code:         null,
                status:       r.status || 'PENDING',
                status_group: wegoStatusGroup(r.status),
                created_at:   r.createdAt,
            });
        }

        // ── Summary over the FULL (unfiltered) set ──────────────────────────
        const summary = {
            total_topups:   rows.length,   // total transactions in view
            driver_count:   rows.filter(t => t.source === 'driver').length,
            delivery_count: rows.filter(t => t.source === 'delivery').length,
            services_count: rows.filter(t => t.source === 'services').length,
            rental_count:   rows.filter(t => t.source === 'rental').length,
            total_credited: rows.filter(t => t.status_group === 'success').reduce((s, t) => s + (t.amount || 0), 0),
        };

        // ── Filter ──────────────────────────────────────────────────────────
        let filtered = rows;
        if (status)  filtered = filtered.filter(t => t.status_group === status);
        if (search)  filtered = filtered.filter(t =>
            (t.who_name || '').toLowerCase().includes(search) ||
            (t.phone || '').toLowerCase().includes(search) ||
            (t.reference || '').toLowerCase().includes(search) ||
            (t.code || '').toLowerCase().includes(search) ||
            (t.who_email || '').toLowerCase().includes(search)
        );

        // ── Sort (newest first) + paginate ──────────────────────────────────
        filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        const total   = filtered.length;
        const start   = (page - 1) * limit;
        const pageRows = filtered.slice(start, start + limit);

        return res.json({
            success: true,
            data:    { topups: pageRows, summary },
            meta:    { total, page, limit, totalPages: Math.ceil(total / limit) },
        });

    } catch (error) {
        console.error('❌ [TOPUP_TRACE] getAllTopups:', error);
        return res.status(500).json({ success: false, message: 'Unable to load top-ups.', code: 'TOPUP_TRACE_FAILED' });
    }
};

module.exports = exports;

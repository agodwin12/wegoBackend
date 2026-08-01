// backend/src/controllers/backoffice/serviceListingReportAdmin.controller.js
// Backoffice queue for user reports of service listings (trust/safety).

const { ServiceListingReport, ServiceListing, Account } = require('../../models');
const { Op } = require('sequelize');

// GET /api/services/admin/listing-reports?status=open&page=&limit=
exports.listReports = async (req, res) => {
    try {
        const page   = Math.max(parseInt(req.query.page) || 1, 1);
        const limit  = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const offset = (page - 1) * limit;
        const { status } = req.query;

        const where = {};
        if (status && ['open', 'reviewing', 'actioned', 'dismissed'].includes(status)) {
            where.status = status;
        }

        const { count, rows } = await ServiceListingReport.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title', 'status', 'provider_id'],
                    include: [{ model: Account, as: 'provider', attributes: ['uuid', 'first_name', 'last_name'] }],
                },
                { model: Account, as: 'reporter', attributes: ['uuid', 'first_name', 'last_name'] },
            ],
            order: [['created_at', 'DESC']],
            limit,
            offset,
        });

        // Cheap status tiles (grouped)
        const grouped = await ServiceListingReport.findAll({
            attributes: ['status', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'cnt']],
            group: ['status'],
            raw: true,
        });
        const tiles = { open: 0, reviewing: 0, actioned: 0, dismissed: 0 };
        for (const g of grouped) tiles[g.status] = parseInt(g.cnt) || 0;

        const totalPages = Math.ceil(count / limit);
        return res.status(200).json({
            success: true,
            message: 'Listing reports retrieved successfully',
            data: rows,
            stats: tiles,
            pagination: { total: count, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
        });

    } catch (error) {
        console.error('❌ [LISTING_REPORT_ADMIN] listReports:', error);
        return res.status(500).json({ success: false, message: 'Unable to retrieve reports.', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
    }
};

// PATCH /api/services/admin/listing-reports/:id/resolve
// body: { action: 'dismiss' | 'deactivate' | 'reviewing', resolution_note? }
exports.resolveReport = async (req, res) => {
    try {
        const employee_id = req.user.id;
        const reportId    = parseInt(req.params.id);
        const { action, resolution_note } = req.body;

        if (!reportId || isNaN(reportId)) {
            return res.status(400).json({ success: false, message: 'A valid report id is required.' });
        }
        if (!['dismiss', 'deactivate', 'reviewing'].includes(action)) {
            return res.status(400).json({ success: false, message: "action must be 'dismiss', 'deactivate', or 'reviewing'." });
        }

        const report = await ServiceListingReport.findByPk(reportId);
        if (!report) {
            return res.status(404).json({ success: false, message: 'Report not found.' });
        }

        if (action === 'reviewing') {
            await report.update({ status: 'reviewing', resolution_note: resolution_note || null });
            return res.status(200).json({ success: true, message: 'Report marked as under review.', data: { id: report.id, status: 'reviewing' } });
        }

        await ServiceListingReport.sequelize.transaction(async (t) => {
            if (action === 'deactivate') {
                // Take the listing down and resolve every open report on it.
                await ServiceListing.update(
                    { status: 'inactive' },
                    { where: { id: report.listing_id, status: { [Op.in]: ['active', 'pending_review'] } }, transaction: t }
                );
                await ServiceListingReport.update(
                    { status: 'actioned', resolved_by: employee_id, resolved_at: new Date(), resolution_note: resolution_note || 'Listing deactivated.' },
                    { where: { listing_id: report.listing_id, status: { [Op.in]: ['open', 'reviewing'] } }, transaction: t }
                );
            } else { // dismiss
                await report.update(
                    { status: 'dismissed', resolved_by: employee_id, resolved_at: new Date(), resolution_note: resolution_note || 'Dismissed — no action needed.' },
                    { transaction: t }
                );
            }
        });

        return res.status(200).json({
            success: true,
            message: action === 'deactivate' ? 'Listing deactivated and reports resolved.' : 'Report dismissed.',
            data: { id: report.id, action },
        });

    } catch (error) {
        console.error('❌ [LISTING_REPORT_ADMIN] resolveReport:', error);
        return res.status(500).json({ success: false, message: 'Unable to resolve report.', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
    }
};

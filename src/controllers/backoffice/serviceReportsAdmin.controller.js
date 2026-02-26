// backend/src/controllers/backoffice/serviceReportsAdmin.controller.js
// Service Reports Admin Controller - Analytics, Reports & Export

const {
    ServiceRequest,
    ServiceListing,
    ServiceCategory,
    ServiceRating,
    Account,
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// ═══════════════════════════════════════════════════════════════════════
// GET COMPREHENSIVE REPORTS DATA (Admin - Dashboard analytics)
// GET /api/services/admin/reports
// ═══════════════════════════════════════════════════════════════════════

exports.getReportsData = async (req, res) => {
    try {
        const {
            date_range = 'month', // week, month, quarter, year, custom
            start_date,
            end_date,
            category_id,
            provider_id,
        } = req.query;

        console.log('📊 [SERVICE_REPORTS_ADMIN] Generating comprehensive reports...');

        // ─────────────────────────────────────────────────────────────────
        // DATE RANGE SETUP
        // ─────────────────────────────────────────────────────────────────

        let dateFilter = {};
        let chartDateFilter = {};
        const now = new Date();
        let startDate, endDate;

        if (date_range === 'custom' && start_date && end_date) {
            startDate = new Date(start_date);
            endDate = new Date(end_date);
        } else {
            switch (date_range) {
                case 'week':
                    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    break;
                case 'month':
                    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    break;
                case 'quarter':
                    const quarter = Math.floor(now.getMonth() / 3);
                    startDate = new Date(now.getFullYear(), quarter * 3, 1);
                    break;
                case 'year':
                    startDate = new Date(now.getFullYear(), 0, 1);
                    break;
                default:
                    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            }
            endDate = now;
        }

        dateFilter.payment_confirmed_at = {
            [Op.between]: [startDate, endDate]
        };

        // For charts, use last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        thirtyDaysAgo.setHours(0, 0, 0, 0);

        chartDateFilter.payment_confirmed_at = {
            [Op.gte]: thirtyDaysAgo
        };

        // ─────────────────────────────────────────────────────────────────
        // 1. REVENUE OVER TIME (LINE CHART DATA - Last 30 days)
        // ─────────────────────────────────────────────────────────────────

        const revenueOverTime = await ServiceRequest.findAll({
            attributes: [
                [sequelize.fn('DATE', sequelize.col('payment_confirmed_at')), 'date'],
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'revenue'],
                [sequelize.fn('SUM', sequelize.col('commission_amount')), 'commission'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'transactions']
            ],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                final_amount: { [Op.gt]: 0 },
                ...chartDateFilter
            },
            group: [sequelize.fn('DATE', sequelize.col('payment_confirmed_at'))],
            order: [[sequelize.fn('DATE', sequelize.col('payment_confirmed_at')), 'ASC']],
            raw: true
        });

        const revenueChart = revenueOverTime.map(item => ({
            date: item.date,
            revenue: parseFloat(item.revenue || 0).toFixed(2),
            commission: parseFloat(item.commission || 0).toFixed(2),
            transactions: parseInt(item.transactions)
        }));

        // ─────────────────────────────────────────────────────────────────
        // 2. SERVICES GROWTH (LINE CHART DATA - Last 30 days)
        // ─────────────────────────────────────────────────────────────────

        const servicesGrowth = await ServiceRequest.findAll({
            attributes: [
                [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN status IN ('completed', 'payment_confirmed') THEN 1 ELSE 0 END")), 'completed'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END")), 'cancelled']
            ],
            where: {
                created_at: { [Op.gte]: thirtyDaysAgo }
            },
            group: [sequelize.fn('DATE', sequelize.col('created_at'))],
            order: [[sequelize.fn('DATE', sequelize.col('created_at')), 'ASC']],
            raw: true
        });

        const servicesChart = servicesGrowth.map(item => ({
            date: item.date,
            total: parseInt(item.total),
            completed: parseInt(item.completed),
            cancelled: parseInt(item.cancelled)
        }));

        // ─────────────────────────────────────────────────────────────────
        // 3. NEW PROVIDERS GROWTH (LINE CHART DATA - Last 30 days)
        // ─────────────────────────────────────────────────────────────────

        const providersGrowth = await ServiceListing.findAll({
            attributes: [
                [sequelize.fn('DATE', sequelize.col('ServiceListing.created_at')), 'date'],
                [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('provider_id'))), 'count']
            ],
            where: {
                created_at: { [Op.gte]: thirtyDaysAgo }
            },
            group: [sequelize.fn('DATE', sequelize.col('ServiceListing.created_at'))],
            order: [[sequelize.fn('DATE', sequelize.col('ServiceListing.created_at')), 'ASC']],
            raw: true
        });

        const providersChart = providersGrowth.map(item => ({
            date: item.date,
            count: parseInt(item.count)
        }));

        // ─────────────────────────────────────────────────────────────────
        // 4. REVENUE BY CATEGORY (PIE CHART DATA)
        // ─────────────────────────────────────────────────────────────────

        const revenueByCategory = await ServiceRequest.findAll({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'revenue'],
                [sequelize.fn('SUM', sequelize.col('commission_amount')), 'commission'],
                [sequelize.fn('COUNT', sequelize.col('ServiceRequest.id')), 'count']
            ],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                final_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: [],
                    include: [
                        {
                            model: ServiceCategory,
                            as: 'category',
                            attributes: ['id', 'name_en', 'name_fr'],
                        }
                    ]
                }
            ],
            group: ['listing->category.id', 'listing->category.name_en', 'listing->category.name_fr'],
            order: [[sequelize.fn('SUM', sequelize.col('final_amount')), 'DESC']],
            raw: true
        });

        const categoryBreakdown = revenueByCategory.map(item => ({
            category_id: item['listing.category.id'],
            category_name: item['listing.category.name_en'],
            category_name_fr: item['listing.category.name_fr'],
            revenue: parseFloat(item.revenue || 0).toFixed(2),
            commission: parseFloat(item.commission || 0).toFixed(2),
            count: parseInt(item.count)
        }));

        // Calculate percentages
        const totalCategoryRevenue = categoryBreakdown.reduce((sum, cat) => sum + parseFloat(cat.revenue), 0);
        categoryBreakdown.forEach(cat => {
            cat.percentage = totalCategoryRevenue > 0
                ? ((parseFloat(cat.revenue) / totalCategoryRevenue) * 100).toFixed(2)
                : 0;
        });

        // ─────────────────────────────────────────────────────────────────
        // 5. SERVICE STATUS BREAKDOWN (PIE CHART DATA)
        // ─────────────────────────────────────────────────────────────────

        const statusBreakdown = await ServiceRequest.findAll({
            attributes: [
                'status',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            where: dateFilter.payment_confirmed_at ? {
                created_at: {
                    [Op.between]: [startDate, endDate]
                }
            } : {},
            group: ['status'],
            raw: true
        });

        const statusData = {};
        const statusLabels = {
            'pending': 'Pending',
            'accepted': 'Accepted',
            'rejected': 'Rejected',
            'in_progress': 'In Progress',
            'completed': 'Completed',
            'payment_pending': 'Payment Pending',
            'payment_confirmation_pending': 'Payment Confirmation',
            'payment_confirmed': 'Payment Confirmed',
            'cancelled': 'Cancelled',
            'disputed': 'Disputed'
        };

        statusBreakdown.forEach(item => {
            statusData[item.status] = {
                count: parseInt(item.count),
                label: statusLabels[item.status] || item.status
            };
        });

        // ─────────────────────────────────────────────────────────────────
        // 6. TOP PROVIDERS (By revenue)
        // ─────────────────────────────────────────────────────────────────

        const topProviders = await ServiceRequest.findAll({
            attributes: [
                'provider_id',
                [sequelize.fn('SUM', sequelize.col('provider_net_amount')), 'earnings'],
                [sequelize.fn('SUM', sequelize.col('commission_amount')), 'commission'],
                [sequelize.fn('COUNT', sequelize.col('ServiceRequest.id')), 'services_completed']
            ],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                provider_net_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            include: [
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                }
            ],
            group: ['provider_id', 'provider.uuid', 'provider.first_name', 'provider.last_name', 'provider.avatar_url'],
            order: [[sequelize.fn('SUM', sequelize.col('provider_net_amount')), 'DESC']],
            limit: 10,
            raw: true
        });

        const topProvidersData = topProviders.map(item => ({
            provider_id: item.provider_id,
            provider_name: `${item['provider.first_name']} ${item['provider.last_name']}`,
            avatar_url: item['provider.avatar_url'],
            earnings: parseFloat(item.earnings || 0).toFixed(2),
            commission: parseFloat(item.commission || 0).toFixed(2),
            services_completed: parseInt(item.services_completed)
        }));

        // ─────────────────────────────────────────────────────────────────
        // 7. PAYMENT METHODS DISTRIBUTION (PIE CHART DATA)
        // ─────────────────────────────────────────────────────────────────

        const paymentMethods = await ServiceRequest.findAll({
            attributes: [
                'payment_method',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'amount']
            ],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                payment_method: { [Op.not]: null },
                ...dateFilter
            },
            group: ['payment_method'],
            raw: true
        });

        const paymentMethodsData = paymentMethods.map(item => ({
            payment_method: item.payment_method,
            count: parseInt(item.count),
            amount: parseFloat(item.amount || 0).toFixed(2)
        }));

        // Calculate percentages
        const totalTransactions = paymentMethodsData.reduce((sum, pm) => sum + pm.count, 0);
        paymentMethodsData.forEach(pm => {
            pm.percentage = totalTransactions > 0
                ? ((pm.count / totalTransactions) * 100).toFixed(2)
                : 0;
        });

        // ─────────────────────────────────────────────────────────────────
        // 8. HOURLY DISTRIBUTION (BAR CHART DATA - Peak hours)
        // ─────────────────────────────────────────────────────────────────

        const hourlyDistribution = await ServiceRequest.findAll({
            attributes: [
                [sequelize.fn('HOUR', sequelize.col('created_at')), 'hour'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            where: {
                created_at: { [Op.gte]: thirtyDaysAgo }
            },
            group: [sequelize.fn('HOUR', sequelize.col('created_at'))],
            order: [[sequelize.fn('HOUR', sequelize.col('created_at')), 'ASC']],
            raw: true
        });

        const hourlyData = Array.from({ length: 24 }, (_, i) => ({
            hour: i,
            count: 0,
            label: `${i.toString().padStart(2, '0')}:00`
        }));

        hourlyDistribution.forEach(item => {
            const hourIndex = parseInt(item.hour);
            if (hourIndex >= 0 && hourIndex < 24) {
                hourlyData[hourIndex].count = parseInt(item.count);
            }
        });

        // ─────────────────────────────────────────────────────────────────
        // 9. AVERAGE RATINGS TREND (LINE CHART DATA - Last 30 days)
        // ─────────────────────────────────────────────────────────────────

        const ratingsTrend = await ServiceRating.findAll({
            attributes: [
                [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
                [sequelize.fn('AVG', sequelize.col('rating')), 'avg_rating'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            where: {
                created_at: { [Op.gte]: thirtyDaysAgo }
            },
            group: [sequelize.fn('DATE', sequelize.col('created_at'))],
            order: [[sequelize.fn('DATE', sequelize.col('created_at')), 'ASC']],
            raw: true
        });

        const ratingsChart = ratingsTrend.map(item => ({
            date: item.date,
            avg_rating: parseFloat(item.avg_rating || 0).toFixed(2),
            count: parseInt(item.count)
        }));

        // ─────────────────────────────────────────────────────────────────
        // 10. SUMMARY STATISTICS
        // ─────────────────────────────────────────────────────────────────

        const totalRevenueResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'total']
            ],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                final_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            raw: true
        });
        const totalRevenue = totalRevenueResult?.total || 0;

        const totalCommissionResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total']
            ],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                commission_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            raw: true
        });
        const totalCommission = totalCommissionResult?.total || 0;

        const totalServices = await ServiceRequest.count({
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                ...dateFilter
            }
        });

        const totalActiveServices = await ServiceRequest.count({
            where: {
                status: { [Op.in]: ['accepted', 'in_progress', 'payment_pending', 'payment_confirmation_pending'] }
            }
        });

        const avgTransactionResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('AVG', sequelize.col('final_amount')), 'avg']
            ],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                final_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            raw: true
        });
        const avgTransaction = avgTransactionResult?.avg || 0;

        const avgRatingResult = await ServiceRating.findOne({
            attributes: [
                [sequelize.fn('AVG', sequelize.col('rating')), 'avg']
            ],
            where: dateFilter.payment_confirmed_at ? {
                created_at: {
                    [Op.between]: [startDate, endDate]
                }
            } : {},
            raw: true
        });
        const avgRating = avgRatingResult?.avg || 0;

        const totalRatings = await ServiceRating.count({
            where: dateFilter.payment_confirmed_at ? {
                created_at: {
                    [Op.between]: [startDate, endDate]
                }
            } : {}
        });

        // Total listings
        const totalListings = await ServiceListing.count();
        const activeListings = await ServiceListing.count({ where: { status: 'approved' } });
        const pendingListings = await ServiceListing.count({ where: { status: 'pending' } });

        // Total providers
        const totalProvidersCount = await ServiceListing.count({
            distinct: true,
            col: 'provider_id'
        });

        console.log('✅ [SERVICE_REPORTS_ADMIN] Reports data generated successfully');

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.status(200).json({
            success: true,
            message: 'Reports data generated successfully',
            data: {
                period: {
                    range: date_range,
                    start_date: startDate,
                    end_date: endDate,
                },
                summary: {
                    total_revenue: parseFloat(totalRevenue).toFixed(2),
                    total_commission: parseFloat(totalCommission).toFixed(2),
                    total_services: totalServices,
                    active_services: totalActiveServices,
                    average_transaction_value: parseFloat(avgTransaction).toFixed(2),
                    average_rating: parseFloat(avgRating).toFixed(1),
                    total_ratings: totalRatings,
                    total_listings: totalListings,
                    active_listings: activeListings,
                    pending_listings: pendingListings,
                    total_providers: totalProvidersCount,
                },
                charts: {
                    revenue_over_time: revenueChart,
                    services_growth: servicesChart,
                    providers_growth: providersChart,
                    ratings_trend: ratingsChart,
                    hourly_distribution: hourlyData,
                },
                breakdowns: {
                    revenue_by_category: categoryBreakdown,
                    service_status: statusData,
                    payment_methods: paymentMethodsData,
                },
                top_performers: {
                    top_providers: topProvidersData,
                }
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_REPORTS_ADMIN] Error in getReportsData:', error);
        console.error('Stack trace:', error.stack);

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.status(500).json({
            success: false,
            message: 'Unable to generate reports. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORT REPORTS TO EXCEL
// GET /api/services/admin/reports/export/excel
// ═══════════════════════════════════════════════════════════════════════

exports.exportToExcel = async (req, res) => {
    try {
        const {
            start_date,
            end_date,
            report_type = 'transactions'
        } = req.query;

        console.log(`📥 [SERVICE_REPORTS_ADMIN] Exporting Excel report: ${report_type}...`);

        // ─────────────────────────────────────────────────────────────────
        // DATE FILTER
        // ─────────────────────────────────────────────────────────────────

        let dateFilter = {};
        if (start_date || end_date) {
            dateFilter.payment_confirmed_at = {};
            if (start_date) {
                dateFilter.payment_confirmed_at[Op.gte] = new Date(start_date);
            }
            if (end_date) {
                const toDate = new Date(end_date);
                toDate.setHours(23, 59, 59, 999);
                dateFilter.payment_confirmed_at[Op.lte] = toDate;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // CREATE WORKBOOK
        // ─────────────────────────────────────────────────────────────────

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'WEGO Services';
        workbook.created = new Date();

        // ─────────────────────────────────────────────────────────────────
        // SHEET 1: TRANSACTIONS
        // ─────────────────────────────────────────────────────────────────

        if (report_type === 'transactions' || report_type === 'all') {
            const transactions = await ServiceRequest.findAll({
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    final_amount: { [Op.gt]: 0 },
                    ...dateFilter
                },
                include: [
                    {
                        model: ServiceListing,
                        as: 'listing',
                        attributes: ['listing_id', 'title'],
                        include: [
                            {
                                model: ServiceCategory,
                                as: 'category',
                                attributes: ['name_en'],
                            }
                        ]
                    },
                    {
                        model: Account,
                        as: 'customer',
                        attributes: ['first_name', 'last_name', 'email'],
                    },
                    {
                        model: Account,
                        as: 'provider',
                        attributes: ['first_name', 'last_name', 'email'],
                    },
                ],
                order: [['payment_confirmed_at', 'DESC']],
                limit: 5000
            });

            const sheet = workbook.addWorksheet('Transactions');

            // Header row
            sheet.columns = [
                { header: 'Request ID', key: 'request_id', width: 20 },
                { header: 'Date', key: 'date', width: 15 },
                { header: 'Service', key: 'service', width: 30 },
                { header: 'Category', key: 'category', width: 20 },
                { header: 'Customer', key: 'customer', width: 25 },
                { header: 'Provider', key: 'provider', width: 25 },
                { header: 'Amount (FCFA)', key: 'amount', width: 15 },
                { header: 'Commission (FCFA)', key: 'commission', width: 18 },
                { header: 'Provider Net (FCFA)', key: 'provider_net', width: 18 },
                { header: 'Payment Method', key: 'payment_method', width: 18 },
                { header: 'Status', key: 'status', width: 20 },
            ];

            // Style header
            sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            sheet.getRow(1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF000000' }
            };

            // Add data
            transactions.forEach(t => {
                sheet.addRow({
                    request_id: t.request_id,
                    date: t.payment_confirmed_at ? new Date(t.payment_confirmed_at).toLocaleDateString() : '',
                    service: t.listing?.title || 'N/A',
                    category: t.listing?.category?.name_en || 'N/A',
                    customer: t.customer ? `${t.customer.first_name} ${t.customer.last_name}` : 'N/A',
                    provider: t.provider ? `${t.provider.first_name} ${t.provider.last_name}` : 'N/A',
                    amount: parseFloat(t.final_amount || 0),
                    commission: parseFloat(t.commission_amount || 0),
                    provider_net: parseFloat(t.provider_net_amount || 0),
                    payment_method: t.payment_method || 'N/A',
                    status: t.status
                });
            });

            // Add totals row
            const lastRow = sheet.lastRow.number + 2;
            sheet.getCell(`F${lastRow}`).value = 'TOTALS:';
            sheet.getCell(`F${lastRow}`).font = { bold: true };
            sheet.getCell(`G${lastRow}`).value = { formula: `SUM(G2:G${lastRow - 2})` };
            sheet.getCell(`H${lastRow}`).value = { formula: `SUM(H2:H${lastRow - 2})` };
            sheet.getCell(`I${lastRow}`).value = { formula: `SUM(I2:I${lastRow - 2})` };
        }

        // ─────────────────────────────────────────────────────────────────
        // SHEET 2: PROVIDERS SUMMARY
        // ─────────────────────────────────────────────────────────────────

        if (report_type === 'providers' || report_type === 'all') {
            const providers = await ServiceRequest.findAll({
                attributes: [
                    'provider_id',
                    [sequelize.fn('COUNT', sequelize.col('ServiceRequest.id')), 'total_services'],
                    [sequelize.fn('SUM', sequelize.col('final_amount')), 'total_revenue'],
                    [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total_commission'],
                    [sequelize.fn('SUM', sequelize.col('provider_net_amount')), 'total_earnings']
                ],
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    final_amount: { [Op.gt]: 0 },
                    ...dateFilter
                },
                include: [
                    {
                        model: Account,
                        as: 'provider',
                        attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164'],
                    }
                ],
                group: ['provider_id', 'provider.uuid', 'provider.first_name', 'provider.last_name', 'provider.email', 'provider.phone_e164'],
                order: [[sequelize.fn('SUM', sequelize.col('final_amount')), 'DESC']],
                raw: true
            });

            const sheet = workbook.addWorksheet('Providers Summary');

            sheet.columns = [
                { header: 'Provider Name', key: 'name', width: 30 },
                { header: 'Email', key: 'email', width: 30 },
                { header: 'Phone', key: 'phone', width: 18 },
                { header: 'Total Services', key: 'services', width: 15 },
                { header: 'Total Revenue (FCFA)', key: 'revenue', width: 20 },
                { header: 'Commission (FCFA)', key: 'commission', width: 18 },
                { header: 'Net Earnings (FCFA)', key: 'earnings', width: 20 },
            ];

            sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            sheet.getRow(1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF000000' }
            };

            providers.forEach(p => {
                sheet.addRow({
                    name: `${p['provider.first_name']} ${p['provider.last_name']}`,
                    email: p['provider.email'],
                    phone: p['provider.phone_e164'],
                    services: parseInt(p.total_services),
                    revenue: parseFloat(p.total_revenue || 0),
                    commission: parseFloat(p.total_commission || 0),
                    earnings: parseFloat(p.total_earnings || 0)
                });
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // SHEET 3: CATEGORIES PERFORMANCE
        // ─────────────────────────────────────────────────────────────────

        if (report_type === 'categories' || report_type === 'all') {
            const categories = await ServiceRequest.findAll({
                attributes: [
                    [sequelize.fn('COUNT', sequelize.col('ServiceRequest.id')), 'total_services'],
                    [sequelize.fn('SUM', sequelize.col('final_amount')), 'total_revenue'],
                    [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total_commission']
                ],
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    final_amount: { [Op.gt]: 0 },
                    ...dateFilter
                },
                include: [
                    {
                        model: ServiceListing,
                        as: 'listing',
                        attributes: [],
                        include: [
                            {
                                model: ServiceCategory,
                                as: 'category',
                                attributes: ['id', 'name_en'],
                            }
                        ]
                    }
                ],
                group: ['listing->category.id', 'listing->category.name_en'],
                order: [[sequelize.fn('SUM', sequelize.col('final_amount')), 'DESC']],
                raw: true
            });

            const sheet = workbook.addWorksheet('Categories Performance');

            sheet.columns = [
                { header: 'Category', key: 'category', width: 30 },
                { header: 'Total Services', key: 'services', width: 15 },
                { header: 'Total Revenue (FCFA)', key: 'revenue', width: 20 },
                { header: 'Commission (FCFA)', key: 'commission', width: 18 },
            ];

            sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            sheet.getRow(1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF000000' }
            };

            categories.forEach(c => {
                sheet.addRow({
                    category: c['listing.category.name_en'] || 'N/A',
                    services: parseInt(c.total_services),
                    revenue: parseFloat(c.total_revenue || 0),
                    commission: parseFloat(c.total_commission || 0)
                });
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // SEND EXCEL FILE
        // ─────────────────────────────────────────────────────────────────

        const filename = `wego_services_${report_type}_${Date.now()}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        await workbook.xlsx.write(res);

        console.log(`✅ [SERVICE_REPORTS_ADMIN] Excel export completed: ${filename}`);

        res.end();

    } catch (error) {
        console.error('❌ [SERVICE_REPORTS_ADMIN] Error in exportToExcel:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to export Excel report. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORT REPORTS TO PDF
// GET /api/services/admin/reports/export/pdf
// ═══════════════════════════════════════════════════════════════════════

exports.exportToPDF = async (req, res) => {
    try {
        const {
            start_date,
            end_date,
            report_type = 'summary'
        } = req.query;

        console.log(`📥 [SERVICE_REPORTS_ADMIN] Exporting PDF report: ${report_type}...`);

        // ─────────────────────────────────────────────────────────────────
        // DATE FILTER
        // ─────────────────────────────────────────────────────────────────

        let dateFilter = {};
        let startDate = 'All Time';
        let endDate = 'Present';

        if (start_date || end_date) {
            dateFilter.payment_confirmed_at = {};
            if (start_date) {
                dateFilter.payment_confirmed_at[Op.gte] = new Date(start_date);
                startDate = new Date(start_date).toLocaleDateString();
            }
            if (end_date) {
                const toDate = new Date(end_date);
                toDate.setHours(23, 59, 59, 999);
                dateFilter.payment_confirmed_at[Op.lte] = toDate;
                endDate = toDate.toLocaleDateString();
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // FETCH SUMMARY DATA
        // ─────────────────────────────────────────────────────────────────

        const totalRevenueResult = await ServiceRequest.findOne({
            attributes: [[sequelize.fn('SUM', sequelize.col('final_amount')), 'total']],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                final_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            raw: true
        });
        const totalRevenue = totalRevenueResult?.total || 0;

        const totalCommissionResult = await ServiceRequest.findOne({
            attributes: [[sequelize.fn('SUM', sequelize.col('commission_amount')), 'total']],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                commission_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            raw: true
        });
        const totalCommission = totalCommissionResult?.total || 0;

        const totalServices = await ServiceRequest.count({
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                ...dateFilter
            }
        });

        const avgTransactionResult = await ServiceRequest.findOne({
            attributes: [[sequelize.fn('AVG', sequelize.col('final_amount')), 'avg']],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                final_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            raw: true
        });
        const avgTransaction = avgTransactionResult?.avg || 0;

        // Top categories
        const topCategories = await ServiceRequest.findAll({
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('ServiceRequest.id')), 'count'],
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'revenue']
            ],
            where: {
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                final_amount: { [Op.gt]: 0 },
                ...dateFilter
            },
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: [],
                    include: [
                        {
                            model: ServiceCategory,
                            as: 'category',
                            attributes: ['name_en'],
                        }
                    ]
                }
            ],
            group: ['listing->category.name_en'],
            order: [[sequelize.fn('SUM', sequelize.col('final_amount')), 'DESC']],
            limit: 5,
            raw: true
        });

        // ─────────────────────────────────────────────────────────────────
        // CREATE PDF DOCUMENT
        // ─────────────────────────────────────────────────────────────────

        const doc = new PDFDocument({ margin: 50 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="wego_services_report_${Date.now()}.pdf"`);

        doc.pipe(res);

        // Header
        doc.fontSize(24).font('Helvetica-Bold').text('WEGO SERVICES REPORT', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(12).font('Helvetica').text(`Period: ${startDate} - ${endDate}`, { align: 'center' });
        doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);

        // Summary Section
        doc.fontSize(16).font('Helvetica-Bold').text('SUMMARY', { underline: true });
        doc.moveDown(1);

        doc.fontSize(12).font('Helvetica');
        doc.text(`Total Revenue: ${parseFloat(totalRevenue).toLocaleString()} FCFA`);
        doc.text(`Total Commission: ${parseFloat(totalCommission).toLocaleString()} FCFA`);
        doc.text(`Total Services Completed: ${totalServices}`);
        doc.text(`Average Transaction Value: ${parseFloat(avgTransaction).toLocaleString()} FCFA`);
        doc.moveDown(2);

        // Top Categories Section
        doc.fontSize(16).font('Helvetica-Bold').text('TOP PERFORMING CATEGORIES', { underline: true });
        doc.moveDown(1);

        doc.fontSize(12).font('Helvetica');
        topCategories.forEach((cat, index) => {
            doc.text(`${index + 1}. ${cat['listing.category.name_en'] || 'N/A'}`);
            doc.text(`   Services: ${cat.count} | Revenue: ${parseFloat(cat.revenue || 0).toLocaleString()} FCFA`);
            doc.moveDown(0.5);
        });

        doc.moveDown(2);

        // Footer
        doc.fontSize(8).font('Helvetica-Oblique').text(
            'This report is confidential and for internal use only.',
            50,
            doc.page.height - 50,
            { align: 'center' }
        );

        doc.end();

        console.log(`✅ [SERVICE_REPORTS_ADMIN] PDF export completed`);

    } catch (error) {
        console.error('❌ [SERVICE_REPORTS_ADMIN] Error in exportToPDF:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to export PDF report. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORT REPORTS TO CSV
// GET /api/services/admin/reports/export/csv
// ═══════════════════════════════════════════════════════════════════════

exports.exportToCSV = async (req, res) => {
    try {
        const {
            start_date,
            end_date,
            report_type = 'transactions'
        } = req.query;

        console.log(`📥 [SERVICE_REPORTS_ADMIN] Exporting CSV report: ${report_type}...`);

        // ─────────────────────────────────────────────────────────────────
        // DATE FILTER
        // ─────────────────────────────────────────────────────────────────

        let dateFilter = {};
        if (start_date || end_date) {
            dateFilter.payment_confirmed_at = {};
            if (start_date) {
                dateFilter.payment_confirmed_at[Op.gte] = new Date(start_date);
            }
            if (end_date) {
                const toDate = new Date(end_date);
                toDate.setHours(23, 59, 59, 999);
                dateFilter.payment_confirmed_at[Op.lte] = toDate;
            }
        }

        let csvContent = '';
        let filename = '';

        // ─────────────────────────────────────────────────────────────────
        // GENERATE CSV BASED ON REPORT TYPE
        // ─────────────────────────────────────────────────────────────────

        if (report_type === 'transactions') {
            const transactions = await ServiceRequest.findAll({
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    final_amount: { [Op.gt]: 0 },
                    ...dateFilter
                },
                include: [
                    {
                        model: ServiceListing,
                        as: 'listing',
                        attributes: ['listing_id', 'title'],
                        include: [{ model: ServiceCategory, as: 'category', attributes: ['name_en'] }]
                    },
                    { model: Account, as: 'customer', attributes: ['first_name', 'last_name', 'email'] },
                    { model: Account, as: 'provider', attributes: ['first_name', 'last_name', 'email'] },
                ],
                order: [['payment_confirmed_at', 'DESC']],
                limit: 10000
            });

            csvContent = 'Request ID,Date,Service,Category,Customer,Provider,Amount (FCFA),Commission (FCFA),Provider Net (FCFA),Payment Method,Status\n';

            transactions.forEach(t => {
                const row = [
                    t.request_id,
                    t.payment_confirmed_at ? new Date(t.payment_confirmed_at).toLocaleDateString() : '',
                    `"${(t.listing?.title || 'N/A').replace(/"/g, '""')}"`,
                    t.listing?.category?.name_en || 'N/A',
                    t.customer ? `"${t.customer.first_name} ${t.customer.last_name}"` : 'N/A',
                    t.provider ? `"${t.provider.first_name} ${t.provider.last_name}"` : 'N/A',
                    parseFloat(t.final_amount || 0).toFixed(2),
                    parseFloat(t.commission_amount || 0).toFixed(2),
                    parseFloat(t.provider_net_amount || 0).toFixed(2),
                    t.payment_method || 'N/A',
                    t.status
                ];
                csvContent += row.join(',') + '\n';
            });

            filename = `wego_transactions_${Date.now()}.csv`;

        } else if (report_type === 'providers') {
            const providers = await ServiceRequest.findAll({
                attributes: [
                    'provider_id',
                    [sequelize.fn('COUNT', sequelize.col('ServiceRequest.id')), 'total_services'],
                    [sequelize.fn('SUM', sequelize.col('final_amount')), 'total_revenue'],
                    [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total_commission'],
                    [sequelize.fn('SUM', sequelize.col('provider_net_amount')), 'total_earnings']
                ],
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    final_amount: { [Op.gt]: 0 },
                    ...dateFilter
                },
                include: [
                    { model: Account, as: 'provider', attributes: ['first_name', 'last_name', 'email', 'phone_e164'] }
                ],
                group: ['provider_id', 'provider.uuid', 'provider.first_name', 'provider.last_name', 'provider.email', 'provider.phone_e164'],
                order: [[sequelize.fn('SUM', sequelize.col('final_amount')), 'DESC']],
                raw: true
            });

            csvContent = 'Provider Name,Email,Phone,Total Services,Total Revenue (FCFA),Commission (FCFA),Net Earnings (FCFA)\n';

            providers.forEach(p => {
                const row = [
                    `"${p['provider.first_name']} ${p['provider.last_name']}"`,
                    p['provider.email'],
                    p['provider.phone_e164'],
                    parseInt(p.total_services),
                    parseFloat(p.total_revenue || 0).toFixed(2),
                    parseFloat(p.total_commission || 0).toFixed(2),
                    parseFloat(p.total_earnings || 0).toFixed(2)
                ];
                csvContent += row.join(',') + '\n';
            });

            filename = `wego_providers_${Date.now()}.csv`;

        } else if (report_type === 'categories') {
            const categories = await ServiceRequest.findAll({
                attributes: [
                    [sequelize.fn('COUNT', sequelize.col('ServiceRequest.id')), 'total_services'],
                    [sequelize.fn('SUM', sequelize.col('final_amount')), 'total_revenue'],
                    [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total_commission']
                ],
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    final_amount: { [Op.gt]: 0 },
                    ...dateFilter
                },
                include: [
                    {
                        model: ServiceListing,
                        as: 'listing',
                        attributes: [],
                        include: [{ model: ServiceCategory, as: 'category', attributes: ['name_en'] }]
                    }
                ],
                group: ['listing->category.name_en'],
                order: [[sequelize.fn('SUM', sequelize.col('final_amount')), 'DESC']],
                raw: true
            });

            csvContent = 'Category,Total Services,Total Revenue (FCFA),Commission (FCFA)\n';

            categories.forEach(c => {
                const row = [
                    c['listing.category.name_en'] || 'N/A',
                    parseInt(c.total_services),
                    parseFloat(c.total_revenue || 0).toFixed(2),
                    parseFloat(c.total_commission || 0).toFixed(2)
                ];
                csvContent += row.join(',') + '\n';
            });

            filename = `wego_categories_${Date.now()}.csv`;
        }

        // ─────────────────────────────────────────────────────────────────
        // SEND CSV FILE
        // ─────────────────────────────────────────────────────────────────

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        console.log(`✅ [SERVICE_REPORTS_ADMIN] CSV export completed: ${filename}`);

        res.send(csvContent);

    } catch (error) {
        console.error('❌ [SERVICE_REPORTS_ADMIN] Error in exportToCSV:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to export CSV report. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;
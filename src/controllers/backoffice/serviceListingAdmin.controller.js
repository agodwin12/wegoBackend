// backend/src/controllers/backoffice/serviceListingAdmin.controller.js
// Service Listing Admin Controller - Moderation of service listings

const {
    ServiceListing,
    ServiceCategory,
    Account,
    Employee,
    ServiceAdPayment,
    ServiceListingPlan
} = require('../../models');
const { Op } = require('sequelize');
const NotificationService = require('../../services/NotificationService');

// ═══════════════════════════════════════════════════════════════════════
// GET ALL LISTINGS FOR MODERATION (Admin)
// GET /api/services/admin/listings
// ═══════════════════════════════════════════════════════════════════════

exports.getAllListings = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        const {
            status,
            category,
            sort = 'oldest',
            search
        } = req.query;

        console.log(`📋 [LISTING_ADMIN] Fetching listings - Page: ${page}, Status: ${status || 'all'}`);

        // Build where clause
        const where = {};

        if (status && status !== 'all') {
            where.status = status;
        }

        if (category && category !== 'all') {
            where.category_id = parseInt(category);
        }

        if (search) {
            where[Op.or] = [
                { title: { [Op.like]: `%${search}%` } },
                { description: { [Op.like]: `%${search}%` } },
            ];
        }

        // Determine sort order
        const orderField = 'created_at';
        const orderDirection = sort === 'newest' ? 'DESC' : 'ASC';

        const { count, rows: listings } = await ServiceListing.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en', 'name_fr'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: [
                        'uuid',
                        'first_name',
                        'last_name',
                        'email',
                        'phone_e164',
                        'avatar_url',
                        'user_type',
                        'created_at'
                    ],
                },
            ],
            limit,
            offset,
            order: [[orderField, orderDirection]],
        });

        // Transform data
        const transformedListings = listings.map(listing => {
            const data = listing.toJSON();

            // Add category names
            if (data.category) {
                data.category_name = data.category.name_en;
                data.subcategory_name = data.category.name_en; // Adjust if you have subcategories
            } else {
                data.category_name = 'Uncategorized';
                data.subcategory_name = '';
            }

            // ✅ FIX: Ensure photos is array FIRST (before using it)
            if (typeof data.photos === 'string') {
                try {
                    data.photos = JSON.parse(data.photos);
                } catch (e) {
                    data.photos = [];
                }
            }
            if (!Array.isArray(data.photos)) {
                data.photos = [];
            }

            // ✅ FIX: Ensure availability_days is array
            if (typeof data.available_days === 'string') {
                try {
                    data.available_days = JSON.parse(data.available_days);
                } catch (e) {
                    data.available_days = [];
                }
            }
            if (!Array.isArray(data.available_days)) {
                data.available_days = [];
            }

            // ✅ FIX: Transform provider data with proper avatar handling
            if (data.provider) {
                const providerData = data.provider;
                data.provider = {
                    id: providerData.uuid,
                    first_name: providerData.first_name || '',
                    last_name: providerData.last_name || '',
                    email: providerData.email || '',
                    phone: providerData.phone_e164 || '',
                    profile_image: providerData.avatar_url || null,  // ✅ This is correct
                    rating: parseFloat(data.average_rating) || 0,
                    total_reviews: parseInt(data.total_reviews) || 0,
                    completed_services: parseInt(data.booking_count) || 0,
                    is_verified: providerData.user_type === 'driver',
                    is_driver: providerData.user_type === 'driver',
                    member_since: providerData.created_at,
                    // Compatibility keys the backoffice detail modal reads directly:
                    phone_e164: providerData.phone_e164 || '',
                    avatar_url: providerData.avatar_url || null,
                    user_type:  providerData.user_type || '',
                };
            } else {
                // Fallback if provider not found
                data.provider = {
                    id: '',
                    first_name: 'Unknown',
                    last_name: 'Provider',
                    email: '',
                    phone: '',
                    profile_image: null,
                    rating: 0,
                    total_reviews: 0,
                    completed_services: 0,
                    is_verified: false,
                    is_driver: false,
                    member_since: new Date(),
                };
            }

            // ✅ FIX: Map database fields to frontend expectations
            data.location = data.city || '';
            data.service_radius = parseFloat(data.service_radius_km) || 0;
            data.availability_hours = data.available_hours || '';
            data.is_emergency = data.emergency_service || false;

            // ✅ FIX: Ensure neighborhoods is array or string
            if (typeof data.neighborhoods === 'string') {
                try {
                    const parsed = JSON.parse(data.neighborhoods);
                    data.neighborhoods = Array.isArray(parsed) ? parsed.join(', ') : data.neighborhoods;
                } catch (e) {
                    // Already a string, keep as is
                }
            }

            // ✅ FIX: Ensure years_experience is number or null
            data.years_experience = data.years_experience ? parseInt(data.years_experience) : null;

            return data;
        });

        const totalPages = Math.ceil(count / limit);

        console.log(`✅ [LISTING_ADMIN] Retrieved ${count} total listings, returning ${listings.length} for page ${page}`);

        res.status(200).json({
            success: true,
            message: 'Listings retrieved successfully',
            listings: transformedListings,
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [LISTING_ADMIN] Error in getAllListings:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to retrieve listings. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};
// ═══════════════════════════════════════════════════════════════════════
// APPROVE LISTING
// POST /api/services/admin/listings/:id/approve
// ═══════════════════════════════════════════════════════════════════════

exports.approveListing = async (req, res) => {
    try {
        const { id } = req.params;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findByPk(id);

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found.',
            });
        }

        if (listing.status !== 'pending_review') {
            return res.status(400).json({
                success: false,
                message: `Cannot approve listing with status "${listing.status}". Only listings pending review can be approved.`,
            });
        }

        // Apply the provider's paid plan tier (boost + expiry), then go live.
        const activePlan = await ServiceAdPayment.findOne({
            where: { paid_by: listing.provider_id, status: 'active' },
            include: [{ model: ServiceListingPlan, as: 'plan' }],
            order: [['plan_expires_at', 'DESC']],
        });
        const now = new Date();
        const fallbackExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        await listing.update({
            status:            'active',
            approved_by:       employee_id,
            approved_at:       now,
            rejected_by:       null,
            rejected_at:       null,
            rejection_reason:  null,
            current_plan_id:   activePlan?.plan_id ?? listing.current_plan_id ?? null,
            boost_priority:    activePlan?.plan?.boost_priority ?? listing.boost_priority ?? 0,
            plan_activated_at: now,
            plan_expires_at:   activePlan?.plan_expires_at ?? fallbackExpiry,
        });

        console.log(`✅ [LISTING_ADMIN] Listing approved & live:`, listing.listing_id, 'by employee:', employee_id);

        NotificationService.send({
            accountUuid: listing.provider_id,
            type:        'SERVICE_LISTING_APPROVED',
            title:       'Your post is live! 🎉',
            body:        `"${listing.title}" has been approved and is now visible to customers.`,
            data:        { screen: 'my_listings', listing_id: String(listing.id) },
        }).catch(err => console.warn('⚠️ [NOTIF] approve push failed:', err.message));

        res.status(200).json({
            success: true,
            message: 'Listing approved and is now live. Provider has been notified.',
            data: {
                id: listing.id,
                listing_id: listing.listing_id,
                status: listing.status,
                approved_at: listing.approved_at,
                plan_expires_at: listing.plan_expires_at,
            },
        });

    } catch (error) {
        console.error('❌ [LISTING_ADMIN] Error in approveListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to approve listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// REJECT LISTING
// POST /api/services/admin/listings/:id/reject
// ═══════════════════════════════════════════════════════════════════════

exports.rejectListing = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required and must be at least 10 characters long.',
            });
        }

        const listing = await ServiceListing.findByPk(id);

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found.',
            });
        }

        if (listing.status !== 'pending_review') {
            return res.status(400).json({
                success: false,
                message: `Cannot reject listing with status "${listing.status}". Only listings pending review can be rejected.`,
            });
        }

        // Reject listing
        await listing.update({
            status: 'rejected',
            rejected_by: employee_id,
            rejected_at: new Date(),
            rejection_reason: reason.trim(),
        });

        console.log(`❌ [LISTING_ADMIN] Listing rejected:`, listing.listing_id, 'by employee:', employee_id);

        NotificationService.send({
            accountUuid: listing.provider_id,
            type:        'SERVICE_LISTING_REJECTED',
            title:       'Your post needs changes',
            body:        `"${listing.title}" wasn't approved: ${reason.trim()}. You can edit and resubmit it.`,
            data:        { screen: 'my_listings', listing_id: String(listing.id) },
        }).catch(err => console.warn('⚠️ [NOTIF] reject push failed:', err.message));

        res.status(200).json({
            success: true,
            message: 'Listing rejected successfully. Provider will be notified.',
            data: {
                id: listing.id,
                listing_id: listing.listing_id,
                status: listing.status,
                rejected_at: listing.rejected_at,
                rejection_reason: listing.rejection_reason,
            },
        });

    } catch (error) {
        console.error('❌ [LISTING_ADMIN] Error in rejectListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to reject listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE / EDIT LISTING (Admin)
// PATCH /api/services/admin/listings/:id
// ───────────────────────────────────────────────────────────────────────
// Lets an admin edit a listing directly: toggle hero placement, override
// boost priority, change status (suspend / reactivate / etc.), adjust the
// plan/hero expiry, and fix content (title, description, pricing, city…).
// Only whitelisted fields are accepted; everything else is ignored.
// ═══════════════════════════════════════════════════════════════════════

exports.updateListing = async (req, res) => {
    try {
        const { id } = req.params;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findByPk(id);
        if (!listing) {
            return res.status(404).json({ success: false, message: 'Listing not found.' });
        }

        const b = req.body || {};
        const updates = {};

        // ── Content fields ─────────────────────────────────────────────────
        if (typeof b.title === 'string') {
            const t = b.title.trim();
            if (t.length < 3) {
                return res.status(400).json({ success: false, message: 'Title must be at least 3 characters.' });
            }
            updates.title = t;
        }
        if (typeof b.description === 'string') updates.description = b.description;
        if (typeof b.city === 'string')        updates.city = b.city.trim();
        if (typeof b.certifications === 'string') updates.certifications = b.certifications;

        if (b.pricing_type !== undefined) {
            if (!['hourly', 'fixed', 'negotiable'].includes(b.pricing_type)) {
                return res.status(400).json({ success: false, message: 'Invalid pricing_type.' });
            }
            updates.pricing_type = b.pricing_type;
        }

        const numOrNull = (v) => (v === null || v === '' || v === undefined ? null : Number(v));
        for (const f of ['hourly_rate', 'minimum_charge', 'fixed_price']) {
            if (b[f] !== undefined) {
                const n = numOrNull(b[f]);
                if (n !== null && (Number.isNaN(n) || n < 0)) {
                    return res.status(400).json({ success: false, message: `Invalid ${f}.` });
                }
                updates[f] = n;
            }
        }

        if (b.emergency_service !== undefined) updates.emergency_service = !!b.emergency_service;
        if (b.years_experience !== undefined) {
            updates.years_experience =
                b.years_experience === null || b.years_experience === '' ? null : parseInt(b.years_experience);
        }

        // ── Admin controls: status ─────────────────────────────────────────
        const ALLOWED_STATUS = [
            'draft', 'pending_review', 'active', 'expired',
            'rejected', 'inactive', 'hero_pending', 'suspended',
        ];
        if (b.status !== undefined) {
            if (!ALLOWED_STATUS.includes(b.status)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid status. Allowed: ${ALLOWED_STATUS.join(', ')}.`,
                });
            }
            updates.status = b.status;
        }

        // ── Admin controls: boost priority ─────────────────────────────────
        if (b.boost_priority !== undefined) {
            const bp = parseInt(b.boost_priority);
            if (Number.isNaN(bp) || bp < 0) {
                return res.status(400).json({ success: false, message: 'boost_priority must be a non-negative integer.' });
            }
            updates.boost_priority = bp;
        }

        // ── Admin controls: plan expiry ────────────────────────────────────
        if (b.plan_expires_at !== undefined) {
            updates.plan_expires_at = b.plan_expires_at ? new Date(b.plan_expires_at) : null;
        }

        // ── Admin controls: hero placement ─────────────────────────────────
        let heroTurnedOn = false;
        if (b.is_hero !== undefined) {
            const nextHero = !!b.is_hero;
            if (nextHero && !listing.is_hero) {
                heroTurnedOn = true;
                updates.is_hero          = true;
                updates.hero_approved_at = new Date();
                // Default a 30-day hero window if none supplied and none set.
                if (b.hero_expires_at === undefined && !listing.hero_expires_at) {
                    updates.hero_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                }
            } else if (!nextHero) {
                updates.is_hero          = false;
                updates.hero_approved_at = null;
                updates.hero_expires_at  = null;
            }
        }
        // Explicit hero expiry override (only meaningful when hero is/stays on)
        if (b.hero_expires_at !== undefined && updates.is_hero !== false) {
            updates.hero_expires_at = b.hero_expires_at ? new Date(b.hero_expires_at) : null;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, message: 'No valid fields provided to update.' });
        }

        await listing.update(updates);

        console.log(
            `✏️ [LISTING_ADMIN] Listing ${listing.listing_id} updated by employee ${employee_id}:`,
            Object.keys(updates).join(', ')
        );

        // Notify the provider when we put their listing on the hero carousel.
        if (heroTurnedOn) {
            NotificationService.send({
                accountUuid: listing.provider_id,
                type:        'SERVICE_LISTING_FEATURED',
                title:       'Your listing is now featured! ⭐',
                body:        `"${listing.title}" is now showcased in the hero carousel.`,
                data:        { screen: 'my_listings', listing_id: String(listing.id) },
            }).catch(err => console.warn('⚠️ [NOTIF] hero push failed:', err.message));
        }

        return res.status(200).json({
            success: true,
            message: 'Listing updated successfully.',
            listing: {
                id:              listing.id,
                listing_id:      listing.listing_id,
                title:           listing.title,
                status:          listing.status,
                is_hero:         listing.is_hero,
                hero_expires_at: listing.hero_expires_at,
                boost_priority:  listing.boost_priority,
                plan_expires_at: listing.plan_expires_at,
                pricing_type:    listing.pricing_type,
                hourly_rate:     listing.hourly_rate,
                minimum_charge:  listing.minimum_charge,
                fixed_price:     listing.fixed_price,
                city:            listing.city,
            },
        });

    } catch (error) {
        console.error('❌ [LISTING_ADMIN] Error in updateListing:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to update listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;
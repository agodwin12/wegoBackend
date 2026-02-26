// backend/src/controllers/serviceListing.controller.js
// Service Listing Controller - Provider Listings Management
// PRODUCTION READY - ALL FIELDS RETURNED

const { ServiceListing, ServiceCategory, Account, Employee, ServiceRating } = require('../models');
const { uploadFileToR2, deleteFile } = require('../middleware/upload');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTION: PARSE JSON FIELDS
// ═══════════════════════════════════════════════════════════════════════

const parseListingJsonFields = (listing) => {
    const listingData = listing.toJSON ? listing.toJSON() : listing;

    // Parse neighborhoods
    if (typeof listingData.neighborhoods === 'string') {
        try {
            listingData.neighborhoods = JSON.parse(listingData.neighborhoods);
        } catch (e) {
            listingData.neighborhoods = [];
        }
    }

    // Parse photos
    if (typeof listingData.photos === 'string') {
        try {
            listingData.photos = JSON.parse(listingData.photos);
        } catch (e) {
            listingData.photos = [];
        }
    }

    // Parse available_days
    if (typeof listingData.available_days === 'string') {
        try {
            listingData.available_days = JSON.parse(listingData.available_days);
        } catch (e) {
            listingData.available_days = [];
        }
    }

    // Parse portfolio_links
    if (typeof listingData.portfolio_links === 'string') {
        try {
            listingData.portfolio_links = JSON.parse(listingData.portfolio_links);
        } catch (e) {
            listingData.portfolio_links = [];
        }
    }

    return listingData;
};

// ═══════════════════════════════════════════════════════════════════════
// GENERATE UNIQUE LISTING ID
// ═══════════════════════════════════════════════════════════════════════

const generateListingId = () => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(10000 + Math.random() * 90000);
    return `LIST-${year}${month}${day}-${random}`;
};

// ═══════════════════════════════════════════════════════════════════════
// CREATE SERVICE LISTING (Provider - Driver or Passenger)
// POST /api/services/moderation
// ═══════════════════════════════════════════════════════════════════════

exports.createListing = async (req, res) => {
    try {
        // ─────────────────────────────────────────────────────────────────
        // PARSE JSON FIELDS FROM MULTIPART/FORM-DATA
        // ─────────────────────────────────────────────────────────────────

        if (req.body.neighborhoods && typeof req.body.neighborhoods === 'string') {
            try {
                req.body.neighborhoods = JSON.parse(req.body.neighborhoods);
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid neighborhoods format. Must be a valid JSON array.',
                });
            }
        }

        if (req.body.available_days && typeof req.body.available_days === 'string') {
            try {
                req.body.available_days = JSON.parse(req.body.available_days);
            } catch (e) {
                // Optional field, ignore parse error
                req.body.available_days = null;
            }
        }

        if (req.body.portfolio_links && typeof req.body.portfolio_links === 'string') {
            try {
                req.body.portfolio_links = JSON.parse(req.body.portfolio_links);
            } catch (e) {
                // Optional field, ignore parse error
                req.body.portfolio_links = null;
            }
        }

        const {
            category_id,
            title,
            description,
            pricing_type,
            hourly_rate,
            minimum_charge,
            fixed_price,
            city,
            neighborhoods,
            service_radius_km,
            available_days,
            available_hours,
            emergency_service,
            years_experience,
            certifications,
            portfolio_links,
        } = req.body;

        const provider_id = req.user.uuid; // From auth middleware

        // ─────────────────────────────────────────────────────────────────
        // BASIC VALIDATION (Joi validator handles most of this now)
        // ─────────────────────────────────────────────────────────────────

        // Check if category exists and is active
        const category = await ServiceCategory.findByPk(category_id);
        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found. Please select a valid category.',
            });
        }

        if (category.status !== 'active') {
            return res.status(400).json({
                success: false,
                message: 'Selected category is not active. Please choose a different category.',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // HANDLE PHOTO UPLOADS (max 5)
        // ─────────────────────────────────────────────────────────────────

        let photos = [];
        if (req.files && req.files.length > 0) {
            if (req.files.length > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Too many photos. Maximum 5 photos allowed per listing.',
                });
            }

            try {
                for (const file of req.files) {
                    const photoUrl = await uploadFileToR2(file, 'service-moderation');
                    photos.push(photoUrl);
                }
            } catch (uploadError) {
                console.error('❌ [SERVICE_LISTING_CONTROLLER] Photo upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload photos. Please try again or contact support.',
                });
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // CREATE LISTING
        // ─────────────────────────────────────────────────────────────────

        const listing_id = generateListingId();

        const listing = await ServiceListing.create({
            listing_id,
            provider_id,
            category_id,
            title: title.trim(),
            description: description.trim(),
            pricing_type,
            hourly_rate: pricing_type === 'hourly' ? hourly_rate : null,
            minimum_charge: pricing_type === 'hourly' ? minimum_charge : null,
            fixed_price: pricing_type === 'fixed' ? fixed_price : null,
            city: city.trim(),
            neighborhoods: neighborhoods || null,
            service_radius_km: service_radius_km || null,
            photos: photos.length > 0 ? photos : null,
            available_days: available_days || null,
            available_hours: available_hours || null,
            emergency_service: emergency_service === 'true' || emergency_service === true,
            years_experience: years_experience || null,
            certifications: certifications || null,
            portfolio_links: portfolio_links || null,
            status: 'pending', // All moderation start as pending
        });

        console.log('✅ [SERVICE_LISTING_CONTROLLER] Listing created:', listing.listing_id);

        res.status(201).json({
            success: true,
            message: 'Service listing created successfully. It will be reviewed by our team shortly.',
            data: {
                listing: {
                    id: listing.id,
                    listing_id: listing.listing_id,
                    title: listing.title,
                    status: listing.status,
                    created_at: listing.created_at,
                }
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_CONTROLLER] Error in createListing:', error);

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error. Please check your input and try again.',
                errors: error.errors.map(e => e.message),
            });
        }

        res.status(500).json({
            success: false,
            message: 'Unable to create listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL LISTINGS (Public - Active only, with filters & pagination)
// GET /api/services/moderation
// ═══════════════════════════════════════════════════════════════════════

exports.getAllListings = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const {
            category_id,
            city,
            pricing_type,
            min_price,
            max_price,
            min_rating,
            search,
            sort_by = 'created_at',
            sort_order = 'desc',
        } = req.query;

        // ─────────────────────────────────────────────────────────────────
        // BUILD WHERE CLAUSE
        // ─────────────────────────────────────────────────────────────────

        const where = { status: 'active' };

        if (category_id) {
            where.category_id = category_id;
        }

        if (city) {
            where.city = { [Op.like]: `%${city}%` };
        }

        if (pricing_type) {
            where.pricing_type = pricing_type;
        }

        if (min_price || max_price) {
            if (pricing_type === 'hourly') {
                where.hourly_rate = {};
                if (min_price) where.hourly_rate[Op.gte] = min_price;
                if (max_price) where.hourly_rate[Op.lte] = max_price;
            } else if (pricing_type === 'fixed') {
                where.fixed_price = {};
                if (min_price) where.fixed_price[Op.gte] = min_price;
                if (max_price) where.fixed_price[Op.lte] = max_price;
            }
        }

        if (min_rating) {
            where.average_rating = { [Op.gte]: min_rating };
        }

        if (search) {
            where[Op.or] = [
                { title: { [Op.like]: `%${search}%` } },
                { description: { [Op.like]: `%${search}%` } },
            ];
        }

        // ─────────────────────────────────────────────────────────────────
        // VALIDATE SORT
        // ─────────────────────────────────────────────────────────────────

        const allowedSortFields = ['created_at', 'average_rating', 'hourly_rate', 'fixed_price', 'view_count'];
        const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
        const sortDirection = sort_order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

        // ─────────────────────────────────────────────────────────────────
        // FETCH LISTINGS
        // ─────────────────────────────────────────────────────────────────

        const { count, rows: listings } = await ServiceListing.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en', 'icon_url'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                },
            ],
            limit,
            offset,
            order: [[sortField, sortDirection]],
        });

        const totalPages = Math.ceil(count / limit);

        // ✅ PARSE JSON FIELDS AND RETURN COMPLETE DATA
        const parsedListings = listings.map(listing => {
            const listingData = parseListingJsonFields(listing);
            return {
                id: listingData.id,
                listing_id: listingData.listing_id,
                provider_id: listingData.provider_id,
                provider_type: listingData.provider_type || 'passenger',
                category_id: listingData.category_id,
                category_name: listingData.category?.name_en || 'Uncategorized',
                subcategory_name: listingData.subcategory_name,
                title: listingData.title,
                description: listingData.description,
                pricing_type: listingData.pricing_type,
                hourly_rate: listingData.hourly_rate,
                minimum_charge: listingData.minimum_charge,
                fixed_price: listingData.fixed_price,
                city: listingData.city,
                neighborhoods: listingData.neighborhoods,
                service_radius_km: listingData.service_radius_km,
                photos: listingData.photos,
                available_days: listingData.available_days,
                available_hours: listingData.available_hours,
                emergency_service: listingData.emergency_service,
                years_experience: listingData.years_experience,
                certifications: listingData.certifications,
                portfolio_links: listingData.portfolio_links,
                status: listingData.status,
                rejection_reason: listingData.rejection_reason,
                approved_by: listingData.approved_by,
                approved_at: listingData.approved_at,
                view_count: listingData.view_count,
                contact_count: listingData.contact_count,
                average_rating: listingData.average_rating,
                total_reviews: listingData.total_reviews,
                createdAt: listingData.createdAt,
                updatedAt: listingData.updatedAt,
                category: listingData.category,
                provider: listingData.provider,
            };
        });

        res.status(200).json({
            success: true,
            message: 'Listings retrieved successfully',
            data: {
                listings: parsedListings
            },
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
        console.error('❌ [SERVICE_LISTING_CONTROLLER] Error in getAllListings:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve moderation. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SINGLE LISTING BY ID (with view count increment)
// GET /api/services/moderation/:id
// ═══════════════════════════════════════════════════════════════════════

exports.getListingById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findOne({
            where: {
                id,
                status: ['active', 'approved'], // Allow viewing approved but not yet active
            },
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en', 'description_en', 'icon_url'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url', 'phone_e164'],
                },
                {
                    model: ServiceRating,
                    as: 'ratings',
                    limit: 5,
                    order: [['created_at', 'DESC']],
                    include: [
                        {
                            model: Account,
                            as: 'customer',
                            attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                        }
                    ]
                }
            ],
        });

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found or not available.',
            });
        }

        // Increment view count
        await listing.increment('view_count');

        // ✅ PARSE JSON FIELDS
        const listingData = parseListingJsonFields(listing);

        res.status(200).json({
            success: true,
            message: 'Listing retrieved successfully',
            data: {
                listing: {
                    id: listingData.id,
                    listing_id: listingData.listing_id,
                    provider_id: listingData.provider_id,
                    provider_type: listingData.provider_type || 'passenger',
                    category_id: listingData.category_id,
                    category_name: listingData.category?.name_en || 'Uncategorized',
                    subcategory_name: listingData.subcategory_name,
                    title: listingData.title,
                    description: listingData.description,
                    pricing_type: listingData.pricing_type,
                    hourly_rate: listingData.hourly_rate,
                    minimum_charge: listingData.minimum_charge,
                    fixed_price: listingData.fixed_price,
                    city: listingData.city,
                    neighborhoods: listingData.neighborhoods,
                    service_radius_km: listingData.service_radius_km,
                    photos: listingData.photos,
                    available_days: listingData.available_days,
                    available_hours: listingData.available_hours,
                    emergency_service: listingData.emergency_service,
                    years_experience: listingData.years_experience,
                    certifications: listingData.certifications,
                    portfolio_links: listingData.portfolio_links,
                    status: listingData.status,
                    rejection_reason: listingData.rejection_reason,
                    approved_by: listingData.approved_by,
                    approved_at: listingData.approved_at,
                    view_count: listingData.view_count + 1,
                    contact_count: listingData.contact_count,
                    booking_count: listingData.booking_count,
                    average_rating: listingData.average_rating,
                    total_reviews: listingData.total_reviews,
                    createdAt: listingData.createdAt,
                    updatedAt: listingData.updatedAt,
                    category: listingData.category,
                    provider: listingData.provider,
                    recent_reviews: listingData.ratings,
                }
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_CONTROLLER] Error in getListingById:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET MY LISTINGS (Provider's own moderation)
// GET /api/services/moderation/my-moderation
// ═══════════════════════════════════════════════════════════════════════

exports.getMyListings = async (req, res) => {
    try {
        const provider_id = req.user.uuid;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { status } = req.query;

        const where = { provider_id };
        if (status) {
            where.status = status;
        }

        const { count, rows: listings } = await ServiceListing.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        const totalPages = Math.ceil(count / limit);

        // ✅ PARSE JSON FIELDS FOR ALL LISTINGS
        const parsedListings = listings.map(listing => {
            const listingData = parseListingJsonFields(listing);

            // Add category_name for Flutter compatibility
            return {
                ...listingData,
                category_name: listingData.category?.name_en || 'Uncategorized',
            };
        });

        res.status(200).json({
            success: true,
            message: 'Your moderation retrieved successfully',
            data: {
                listings: parsedListings
            },
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
        console.error('❌ [SERVICE_LISTING_CONTROLLER] Error in getMyListings:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve your moderation. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE LISTING (Provider only - own moderation)
// PUT /api/services/moderation/:id
// ═══════════════════════════════════════════════════════════════════════

exports.updateListing = async (req, res) => {
    try {
        // ─────────────────────────────────────────────────────────────────
        // PARSE JSON FIELDS FROM MULTIPART/FORM-DATA
        // ─────────────────────────────────────────────────────────────────

        if (req.body.neighborhoods && typeof req.body.neighborhoods === 'string') {
            try {
                req.body.neighborhoods = JSON.parse(req.body.neighborhoods);
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid neighborhoods format. Must be a valid JSON array.',
                });
            }
        }

        if (req.body.available_days && typeof req.body.available_days === 'string') {
            try {
                req.body.available_days = JSON.parse(req.body.available_days);
            } catch (e) {
                req.body.available_days = null;
            }
        }

        if (req.body.portfolio_links && typeof req.body.portfolio_links === 'string') {
            try {
                req.body.portfolio_links = JSON.parse(req.body.portfolio_links);
            } catch (e) {
                req.body.portfolio_links = null;
            }
        }

        const { id } = req.params;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findOne({
            where: { id, provider_id }
        });

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found or you do not have permission to edit it.',
            });
        }

        // Can only edit pending or rejected moderation
        if (!['pending', 'rejected'].includes(listing.status)) {
            return res.status(403).json({
                success: false,
                message: 'Cannot edit active or approved moderation. Please contact support.',
            });
        }

        const {
            title,
            description,
            pricing_type,
            hourly_rate,
            minimum_charge,
            fixed_price,
            city,
            neighborhoods,
            service_radius_km,
            available_days,
            available_hours,
            emergency_service,
            years_experience,
            certifications,
            portfolio_links,
        } = req.body;

        // Handle new photos
        let updatedPhotos = listing.photos || [];

        // ✅ PARSE EXISTING PHOTOS IF STRING
        if (typeof updatedPhotos === 'string') {
            try {
                updatedPhotos = JSON.parse(updatedPhotos);
            } catch (e) {
                updatedPhotos = [];
            }
        }

        if (req.files && req.files.length > 0) {
            if (updatedPhotos.length + req.files.length > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Maximum 5 photos allowed per listing.',
                });
            }

            try {
                for (const file of req.files) {
                    const photoUrl = await uploadFileToR2(file, 'service-moderation');
                    updatedPhotos.push(photoUrl);
                }
            } catch (uploadError) {
                console.error('❌ [SERVICE_LISTING_CONTROLLER] Photo upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload new photos. Please try again.',
                });
            }
        }

        // Update listing
        await listing.update({
            title: title ? title.trim() : listing.title,
            description: description ? description.trim() : listing.description,
            pricing_type: pricing_type || listing.pricing_type,
            hourly_rate: hourly_rate !== undefined ? hourly_rate : listing.hourly_rate,
            minimum_charge: minimum_charge !== undefined ? minimum_charge : listing.minimum_charge,
            fixed_price: fixed_price !== undefined ? fixed_price : listing.fixed_price,
            city: city ? city.trim() : listing.city,
            neighborhoods: neighborhoods !== undefined ? neighborhoods : listing.neighborhoods,
            service_radius_km: service_radius_km !== undefined ? service_radius_km : listing.service_radius_km,
            photos: updatedPhotos.length > 0 ? updatedPhotos : listing.photos,
            available_days: available_days !== undefined ? available_days : listing.available_days,
            available_hours: available_hours !== undefined ? available_hours : listing.available_hours,
            emergency_service: emergency_service !== undefined ? (emergency_service === 'true' || emergency_service === true) : listing.emergency_service,
            years_experience: years_experience !== undefined ? years_experience : listing.years_experience,
            certifications: certifications !== undefined ? certifications : listing.certifications,
            portfolio_links: portfolio_links !== undefined ? portfolio_links : listing.portfolio_links,
            status: 'pending', // Reset to pending for re-approval
        });

        console.log('✅ [SERVICE_LISTING_CONTROLLER] Listing updated:', listing.listing_id);

        res.status(200).json({
            success: true,
            message: 'Listing updated successfully. It will be reviewed again by our team.',
            data: {
                listing: {
                    id: listing.id,
                    listing_id: listing.listing_id,
                    status: listing.status,
                    updated_at: listing.updated_at,
                }
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_CONTROLLER] Error in updateListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to update listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DELETE LISTING (Provider only - own moderation, soft delete)
// DELETE /api/services/moderation/:id
// ═══════════════════════════════════════════════════════════════════════

exports.deleteListing = async (req, res) => {
    try {
        const { id } = req.params;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findOne({
            where: { id, provider_id }
        });

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found or you do not have permission to delete it.',
            });
        }

        // Soft delete
        await listing.destroy();

        console.log('✅ [SERVICE_LISTING_CONTROLLER] Listing deleted:', listing.listing_id);

        res.status(200).json({
            success: true,
            message: 'Listing deleted successfully',
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_CONTROLLER] Error in deleteListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to delete listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;
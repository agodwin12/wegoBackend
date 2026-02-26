const Joi = require('joi');

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY VALIDATION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════

const getCategoriesSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(50),
});

const createCategorySchema = Joi.object({
    name_en: Joi.string().min(2).max(100).required(),
    name_fr: Joi.string().min(2).max(100).required(),
    description_en: Joi.string().min(5).max(500).optional().allow(null, ''),
    description_fr: Joi.string().min(5).max(500).optional().allow(null, ''),
    parent_id: Joi.number().integer().positive().optional().allow(null),
    display_order: Joi.number().integer().min(0).default(0),
    is_active: Joi.boolean().default(true),
});

const updateCategorySchema = Joi.object({
    name_en: Joi.string().min(2).max(100).optional(),
    name_fr: Joi.string().min(2).max(100).optional(),
    description_en: Joi.string().min(5).max(500).optional().allow(null, ''),
    description_fr: Joi.string().min(5).max(500).optional().allow(null, ''),
    parent_id: Joi.number().integer().positive().optional().allow(null),
    display_order: Joi.number().integer().min(0).optional(),
    is_active: Joi.boolean().optional(),
}).min(1);

// ═══════════════════════════════════════════════════════════════════════
// LISTING VALIDATION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════

const getListingsSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    category_id: Joi.number().integer().positive().optional(),
    city: Joi.string().trim().optional(),
    pricing_type: Joi.string().valid('hourly', 'fixed', 'negotiable').optional(),
    min_price: Joi.number().min(0).optional(),
    max_price: Joi.number().min(0).optional(),
    emergency_only: Joi.boolean().optional(),
    sort_by: Joi.string().valid('created_at', 'price', 'rating').default('created_at'),
    sort_order: Joi.string().valid('asc', 'desc').default('desc'),
});

const createListingSchema = Joi.object({
    category_id: Joi.number().integer().positive().required(),
    title: Joi.string().min(3).max(200).trim().required(),
    description: Joi.string().min(5).max(2000).trim().required(),
    pricing_type: Joi.string().valid('hourly', 'fixed', 'negotiable').required(),
    hourly_rate: Joi.when('pricing_type', {
        is: 'hourly',
        then: Joi.number().min(500).required(),
        otherwise: Joi.number().min(500).optional().allow(null),
    }),
    minimum_charge: Joi.when('pricing_type', {
        is: 'hourly',
        then: Joi.number().min(0).required(),
        otherwise: Joi.number().min(0).optional().allow(null),
    }),
    fixed_price: Joi.when('pricing_type', {
        is: 'fixed',
        then: Joi.number().min(500).required(),
        otherwise: Joi.number().min(500).optional().allow(null),
    }),
    city: Joi.string().trim().required(),
    neighborhoods: Joi.alternatives()
        .try(
            Joi.array().items(Joi.string().trim()).min(1),
            Joi.string().custom((value, helpers) => {
                try {
                    const parsed = JSON.parse(value);
                    if (!Array.isArray(parsed) || parsed.length < 1) {
                        return helpers.error('any.invalid');
                    }
                    return parsed;
                } catch (e) {
                    return helpers.error('any.invalid');
                }
            })
        )
        .required()
        .messages({
            'any.invalid': 'Neighborhoods must be a valid array with at least one item',
            'any.required': 'Neighborhoods are required',
        }),
    service_radius_km: Joi.number().min(1).max(100).optional().default(10),
    available_days: Joi.array().items(
        Joi.string().valid('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
    ).optional(),
    emergency_service: Joi.boolean().optional().default(false),
    years_of_experience: Joi.number().integer().min(0).max(50).optional().allow(null),
});

const updateListingSchema = Joi.object({
    title: Joi.string().min(3).max(200).trim().optional(),
    description: Joi.string().min(5).max(2000).trim().optional(),
    pricing_type: Joi.string().valid('hourly', 'fixed', 'negotiable').optional(),
    hourly_rate: Joi.number().min(500).optional().allow(null),
    minimum_charge: Joi.number().min(0).optional().allow(null),
    fixed_price: Joi.number().min(500).optional().allow(null),
    city: Joi.string().trim().optional(),
    neighborhoods: Joi.alternatives()
        .try(
            Joi.array().items(Joi.string().trim()).min(1),
            Joi.string().custom((value, helpers) => {
                try {
                    const parsed = JSON.parse(value);
                    if (!Array.isArray(parsed) || parsed.length < 1) {
                        return helpers.error('any.invalid');
                    }
                    return parsed;
                } catch (e) {
                    return helpers.error('any.invalid');
                }
            })
        )
        .optional()
        .messages({
            'any.invalid': 'Neighborhoods must be a valid array with at least one item',
        }),
    service_radius_km: Joi.number().min(1).max(100).optional(),
    available_days: Joi.array().items(
        Joi.string().valid('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
    ).optional(),
    emergency_service: Joi.boolean().optional(),
    years_of_experience: Joi.number().integer().min(0).max(50).optional().allow(null),
    is_active: Joi.boolean().optional(),
}).min(1);

// ═══════════════════════════════════════════════════════════════════════
// REQUEST VALIDATION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════

const createRequestSchema = Joi.object({
    listing_id: Joi.number().integer().positive().required(),
    description: Joi.string().min(5).max(1000).trim().required(),
    needed_when: Joi.string().valid('asap', 'today', 'tomorrow', 'scheduled').required(),
    scheduled_date: Joi.when('needed_when', {
        is: 'scheduled',
        then: Joi.date().iso().greater('now').required(),
        otherwise: Joi.date().iso().optional().allow(null),
    }),
    scheduled_time: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).optional().allow(null, ''),
    service_location: Joi.string().min(3).max(500).trim().required(),
    estimated_budget: Joi.number().min(0).optional().allow(null),
});

const getRequestsSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    status: Joi.string().valid(
        'pending',
        'accepted',
        'rejected',
        'cancelled',
        'in_progress',
        'completed',
        'payment_pending',
        'payment_confirmation_pending',
        'payment_confirmed'
    ).optional(),
    role: Joi.string().valid('customer', 'provider').optional(),
});

const acceptRequestSchema = Joi.object({
    provider_response: Joi.string().max(500).optional().allow(null, ''),
});

const rejectRequestSchema = Joi.object({
    rejection_reason: Joi.string().min(3).max(500).required(),
});

const updateRequestStatusSchema = Joi.object({
    status: Joi.string().valid(
        'accepted',
        'rejected',
        'cancelled',
        'in_progress',
        'completed',
        'payment_pending',
        'payment_confirmation_pending',
        'payment_confirmed'
    ).required(),
    provider_response: Joi.string().min(1).max(500).optional().allow(null, ''),
    rejection_reason: Joi.when('status', {
        is: 'rejected',
        then: Joi.string().min(3).max(500).required(),
        otherwise: Joi.forbidden(),
    }),
    cancellation_reason: Joi.when('status', {
        is: 'cancelled',
        then: Joi.string().min(3).max(500).required(),
        otherwise: Joi.forbidden(),
    }),
});

const completeServiceSchema = Joi.object({
    work_summary: Joi.string().min(3).max(1000).optional().allow(null, ''),
    hours_worked: Joi.number().min(0).max(24).optional().allow(null),
    materials_cost: Joi.number().min(0).optional().allow(null),
    final_amount: Joi.number().min(100).required(),
});

const uploadPaymentProofSchema = Joi.object({
    payment_method: Joi.string().valid('mtn_mobile_money', 'orange_money', 'cash').required(),
    payment_reference: Joi.string().max(100).optional().allow(null, ''),
});

const cancelRequestSchema = Joi.object({
    cancellation_reason: Joi.string().min(3).max(500).required(),
});

// ═══════════════════════════════════════════════════════════════════════
// RATING VALIDATION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════

const createRatingSchema = Joi.object({
    request_id: Joi.number().integer().positive().required(),
    rating: Joi.number().integer().min(1).max(5).required(),
    review_text: Joi.string().min(3).max(500).optional().allow(null, ''),
    quality_rating: Joi.number().integer().min(1).max(5).optional().allow(null),
    professionalism_rating: Joi.number().integer().min(1).max(5).optional().allow(null),
    communication_rating: Joi.number().integer().min(1).max(5).optional().allow(null),
    value_rating: Joi.number().integer().min(1).max(5).optional().allow(null),
});

const getRatingsSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    listing_id: Joi.number().integer().positive().optional(),
    provider_id: Joi.number().integer().positive().optional(),
});

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    getCategories: getCategoriesSchema,
    createCategory: createCategorySchema,
    updateCategory: updateCategorySchema,
    getListings: getListingsSchema,
    createListing: createListingSchema,
    updateListing: updateListingSchema,
    getRequests: getRequestsSchema,
    createRequest: createRequestSchema,
    acceptRequest: acceptRequestSchema,
    rejectRequest: rejectRequestSchema,
    updateRequestStatus: updateRequestStatusSchema,
    completeService: completeServiceSchema,
    uploadPaymentProof: uploadPaymentProofSchema,
    cancelRequest: cancelRequestSchema,
    getRatings: getRatingsSchema,
    createRating: createRatingSchema,
};
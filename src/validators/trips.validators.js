const Joi = require('joi');

const coords = Joi.object({
    lat: Joi.number().required().min(-90).max(90),
    lng: Joi.number().required().min(-180).max(180),
});

exports.estimateSchema = Joi.object({
    pickup: coords.required(),
    dropoff: coords.required(),
});

exports.createSchema = Joi.object({
    pickup: coords.required(),
    dropoff: coords.required(),
    payment_method: Joi.string().valid('cash','momo','om').default('cash')
});

exports.cancelSchema = Joi.object({
    reason: Joi.string().max(120).allow('', null),
});

exports.historySchema = Joi.object({
    status: Joi.string().valid('active','completed','canceled','all').default('all'),
    limit: Joi.number().integer().min(1).max(50).default(20),
    cursor: Joi.string().allow(null, ''),
});

// src/controllers/promotionsController.js

const Coupon = require('../models/Coupon');
const { Op } = require('sequelize');

/**
 * POST /promotions/validate
 *
 * Validates a coupon code against a fare estimate and returns
 * the full price breakdown: original fare, discount, and final fare.
 *
 * Body: { code: string, fare_estimate: number }
 * Auth: authenticate (passenger or driver)
 */

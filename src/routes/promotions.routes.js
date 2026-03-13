// src/routes/promotions.routes.js

const express = require('express');
const router = express.Router();
const { validateCoupon } = require('../controllers/promotionsController');
const { authenticate } = require('../middleware/auth.middleware');



module.exports = router;
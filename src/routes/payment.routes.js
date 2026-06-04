// src/routes/payment.routes.js
'use strict';

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const { initiate, checkStatus, getHistory } = require('../controllers/payment/initiatePayment.controller');

router.post('/initiate',            authenticate, initiate);
router.get('/history',              authenticate, getHistory);
router.get('/:campayRef/status',    authenticate, checkStatus);

module.exports = router;
const { body } = require('express-validator');

const commonAccountFields = [
    body('password').isString().isLength({ min: 8 }),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Invalid email'),
    body('phone_e164').optional({ values: 'falsy' }).isString().isLength({ min: 6, max: 32 }),
    body('first_name').optional().isString().isLength({ max: 100 }),
    body('last_name').optional().isString().isLength({ max: 100 }),
];

const passengerSignupRules = [
    ...commonAccountFields,
    body().custom((_, { req }) => {
        if (!req.body.email && !req.body.phone_e164) {
            throw new Error('Either email or phone_e164 is required');
        }
        return true;
    }),
];

const driverSignupRules = [
    ...commonAccountFields,
    body('cni_number').isString().notEmpty(),
    body('license_number').isString().notEmpty(),
    body('license_expiry').isISO8601().toDate(),
    body().custom((_, { req }) => {
        if (!req.body.email && !req.body.phone_e164) {
            throw new Error('Either email or phone_e164 is required');
        }
        return true;
    }),
];

const sendOtpRules = [
    body('purpose').isIn(['PHONE_VERIFY','EMAIL_VERIFY']).withMessage('Invalid purpose'),
    body('channel').isIn(['SMS','EMAIL']).withMessage('Invalid channel'),
    body('identifier')
        .isString().notEmpty()
        .withMessage('identifier (email or phone_e164) required'),
];

const verifyOtpRules = [
    body('purpose').isIn(['PHONE_VERIFY','EMAIL_VERIFY']).withMessage('Invalid purpose'),
    body('identifier').isString().notEmpty(),
    body('code').isString().isLength({ min: 4, max: 8 })
];

module.exports = { passengerSignupRules, driverSignupRules, sendOtpRules, verifyOtpRules };

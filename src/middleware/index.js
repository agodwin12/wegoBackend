const auth = require('./auth.middleware');
const driverVerified = require('./driver.middleware');
const { upload, processAvatar } = require('./upload');
const errorHandler = require('./error');

module.exports = { auth, driverVerified, upload, processAvatar, errorHandler };

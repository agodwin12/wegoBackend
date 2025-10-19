// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
    console.error(err);
    const code = err.status || 500;
    res.status(code).json({ error: err.message || 'Internal Server Error' });
};

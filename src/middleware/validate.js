module.exports = (schema) => (req, res, next) => {
    const target = ['POST','PUT','PATCH'].includes(req.method) ? req.body : req.query;
    const { error, value } = schema.validate(target, { abortEarly: false, stripUnknown: true });
    if (error) {
        return res.status(422).json({
            error: 'VALIDATION_ERROR',
            details: error.details.map(d => ({ message: d.message, path: d.path }))
        });
    }
    if (['POST','PUT','PATCH'].includes(req.method)) req.body = value; else req.query = value;
    next();
};

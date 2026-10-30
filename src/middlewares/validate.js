const ApiError = require('../utils/ApiError');

/**
 * Validates req.{body,query,params} against a Zod schema shaped as
 * z.object({ body: ..., query: ..., params: ... }). Any block the schema
 * doesn't define is left untouched.
 */
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return next(ApiError.badRequest('Validation failed', details));
  }

  // Overwrite with parsed (and defaulted/coerced) values.
  if (result.data.body) req.body = result.data.body;
  if (result.data.query) req.query = result.data.query;
  if (result.data.params) req.params = result.data.params;

  next();
};

module.exports = validate;

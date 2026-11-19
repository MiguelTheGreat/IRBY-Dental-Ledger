'use strict';

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

class ValidationError extends HttpError {
  constructor(fields, message = 'Please correct the highlighted fields.', code = 'VALIDATION_FAILED') {
    super(422, code, message, { fields });
  }
}

const notFound = (what = 'Record') => new HttpError(404, 'NOT_FOUND', `${what} not found.`);

/** Collects field errors and throws one ValidationError at the end. */
class Checker {
  constructor() { this.fields = {}; }
  fail(field, message) { if (!this.fields[field]) this.fields[field] = message; return this; }
  ok() { return Object.keys(this.fields).length === 0; }
  throwIfAny(message) { if (!this.ok()) throw new ValidationError(this.fields, message); }
}

/** Trimmed string or '' (null/undefined become ''). */
function str(v) {
  return v == null ? '' : String(v).trim();
}

module.exports = { HttpError, ValidationError, notFound, Checker, str };

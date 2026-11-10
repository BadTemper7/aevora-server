/** An error we expect and can describe to the client. */
export class AppError extends Error {
  constructor(message, statusCode = 500, { code, details } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

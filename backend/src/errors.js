export class AppError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly fieldErrors?: Record<string, string[]>;

  constructor(statusCode: number, message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.fieldErrors = fieldErrors;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  static badRequest(message = 'Bad request', fieldErrors?: Record<string, string[]>): ApiError {
    return new ApiError(400, message, fieldErrors);
  }

  static unauthorized(message = 'Unauthorized'): ApiError {
    return new ApiError(401, message);
  }

  static forbidden(message = 'Forbidden'): ApiError {
    return new ApiError(403, message);
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(404, message);
  }

  static conflict(message = 'Conflict'): ApiError {
    return new ApiError(409, message);
  }

  static gone(message = 'Gone'): ApiError {
    return new ApiError(410, message);
  }

  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(500, message);
  }
}

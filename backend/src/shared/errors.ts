export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'REQUEST_FAILED',
  ) {
    super(message)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected failure'
}

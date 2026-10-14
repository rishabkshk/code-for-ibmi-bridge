import * as http from 'http';
import * as crypto from 'crypto';

export const TOKEN_HEADER = 'x-codeforibmi-token';
export const AUTH_ERROR_RESPONSE = JSON.stringify({ error: 'Invalid or missing bridge token' });

/**
 * Validates a token using timing-safe comparison.
 */
export function validateToken(providedToken: string | undefined | string[], expectedToken: string): boolean {
  if (!providedToken) {
    return false;
  }

  const tokenStr = Array.isArray(providedToken) ? providedToken[0] : providedToken;
  if (typeof tokenStr !== 'string' || tokenStr.trim().length === 0) {
    return false;
  }

  const providedBuffer = Buffer.from(tokenStr.trim(), 'utf-8');
  const expectedBuffer = Buffer.from(expectedToken.trim(), 'utf-8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Validates the authentication header for an incoming HTTP request.
 * If invalid, responds immediately with 401 Unauthorized and returns false.
 */
export function authenticateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expectedToken: string
): boolean {
  const headerToken = req.headers[TOKEN_HEADER];

  if (!validateToken(headerToken, expectedToken)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(AUTH_ERROR_RESPONSE);
    return false;
  }

  return true;
}

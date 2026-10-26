import * as http from 'http';
import * as crypto from 'crypto';

export const TOKEN_HEADER = 'x-codeforibmi-token';
export const AUTH_ERROR_RESPONSE = JSON.stringify({ error: 'Invalid or missing bridge token' });

export const CLIENT_HEADER = 'x-codeforibmi-client';
export const EXPECTED_CLIENT = 'codefori-cli';
export const CLIENT_ERROR_RESPONSE = JSON.stringify({
  error: "Direct raw curl/HTTP access to the bridge server is disabled. Please use the official 'codefori' CLI command instead (e.g., 'codefori status' or 'codefori run-action').",
  cliCommand: 'codefori',
  reason: 'Direct raw curl calls bypass security guardrails and parameter escaping. Use the official codefori CLI.'
});

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

/**
 * Validates that requests originate from the official CLI (codefori / codefori.sh)
 * when requireCliClient is enabled.
 */
export function validateClientHeader(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requireCliClient: boolean = true
): boolean {
  if (!requireCliClient) {
    return true;
  }

  const clientHeader = req.headers[CLIENT_HEADER];
  const userAgent = req.headers['user-agent'] || '';

  const clientVal = Array.isArray(clientHeader) ? clientHeader[0] : clientHeader;
  const isCliHeader = typeof clientVal === 'string' && clientVal.trim().toLowerCase() === EXPECTED_CLIENT;
  const isCliUserAgent = typeof userAgent === 'string' && userAgent.toLowerCase().includes('codefori');

  if (!isCliHeader && !isCliUserAgent) {
    res.writeHead(403, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(CLIENT_ERROR_RESPONSE);
    return false;
  }

  return true;
}

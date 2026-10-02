/**
 * @file logger.ts
 * @description Winston logger configuration.
 * Outputs structured JSON in production, colorized text in development.
 */

import winston from 'winston';

const { combine, timestamp, json, colorize, printf, errors } = winston.format;

const isProduction = process.env['NODE_ENV'] === 'production';

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${ts} [${level}] ${message}${metaStr}`;
  }),
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json(),
);

export const logger = winston.createLogger({
  level:       process.env['LOG_LEVEL'] ?? (isProduction ? 'info' : 'debug'),
  format:      isProduction ? prodFormat : devFormat,
  transports:  [new winston.transports.Console()],
  // In production, add file transport or cloud logging transport here
});

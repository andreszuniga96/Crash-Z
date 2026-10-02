/**
 * @file validation.ts
 * @description Lightweight request validation middleware factory.
 *
 * Design choice: Custom validator instead of Zod/Joi to keep the bundle minimal.
 * Each validator function receives the request body and returns an array of
 * error strings. An empty array = valid.
 *
 * Usage:
 *   router.post('/register', validate(registerSchema), registerHandler);
 */

import { Request, Response, NextFunction } from 'express';
import {
  MIN_ADJUSTMENT_CENTS,
  MAX_ADJUSTMENT_CENTS,
} from '../game/limits';

// ─── Schema Types ─────────────────────────────────────────────────────────────

type FieldValidator = (value: unknown, body: Record<string, unknown>) => string | null;

export interface FieldSchema {
  required?:  boolean;
  validator?: FieldValidator;
}

export type ValidationSchema = Record<string, FieldSchema>;

// ─── Built-in Validators ──────────────────────────────────────────────────────

export const V = {
  string: (min = 1, max = 255): FieldValidator =>
    (v) => {
      if (typeof v !== 'string') return 'Must be a string';
      if (v.trim().length < min) return `Must be at least ${min} characters`;
      if (v.trim().length > max) return `Must be at most ${max} characters`;
      return null;
    },

  email: (): FieldValidator =>
    (v) => {
      if (typeof v !== 'string') return 'Must be a string';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Must be a valid email address';
      return null;
    },

  number: (min?: number, max?: number): FieldValidator =>
    (v) => {
      if (typeof v !== 'number' || isNaN(v)) return 'Must be a number';
      if (min !== undefined && v < min) return `Must be at least ${min}`;
      if (max !== undefined && v > max) return `Must be at most ${max}`;
      return null;
    },

  integer: (min?: number, max?: number): FieldValidator =>
    (v) => {
      if (typeof v !== 'number' || !Number.isInteger(v)) return 'Must be an integer';
      if (min !== undefined && v < min) return `Must be at least ${min}`;
      if (max !== undefined && v > max) return `Must be at most ${max}`;
      return null;
    },

  enum: (...values: string[]): FieldValidator =>
    (v) => {
      if (!values.includes(String(v))) return `Must be one of: ${values.join(', ')}`;
      return null;
    },

  uuid: (): FieldValidator =>
    (v) => {
      if (typeof v !== 'string') return 'Must be a string';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) {
        return 'Must be a valid UUID v4';
      }
      return null;
    },

  mongoId: (): FieldValidator =>
    (v) => {
      if (typeof v !== 'string' || !/^[0-9a-f]{24}$/.test(v)) return 'Must be a valid MongoDB ObjectId';
      return null;
    },

  boolean: (): FieldValidator =>
    (v) => {
      if (typeof v !== 'boolean') return 'Must be a boolean';
      return null;
    },
};

// ─── Middleware Factory ────────────────────────────────────────────────────────

/**
 * Creates an Express middleware that validates request.body against a schema.
 * Returns 400 with an array of field-level errors if validation fails.
 */
export function validate(schema: ValidationSchema) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const body   = (req.body ?? {}) as Record<string, unknown>;
    const errors: Record<string, string> = {};

    for (const [field, rules] of Object.entries(schema)) {
      const value = body[field];

      if (value === undefined || value === null || value === '') {
        if (rules.required) {
          errors[field] = `${field} is required`;
        }
        continue;
      }

      if (rules.validator) {
        const err = rules.validator(value, body);
        if (err) errors[field] = err;
      }
    }

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ error: 'Validation failed', fields: errors });
      return;
    }

    next();
  };
}

// ─── Reusable Schemas ─────────────────────────────────────────────────────────

export const registerSchema: ValidationSchema = {
  username: { required: true,  validator: V.string(3, 32)   },
  email:    { required: true,  validator: V.email()          },
  password: { required: true,  validator: V.string(8, 72)   },
};

export const loginSchema: ValidationSchema = {
  email:    { required: true, validator: V.email()        },
  password: { required: true, validator: V.string(1, 72)  },
};

export const balanceAdjustSchema: ValidationSchema = {
  // Bounds come from the admin limits, NOT from the betting table limits.
  amountCents: {
    required:  true,
    validator: V.integer(MIN_ADJUSTMENT_CENTS, MAX_ADJUSTMENT_CENTS),
  },
  type:        { required: true,  validator: V.enum('deposit', 'withdrawal') },
  note:        { required: false, validator: V.string(1, 500) },
};

export const updateUserStatusSchema: ValidationSchema = {
  status: { required: true, validator: V.enum('active', 'suspended', 'banned') },
};

export const paginationSchema: ValidationSchema = {
  page:  { required: false, validator: V.integer(1, 10_000) },
  limit: { required: false, validator: V.integer(1, 100) },
};

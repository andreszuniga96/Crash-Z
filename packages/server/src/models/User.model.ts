/**
 * @file User.model.ts
 * @description Mongoose model for platform users.
 * Supports roles (player / admin), JWT-compatible structure,
 * bcrypt-hashed passwords, and balance management.
 */

import { Schema, model, Document, Model, Types } from 'mongoose';

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum UserRole {
  PLAYER = 'player',
  ADMIN  = 'admin',
}

export enum AccountStatus {
  ACTIVE    = 'active',
  SUSPENDED = 'suspended',
  BANNED    = 'banned',
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Represents a single financial transaction entry in the embedded audit trail.
 * Kept lightweight; a full ledger collection can reference these.
 */
export interface IBalanceTransaction {
  _id:        Types.ObjectId;
  amount:     number;    // positive = credit, negative = debit (USD cents integer)
  type:       'deposit' | 'withdrawal' | 'bet' | 'win' | 'admin_adjustment';
  referenceId?: string;  // GameRound._id or external tx id
  note?:      string;    // admin note
  createdAt:  Date;
}

export interface IUser extends Document {
  _id:                Types.ObjectId;
  username:           string;
  email:              string;
  passwordHash:       string;
  role:               UserRole;
  status:             AccountStatus;
  /** Balance stored as integer cents to avoid floating-point errors (e.g. $10.50 → 1050) */
  balanceCents:       number;
  /** Provably Fair: client-generated seed contributed to the HMAC chain */
  clientSeed:         string;
  /** Number of rounds this client seed has been used (nonce) */
  nonce:              number;
  transactions:       IBalanceTransaction[];
  lastLoginAt?:       Date;
  ipHistory:          string[];
  createdAt:          Date;
  updatedAt:          Date;
  /** Virtual: balance as decimal currency units (COP pesos, 2 decimals kept for exactness) */
  balanceCOP:         number;
}

export interface IUserModel extends Model<IUser> {
  /** Find active (non-suspended, non-banned) user by email */
  findActiveByEmail(email: string): Promise<IUser | null>;
}

// ─── Sub-Schemas ──────────────────────────────────────────────────────────────

const BalanceTransactionSchema = new Schema<IBalanceTransaction>(
  {
    amount:      { type: Number, required: true },
    type:        {
      type:     String,
      enum:     ['deposit', 'withdrawal', 'bet', 'win', 'admin_adjustment'],
      required: true,
    },
    referenceId: { type: String },
    note:        { type: String, maxlength: 500 },
    createdAt:   { type: Date, default: () => new Date() },
  },
  { _id: true, versionKey: false },
);

// ─── Main Schema ──────────────────────────────────────────────────────────────

const UserSchema = new Schema<IUser, IUserModel>(
  {
    username: {
      type:      String,
      required:  true,
      unique:    true,
      trim:      true,
      minlength: 3,
      maxlength: 32,
      match:     /^[a-zA-Z0-9_-]+$/,
      index:     true,
    },
    email: {
      type:      String,
      required:  true,
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      index:     true,
    },
    passwordHash: {
      type:     String,
      required: true,
      select:   false, // Never returned in queries unless explicitly requested
    },
    role: {
      type:    String,
      enum:    Object.values(UserRole),
      default: UserRole.PLAYER,
    },
    status: {
      type:    String,
      enum:    Object.values(AccountStatus),
      default: AccountStatus.ACTIVE,
      index:   true,
    },
    balanceCents: {
      type:    Number,
      default: 0,
      min:     0,
      // MongoDB will enforce this at document level, app layer enforces at tx level
    },
    clientSeed: {
      type:    String,
      default: () => Math.random().toString(36).slice(2) + Date.now().toString(36),
    },
    nonce: {
      type:    Number,
      default: 0,
      min:     0,
    },
    transactions: {
      type:    [BalanceTransactionSchema],
      default: [],
      // Index the subdocument array for range queries
    },
    lastLoginAt: { type: Date },
    ipHistory:   {
      type:    [String],
      default: [],
      // Store last 20 IPs only — trimmed in pre-save hook
    },
  },
  {
    timestamps: true,
    versionKey: '__v',
    toJSON:  { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─── Virtuals ─────────────────────────────────────────────────────────────────

// Named balanceCOP (not balanceUSD): the platform's only currency is the Colombian peso,
// so every field that carries money must say so. balanceCents stays the integer source of truth.
UserSchema.virtual('balanceCOP').get(function (this: IUser) {
  return this.balanceCents / 100;
});

// ─── Pre-save hooks ───────────────────────────────────────────────────────────

UserSchema.pre<IUser>('save', function (next) {
  // Keep only last 20 IPs to cap document size
  if (this.ipHistory.length > 20) {
    this.ipHistory = this.ipHistory.slice(-20);
  }
  // Keep only last 500 transaction entries inline (older ones should be archived)
  if (this.transactions.length > 500) {
    this.transactions = this.transactions.slice(-500);
  }
  next();
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

UserSchema.index({ role: 1, status: 1 });
UserSchema.index({ createdAt: -1 });

// ─── Static Methods ───────────────────────────────────────────────────────────

UserSchema.static('findActiveByEmail', function (email: string) {
  return this.findOne({ email: email.toLowerCase(), status: AccountStatus.ACTIVE })
    .select('+passwordHash') // explicitly include the excluded field
    .exec();
});

// ─── Export ───────────────────────────────────────────────────────────────────

export const UserModel = model<IUser, IUserModel>('User', UserSchema);

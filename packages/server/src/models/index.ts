/**
 * @file index.ts
 * @description Barrel export for all Mongoose models.
 * Import from here to avoid circular dependencies.
 */

export { UserModel, UserRole, AccountStatus } from './User.model';
export type { IUser, IUserModel, IBalanceTransaction } from './User.model';

export { GameRoundModel, RoundStatus } from './GameRound.model';
export type { IGameRound } from './GameRound.model';

export { BetModel, BetStatus } from './Bet.model';
export type { IBet } from './Bet.model';

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const staff = sqliteTable('staff', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code'),
  loginEmail: text('login_email'),
  userId: text('user_id'),
  passwordHash: text('password_hash'),
  isAdmin: integer('is_admin').notNull().default(0),
}, (table) => [uniqueIndex('idx_staff_code').on(table.code), uniqueIndex('idx_staff_login_email').on(table.loginEmail), uniqueIndex('idx_staff_user_id').on(table.userId)]);
export const washes = sqliteTable('washes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  staffId: text('staff_id').references(() => staff.id),
  washedAt: integer('washed_at').notNull(),
}, (table) => [index('idx_washes_user_time').on(table.userId, table.washedAt), index('idx_washes_staff_time').on(table.staffId, table.washedAt)]);

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  staffId: text('staff_id').notNull().references(() => staff.id),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('idx_sessions_staff').on(table.staffId)]);
export const loginAttempts = sqliteTable('login_attempts', {
  bucket: text('bucket').primaryKey(),
  attempts: integer('attempts').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
export const passwordResets = sqliteTable('password_resets', {
  tokenHash: text('token_hash').primaryKey(),
  staffId: text('staff_id').notNull().references(() => staff.id),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('idx_password_resets_staff').on(table.staffId)]);
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

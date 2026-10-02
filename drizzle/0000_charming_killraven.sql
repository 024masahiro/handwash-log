CREATE TABLE `washes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`washed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_washes_user_time` ON `washes` (`user_id`,`washed_at`);
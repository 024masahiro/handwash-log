CREATE TABLE `login_attempts` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_staff` ON `sessions` (`staff_id`);--> statement-breakpoint
ALTER TABLE `staff` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `is_admin` integer DEFAULT 0 NOT NULL;
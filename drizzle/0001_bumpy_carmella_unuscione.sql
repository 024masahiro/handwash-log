CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_staff_code` ON `staff` (`code`);--> statement-breakpoint
ALTER TABLE `washes` ADD `staff_id` text REFERENCES staff(id);--> statement-breakpoint
CREATE INDEX `idx_washes_staff_time` ON `washes` (`staff_id`,`washed_at`);
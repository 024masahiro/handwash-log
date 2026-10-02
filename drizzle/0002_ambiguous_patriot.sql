ALTER TABLE `staff` ADD `login_email` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `user_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_staff_login_email` ON `staff` (`login_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_staff_user_id` ON `staff` (`user_id`);
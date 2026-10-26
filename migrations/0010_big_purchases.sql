CREATE TABLE `plan_events` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`month` text NOT NULL,
	`yearly` integer DEFAULT false NOT NULL,
	`until_month` text,
	`goal_id` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plan_events_household` ON `plan_events` (`household_id`);--> statement-breakpoint
ALTER TABLE `goals` ADD `loan_minor` integer;--> statement-breakpoint
ALTER TABLE `goals` ADD `loan_rate_bp` integer;--> statement-breakpoint
ALTER TABLE `goals` ADD `loan_months` integer;
CREATE TABLE `goal_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`done_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `goal_parts_goal` ON `goal_parts` (`goal_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `opening_balance_minor` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `opening_balance_date` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `balance_snoozed_for` text;--> statement-breakpoint
ALTER TABLE `goal_contributions` ADD `note` text;--> statement-breakpoint
ALTER TABLE `goal_contributions` ADD `member_id` text REFERENCES members(id);--> statement-breakpoint
ALTER TABLE `goals` ADD `kind` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `note` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `statement_emails` ADD `verify_code` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `confirmed_at` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `confirmed_line_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `goal_id` text;
-- Lines already in the book from a bank were confirmed by it.
UPDATE `transactions` SET `confirmed_at` = `created_at` WHERE `source` IN ('email', 'csv') AND `confirmed_at` IS NULL;

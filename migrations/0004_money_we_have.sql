ALTER TABLE `accounts` ADD `institution` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `goal_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `principal_minor` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `rate_bp` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `start_date` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `end_date` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `deposit_payout` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `settle_account_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `installment_minor` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `installment_day` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `closed_at` text;--> statement-breakpoint
ALTER TABLE `households` ADD `typical_income_minor` integer;--> statement-breakpoint
ALTER TABLE `households` ADD `typical_spend_minor` integer;
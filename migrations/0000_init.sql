CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`owner_member_id` text,
	`is_shared` integer DEFAULT true NOT NULL,
	`statement_sender_pattern` text,
	`last_statement_balance_minor` integer,
	`last_statement_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_household` ON `accounts` (`household_id`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`category_id` text NOT NULL,
	`month` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`rollover` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_household_cat_month` ON `budgets` (`household_id`,`category_id`,`month`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'want' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `categories_household` ON `categories` (`household_id`);--> statement-breakpoint
CREATE TABLE `forecast_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`computed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`horizon_months` integer DEFAULT 12 NOT NULL,
	`series` text NOT NULL,
	`safe_to_spend_minor` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `forecast_household_computed` ON `forecast_snapshots` (`household_id`,`computed_at`);--> statement-breakpoint
CREATE TABLE `goal_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`transaction_id` text,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `goal_contributions_goal` ON `goal_contributions` (`goal_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`target_minor` integer NOT NULL,
	`target_date` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`linked_account_id` text,
	`monthly_plan_minor` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `goals_household` ON `goals` (`household_id`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`month_start_day` integer DEFAULT 1 NOT NULL,
	`inbound_token` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `households_inbound_token_unique` ON `households` (`inbound_token`);--> statement-breakpoint
CREATE TABLE `import_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`statement_email_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`parsed_date` text,
	`parsed_amount_minor` integer,
	`parsed_description` text,
	`confidence` integer DEFAULT 0 NOT NULL,
	`suggested_category_id` text,
	`match_transaction_id` text,
	`decision` text DEFAULT 'pending' NOT NULL,
	`decided_by_member_id` text,
	`decided_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_email_id`) REFERENCES `statement_emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`match_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_lines_statement` ON `import_lines` (`statement_email_id`);--> statement-breakpoint
CREATE TABLE `income_streams` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`owner_member_id` text,
	`cadence` text NOT NULL,
	`expected_net_minor` integer NOT NULL,
	`variability` text DEFAULT 'fixed' NOT NULL,
	`next_expected_at` text,
	`last_received_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `income_household` ON `income_streams` (`household_id`);--> statement-breakpoint
CREATE TABLE `magic_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `magic_links_token_hash_unique` ON `magic_links` (`token_hash`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`color` text DEFAULT '#0E7C72' NOT NULL,
	`invited_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`joined_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_household_email` ON `members` (`household_id`,`email`);--> statement-breakpoint
CREATE INDEX `members_user` ON `members` (`user_id`);--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`display_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`default_category_id` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_household_norm` ON `merchants` (`household_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `recurring_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`cadence` text NOT NULL,
	`next_run` text NOT NULL,
	`end_date` text,
	`account_id` text,
	`category_id` text,
	`merchant_id` text,
	`price_history` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_household` ON `recurring_rules` (`household_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `statement_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text,
	`message_id` text,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`raw_size` integer DEFAULT 0 NOT NULL,
	`r2_key` text NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`parser_key` text,
	`status` text DEFAULT 'received' NOT NULL,
	`error` text,
	`processed_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `statement_emails_household_received` ON `statement_emails` (`household_id`,`received_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `statement_emails_household_message` ON `statement_emails` (`household_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`title` text NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`est_monthly_saving_minor` integer DEFAULT 0 NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`impact_tier` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`snoozed_until` text,
	`verified_saving_minor` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `suggestions_household_status` ON `suggestions` (`household_id`,`status`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`direction` text NOT NULL,
	`merchant_id` text,
	`category_id` text,
	`paid_by_member_id` text,
	`is_personal` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`import_line_id` text,
	`dedupe_hash` text,
	`transfer_pair_id` text,
	`note` text,
	`voided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transactions_household_date` ON `transactions` (`household_id`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_dedupe` ON `transactions` (`household_id`,`dedupe_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
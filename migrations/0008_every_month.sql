CREATE TABLE `recurring` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`day_of_month` integer NOT NULL,
	`category_id` text,
	`account_id` text,
	`note` text,
	`active` integer DEFAULT true NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_household` ON `recurring` (`household_id`);--> statement-breakpoint
CREATE TABLE `recurring_months` (
	`recurring_id` text NOT NULL,
	`month` text NOT NULL,
	`state` text NOT NULL,
	`member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`recurring_id`, `month`),
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `recurring_id` text;
ALTER TABLE `accounts` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `note` text;--> statement-breakpoint
ALTER TABLE `goal_contributions` ADD `kind` text DEFAULT 'saved' NOT NULL;
CREATE TABLE `idempotency_keys` (
	`household_id` text NOT NULL,
	`key` text NOT NULL,
	`status` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`household_id`, `key`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created` ON `idempotency_keys` (`created_at`);
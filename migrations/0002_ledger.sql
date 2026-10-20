ALTER TABLE `accounts` ADD `csv_mapping` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `description` text;--> statement-breakpoint
CREATE INDEX `transactions_account_date` ON `transactions` (`account_id`,`date`);
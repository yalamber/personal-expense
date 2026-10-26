ALTER TABLE `households` ADD `ai_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `import_lines` ADD `suggested_by` text;
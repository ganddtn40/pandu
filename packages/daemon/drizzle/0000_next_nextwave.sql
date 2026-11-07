CREATE TABLE `arena_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_session_id` text,
	`source_step_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`output_text` text,
	`diff_text` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`cost_known` integer DEFAULT false NOT NULL,
	`latency_ms` integer,
	`ttft_ms` integer,
	`tests_passed` integer,
	`trust_score` integer,
	`baseline_cost_usd` real,
	`savings_percent` real,
	`error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `arena_runs_session_idx` ON `arena_runs` (`source_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `arena_runs_status_idx` ON `arena_runs` (`status`);--> statement-breakpoint
CREATE TABLE `brain_drift_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`output_id` text NOT NULL,
	`detected_at` integer NOT NULL,
	`expected_checksum` text NOT NULL,
	`actual_checksum` text NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`output_id`) REFERENCES `brain_outputs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_drift_events_project_idx` ON `brain_drift_events` (`project_id`,`detected_at`);--> statement-breakpoint
CREATE TABLE `brain_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`format` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`checksum` text NOT NULL,
	`source_checksum` text NOT NULL,
	`synced_at` integer,
	`drift_detected` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_outputs_project_path_unique` ON `brain_outputs` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `brain_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`checksum` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_sources_project_path_unique` ON `brain_sources` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `budget_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`period` text NOT NULL,
	`project_id` text,
	`session_id` text,
	`limit_usd` real NOT NULL,
	`enforcement` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `budget_policies_scope_idx` ON `budget_policies` (`scope`,`period`);--> statement-breakpoint
CREATE INDEX `budget_policies_enabled_idx` ON `budget_policies` (`enabled`);--> statement-breakpoint
CREATE TABLE `cheat_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`trust_score` integer NOT NULL,
	`grade` text NOT NULL,
	`findings_count` integer DEFAULT 0 NOT NULL,
	`files_examined` integer DEFAULT 0 NOT NULL,
	`generated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cheat_analyses_session_idx` ON `cheat_analyses` (`session_id`,`generated_at`);--> statement-breakpoint
CREATE TABLE `cheat_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`detector` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`evidence` text NOT NULL,
	`suggestion` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `cheat_analyses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cheat_findings_analysis_idx` ON `cheat_findings` (`analysis_id`);--> statement-breakpoint
CREATE INDEX `cheat_findings_session_idx` ON `cheat_findings` (`session_id`);--> statement-breakpoint
CREATE INDEX `cheat_findings_category_idx` ON `cheat_findings` (`category`);--> statement-breakpoint
CREATE TABLE `comprehension_quizzes` (
	`id` text PRIMARY KEY NOT NULL,
	`understanding_file_id` text NOT NULL,
	`questions` text NOT NULL,
	`generated_at` integer NOT NULL,
	`completed_at` integer,
	`score` real,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`understanding_file_id`) REFERENCES `understanding_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comprehension_quizzes_file_idx` ON `comprehension_quizzes` (`understanding_file_id`,`generated_at`);--> statement-breakpoint
CREATE TABLE `context_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`paths` text NOT NULL,
	`estimated_savings_tokens` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `context_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_insights_snapshot_idx` ON `context_insights` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `context_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`category` text NOT NULL,
	`label` text NOT NULL,
	`tokens` integer NOT NULL,
	`percent` real NOT NULL,
	`source_path` text,
	`preview` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `context_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_segments_snapshot_idx` ON `context_segments` (`snapshot_id`);--> statement-breakpoint
CREATE INDEX `context_segments_category_idx` ON `context_segments` (`category`);--> statement-breakpoint
CREATE TABLE `context_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`provider` text,
	`model` text,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`context_window` integer,
	`measured_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `context_snapshots_session_idx` ON `context_snapshots` (`session_id`,`measured_at`);--> statement-breakpoint
CREATE INDEX `context_snapshots_step_idx` ON `context_snapshots` (`step_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`token_hash` text NOT NULL,
	`public_key` text,
	`last_seen_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `file_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`path` text NOT NULL,
	`old_path` text,
	`change_type` text NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`diff` text,
	`ai_authored` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `git_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_changes_snapshot_idx` ON `file_changes` (`snapshot_id`);--> statement-breakpoint
CREATE INDEX `file_changes_path_idx` ON `file_changes` (`path`);--> statement-breakpoint
CREATE TABLE `git_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`kind` text NOT NULL,
	`commit_sha` text,
	`parent_commit_sha` text,
	`branch` text,
	`worktree_path` text,
	`patch` text,
	`files_changed` integer DEFAULT 0 NOT NULL,
	`insertions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `git_snapshots_session_idx` ON `git_snapshots` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `git_snapshots_step_idx` ON `git_snapshots` (`step_id`);--> statement-breakpoint
CREATE INDEX `git_snapshots_commit_idx` ON `git_snapshots` (`commit_sha`);--> statement-breakpoint
CREATE TABLE `guard_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`rule_id` text NOT NULL,
	`kind` text NOT NULL,
	`action` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`command` text,
	`evidence` text NOT NULL,
	`requested_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`resolution_note` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `guard_events_session_idx` ON `guard_events` (`session_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `guard_events_status_idx` ON `guard_events` (`status`);--> statement-breakpoint
CREATE INDEX `guard_events_rule_idx` ON `guard_events` (`rule_id`);--> statement-breakpoint
CREATE TABLE `guard_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`action` text NOT NULL,
	`severity` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guard_rules_enabled_priority_idx` ON `guard_rules` (`enabled`,`priority`);--> statement-breakpoint
CREATE TABLE `handoff_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`content_markdown` text NOT NULL,
	`generated_at` integer NOT NULL,
	`model` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `handoff_briefs_session_idx` ON `handoff_briefs` (`session_id`,`generated_at`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`week_start` text NOT NULL,
	`title` text NOT NULL,
	`markdown` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `journal_entries_project_week_idx` ON `journal_entries` (`project_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `live_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`session_id` text,
	`step_id` text,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `live_events_session_idx` ON `live_events` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `live_events_created_at_idx` ON `live_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `pairing_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`device_name_hint` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_tokens_hash_unique` ON `pairing_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `pairing_tokens_expiry_idx` ON `pairing_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `plugin_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`session_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `plugin_runs_plugin_idx` ON `plugin_runs` (`plugin_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `plugin_runs_session_idx` ON `plugin_runs` (`session_id`);--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`description` text,
	`manifest` text NOT NULL,
	`path` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`installed_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plugins_enabled_idx` ON `plugins` (`enabled`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`last_opened_at` integer,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_root_path_unique` ON `projects` (`root_path`);--> statement-breakpoint
CREATE INDEX `projects_updated_at_idx` ON `projects` (`updated_at`);--> statement-breakpoint
CREATE TABLE `provenance_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text,
	`step_id` text,
	`file_path` text NOT NULL,
	`line_start` integer NOT NULL,
	`line_end` integer NOT NULL,
	`commit_sha` text,
	`content_hash` text NOT NULL,
	`provider` text,
	`model` text,
	`prompt_excerpt` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`captured_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `provenance_project_file_idx` ON `provenance_entries` (`project_id`,`file_path`);--> statement-breakpoint
CREATE INDEX `provenance_session_idx` ON `provenance_entries` (`session_id`);--> statement-breakpoint
CREATE INDEX `provenance_hash_idx` ON `provenance_entries` (`content_hash`);--> statement-breakpoint
CREATE TABLE `redaction_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pattern` text NOT NULL,
	`replacement` text DEFAULT '[REDACTED]' NOT NULL,
	`flags` text DEFAULT 'g' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'builtin' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `redaction_rules_enabled_idx` ON `redaction_rules` (`enabled`);--> statement-breakpoint
CREATE TABLE `redactions` (
	`id` text PRIMARY KEY NOT NULL,
	`step_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`label` text NOT NULL,
	`location` text NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `redactions_step_idx` ON `redactions` (`step_id`);--> statement-breakpoint
CREATE TABLE `replay_forks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`branch` text NOT NULL,
	`worktree_path` text NOT NULL,
	`base_commit` text,
	`resume_brief` text NOT NULL,
	`status` text DEFAULT 'creating' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `replay_forks_session_idx` ON `replay_forks` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`source` text DEFAULT 'proxy' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`agent_name` text,
	`agent_version` text,
	`agent_user_agent` text,
	`agent_detected_from` text DEFAULT 'unknown',
	`provider` text,
	`protocol` text,
	`model` text,
	`workspace_path` text,
	`git_branch` text,
	`git_base_commit` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer,
	`step_count` integer DEFAULT 0 NOT NULL,
	`model_call_count` integer DEFAULT 0 NOT NULL,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`unknown_cost_calls` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`tags` text NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_project_started_idx` ON `sessions` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `sessions_started_at_idx` ON `sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_agent_idx` ON `sessions` (`agent_name`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`parent_step_id` text,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`provider` text,
	`model` text,
	`request_protocol` text,
	`request_method` text,
	`request_path` text,
	`request_stream` integer DEFAULT false NOT NULL,
	`request_headers` text,
	`request_body` text,
	`request_system_prompt` text,
	`request_prompt_text` text,
	`request_redaction_count` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`response_headers` text,
	`response_text` text,
	`response_thinking` text,
	`response_finish_reason` text,
	`response_error` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`cost_known` integer DEFAULT false NOT NULL,
	`ttft_ms` integer,
	`latency_ms` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer,
	`error` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_session_seq_unique` ON `steps` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `steps_session_started_idx` ON `steps` (`session_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `steps_parent_idx` ON `steps` (`parent_step_id`);--> statement-breakpoint
CREATE INDEX `steps_kind_idx` ON `steps` (`kind`);--> statement-breakpoint
CREATE TABLE `stream_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`step_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`delta_text` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stream_chunks_step_seq_unique` ON `stream_chunks` (`step_id`,`seq`);--> statement-breakpoint
CREATE INDEX `stream_chunks_step_idx` ON `stream_chunks` (`step_id`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`step_id` text,
	`provider_tool_call_id` text,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`file_paths` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tool_calls_session_idx` ON `tool_calls` (`session_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tool_calls_step_idx` ON `tool_calls` (`step_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_name_idx` ON `tool_calls` (`name`);--> statement-breakpoint
CREATE TABLE `understanding_events` (
	`id` text PRIMARY KEY NOT NULL,
	`understanding_file_id` text NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`metadata` text NOT NULL,
	FOREIGN KEY (`understanding_file_id`) REFERENCES `understanding_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `understanding_events_file_idx` ON `understanding_events` (`understanding_file_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `understanding_files` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text,
	`path` text NOT NULL,
	`ai_lines` integer DEFAULT 0 NOT NULL,
	`reviewed_lines` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'unseen' NOT NULL,
	`first_touched_at` integer NOT NULL,
	`last_touched_at` integer NOT NULL,
	`last_opened_at` integer,
	`acknowledged_at` integer,
	`explanation` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `understanding_files_project_path_unique` ON `understanding_files` (`project_id`,`path`);--> statement-breakpoint
CREATE INDEX `understanding_files_status_idx` ON `understanding_files` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `understanding_files_last_touched_idx` ON `understanding_files` (`last_touched_at`);
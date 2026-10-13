// Baseline of the existing SQLite v29 domain schema. UTC ISO strings and encrypted values are preserved.
export const tables = [
  "CREATE TABLE IF NOT EXISTS `schema_meta` (\n  `version` BIGINT NOT NULL,\n  `applied_at` LONGTEXT NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `raw_import_records` (\n  `source_key` VARCHAR(255) NOT NULL,\n  `source_type` LONGTEXT NOT NULL,\n  `source_path` LONGTEXT NOT NULL,\n  `source_record_id` LONGTEXT NOT NULL,\n  `source_hash` LONGTEXT NOT NULL,\n  `source_updated_at` LONGTEXT NOT NULL DEFAULT (''),\n  `payload_json` LONGTEXT NOT NULL,\n  `imported_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`source_key`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `gpt_accounts` (\n  `id` VARCHAR(128) NOT NULL,\n  `lifecycle_status` VARCHAR(64) NOT NULL DEFAULT 'active',\n  `deactivation_locked` BIGINT NOT NULL DEFAULT 0,\n  `deactivated_at` VARCHAR(40) NOT NULL DEFAULT '',\n  `admin_deactivated_at` LONGTEXT NOT NULL DEFAULT (''),\n  `retired_at` LONGTEXT NOT NULL DEFAULT (''),\n  `quarantined_at` LONGTEXT NOT NULL DEFAULT (''),\n  `quarantine_reason` LONGTEXT NOT NULL DEFAULT (''),\n  `identity_status` LONGTEXT NOT NULL DEFAULT ('unknown'),\n  `sold` BIGINT NOT NULL DEFAULT 0,\n  `plan` LONGTEXT NOT NULL DEFAULT ('unknown'),\n  `billing_channel` LONGTEXT NOT NULL DEFAULT (''),\n  `note` LONGTEXT NOT NULL DEFAULT (''),\n  `payment_link` LONGTEXT NOT NULL DEFAULT (''),\n  `hide_promotion` BIGINT NOT NULL DEFAULT 0,\n  `domain_mailbox` BIGINT NOT NULL DEFAULT 0,\n  `suspected_unused` BIGINT NOT NULL DEFAULT 0,\n  `mark_color` LONGTEXT NOT NULL DEFAULT (''),\n  `group_boundary` BIGINT NOT NULL DEFAULT 0,\n  `source_status` LONGTEXT NOT NULL DEFAULT ('current'),\n  `openai_mfa_enabled` BIGINT NOT NULL DEFAULT 0,\n  `openai_auth_methods_json` LONGTEXT NOT NULL DEFAULT ('[]'),\n  `arrived_at` VARCHAR(40) NOT NULL,\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  `deleted_at` LONGTEXT NOT NULL DEFAULT (''),\n  `billing_channel_override` LONGTEXT NOT NULL DEFAULT (''),\n  PRIMARY KEY (`id`),\n  KEY `idx_accounts_deactivated_at` (`deactivation_locked`,`deactivated_at`),\n  KEY `idx_accounts_status` (`lifecycle_status`,`deactivation_locked`,`sold`),\n  KEY `idx_accounts_arrived` (`arrived_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mailbox_families` (\n  `id` VARCHAR(128) NOT NULL,\n  `provider` LONGTEXT NOT NULL,\n  `canonical_address_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `canonical_address_hash` LONGTEXT NOT NULL,\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `email_bindings` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `mailbox_family_id` VARCHAR(128) NULL,\n  `email_enc` LONGTEXT NOT NULL,\n  `email_hash` VARCHAR(128) NOT NULL,\n  `local_part` VARCHAR(255) NOT NULL,\n  `domain` VARCHAR(255) NOT NULL,\n  `provider` LONGTEXT NOT NULL,\n  `valid_from` VARCHAR(40) NOT NULL DEFAULT '',\n  `valid_to` LONGTEXT NOT NULL DEFAULT (''),\n  `is_current` BIGINT NOT NULL DEFAULT 1,\n  `association_method` LONGTEXT NOT NULL DEFAULT ('legacy_mapping'),\n  `association_version` BIGINT NOT NULL DEFAULT 1,\n  `legacy_mapping_id` VARCHAR(255) NOT NULL,\n  `source_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  `receive_disabled_at` LONGTEXT NOT NULL DEFAULT (''),\n  PRIMARY KEY (`id`),\n  `current_email_hash` VARCHAR(128) GENERATED ALWAYS AS (IF(is_current=1, `email_hash`, NULL)) STORED,\n  UNIQUE KEY `idx_one_current_owner_per_email` (`current_email_hash`),\n  `current_account_id` VARCHAR(128) GENERATED ALWAYS AS (IF(is_current=1, `account_id`, NULL)) STORED,\n  UNIQUE KEY `idx_one_current_binding_per_account` (`current_account_id`),\n  KEY `idx_bindings_local` (`local_part`,`domain`),\n  KEY `idx_bindings_account` (`account_id`,`valid_from`),\n  UNIQUE KEY `uq_email_bindings_4` (`legacy_mapping_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `account_relations` (\n  `id` VARCHAR(128) NOT NULL,\n  `relation_type` LONGTEXT NOT NULL,\n  `from_account_id` VARCHAR(128) NOT NULL,\n  `to_account_id` VARCHAR(128) NOT NULL,\n  `changed_at` LONGTEXT NOT NULL DEFAULT (''),\n  `association_method` LONGTEXT NOT NULL,\n  `evidence_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `status` LONGTEXT NOT NULL DEFAULT ('confirmed'),\n  `created_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `sales` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `binding_id` VARCHAR(128) NOT NULL,\n  `status` VARCHAR(64) NOT NULL DEFAULT 'active',\n  `started_at` VARCHAR(40) NOT NULL,\n  `ended_at` LONGTEXT NOT NULL DEFAULT (''),\n  `end_reason` LONGTEXT NOT NULL DEFAULT (''),\n  `first_used_at` LONGTEXT NOT NULL DEFAULT (''),\n  `last_used_at` LONGTEXT NOT NULL DEFAULT (''),\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_sales_status` (`status`,`started_at`),\n  UNIQUE KEY `uq_sales_1` (`account_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `routing_endpoints` (\n  `email_hash` VARCHAR(128) NOT NULL,\n  `email_enc` LONGTEXT NOT NULL,\n  `reason` LONGTEXT NOT NULL,\n  `created_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`email_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `access_grants` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `binding_id` VARCHAR(128) NOT NULL,\n  `sale_id` VARCHAR(128) NULL,\n  `public_token_hash` VARCHAR(128) NOT NULL,\n  `public_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `legacy_public_token` BIGINT NOT NULL DEFAULT 0,\n  `login_identifier_hash` VARCHAR(128) NOT NULL,\n  `login_identifier_enc` LONGTEXT NOT NULL,\n  `password_hash` LONGTEXT NOT NULL,\n  `password_plain_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `scope` LONGTEXT NOT NULL,\n  `visible_from` LONGTEXT NOT NULL DEFAULT (''),\n  `visible_to` LONGTEXT NOT NULL DEFAULT (''),\n  `active` BIGINT NOT NULL DEFAULT 1,\n  `first_used_at` LONGTEXT NOT NULL DEFAULT (''),\n  `last_used_at` LONGTEXT NOT NULL DEFAULT (''),\n  `revoked_at` LONGTEXT NOT NULL DEFAULT (''),\n  `revoke_reason` LONGTEXT NOT NULL DEFAULT (''),\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_grants_sale` (`sale_id`,`active`),\n  KEY `idx_grants_login` (`login_identifier_hash`,`active`),\n  UNIQUE KEY `uq_access_grants_2` (`public_token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `credentials` (\n  `account_id` VARCHAR(128) NOT NULL,\n  `access_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `refresh_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `id_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `session_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `openai_password_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `openai_subject_hash` LONGTEXT NOT NULL DEFAULT (''),\n  `access_token_alive` BIGINT NOT NULL DEFAULT 0,\n  `refresh_token_alive` BIGINT NOT NULL DEFAULT 0,\n  `source` LONGTEXT NOT NULL DEFAULT (''),\n  `source_updated_at` LONGTEXT NOT NULL DEFAULT (''),\n  `access_token_fingerprint` LONGTEXT NOT NULL DEFAULT (''),\n  `access_token_first_seen_at` LONGTEXT NOT NULL DEFAULT (''),\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`account_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `openai_identity_observations` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `subject_hash` VARCHAR(128) NOT NULL,\n  `source` LONGTEXT NOT NULL,\n  `status` VARCHAR(64) NOT NULL DEFAULT 'confirmed',\n  `first_seen_at` LONGTEXT NOT NULL,\n  `last_seen_at` LONGTEXT NOT NULL,\n  `evidence_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  PRIMARY KEY (`id`),\n  KEY `idx_identity_subject` (`subject_hash`,`status`),\n  UNIQUE KEY `uq_openai_identity_observations_1` (`account_id`,`subject_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `payment_exposure_checks` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `target` VARCHAR(64) NOT NULL,\n  `ip_country` VARCHAR(8) NOT NULL,\n  `billing_country` VARCHAR(8) NOT NULL,\n  `billing_currency` VARCHAR(8) NOT NULL,\n  `expected_method` LONGTEXT NOT NULL,\n  `available_methods_json` LONGTEXT NOT NULL DEFAULT ('[]'),\n  `matched_methods_json` LONGTEXT NOT NULL DEFAULT ('[]'),\n  `payment_methods_json` LONGTEXT NOT NULL DEFAULT ('[]'),\n  `trial_status` LONGTEXT NOT NULL DEFAULT ('unknown'),\n  `exposed` BIGINT NOT NULL DEFAULT 0,\n  `status` VARCHAR(64) NOT NULL DEFAULT 'unknown',\n  `checkout_type` LONGTEXT NOT NULL DEFAULT (''),\n  `detail` LONGTEXT NOT NULL DEFAULT (''),\n  `promo_eligible` BIGINT NOT NULL DEFAULT -1,\n  `promo_campaign` LONGTEXT NOT NULL DEFAULT (''),\n  `promo_mode` LONGTEXT NOT NULL DEFAULT ('unknown'),\n  `observed_at` LONGTEXT NOT NULL,\n  `source` LONGTEXT NOT NULL DEFAULT ('automyai'),\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` VARCHAR(40) NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_payment_exposure_target` (`target`,`ip_country`,`status`),\n  KEY `idx_payment_exposure_account` (`account_id`,`updated_at`),\n  UNIQUE KEY `uq_payment_exposure_checks_2` (`account_id`,`target`,`ip_country`,`billing_country`,`billing_currency`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `payment_exposure_jobs` (\n  `job_id` VARCHAR(128) NOT NULL,\n  `remote_job_id` LONGTEXT NOT NULL DEFAULT (''),\n  `account_id` VARCHAR(128) NOT NULL,\n  `route_key` LONGTEXT NOT NULL,\n  `target` LONGTEXT NOT NULL,\n  `ip_country` LONGTEXT NOT NULL,\n  `billing_country` LONGTEXT NOT NULL,\n  `billing_currency` LONGTEXT NOT NULL,\n  `job_kind` VARCHAR(128) NOT NULL DEFAULT 'manual',\n  `access_token_fingerprint` VARCHAR(128) NOT NULL DEFAULT '',\n  `scheduled_at` LONGTEXT NOT NULL DEFAULT (''),\n  `promo_mode` LONGTEXT NOT NULL DEFAULT ('none'),\n  `status` VARCHAR(64) NOT NULL DEFAULT 'queued',\n  `last_error` LONGTEXT NOT NULL DEFAULT (''),\n  `started_at` LONGTEXT NOT NULL DEFAULT (''),\n  `finished_at` LONGTEXT NOT NULL DEFAULT (''),\n  `created_at` VARCHAR(40) NOT NULL,\n  `updated_at` VARCHAR(40) NOT NULL,\n  PRIMARY KEY (`job_id`),\n  KEY `idx_payment_exposure_jobs_dedupe` (`account_id`,`job_kind`,`access_token_fingerprint`,`status`),\n  KEY `idx_payment_exposure_jobs_status` (`status`,`updated_at`),\n  KEY `idx_payment_exposure_jobs_account` (`account_id`,`created_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_messages` (\n  `id` VARCHAR(128) NOT NULL,\n  `provider` VARCHAR(64) NOT NULL,\n  `provider_message_id` VARCHAR(512) NOT NULL,\n  `sender` LONGTEXT NOT NULL DEFAULT (''),\n  `recipient_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `subject` LONGTEXT NOT NULL DEFAULT (''),\n  `received_at` VARCHAR(40) NOT NULL DEFAULT '',\n  `folder` LONGTEXT NOT NULL DEFAULT ('inbox'),\n  `category` LONGTEXT NOT NULL DEFAULT ('unknown'),\n  `is_security` BIGINT NOT NULL DEFAULT 0,\n  `metadata_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `indexed_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_messages_received` (`received_at`),\n  UNIQUE KEY `uq_mail_messages_1` (`provider`,`provider_message_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_ownership_claims` (\n  `message_id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `binding_id` VARCHAR(128) NOT NULL,\n  `claim_type` LONGTEXT NOT NULL,\n  `confidence` DOUBLE NOT NULL DEFAULT 1,\n  `reason` LONGTEXT NOT NULL,\n  `visible_to_customer` BIGINT NOT NULL DEFAULT 1,\n  `created_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`message_id`,`binding_id`),\n  KEY `idx_claims_account` (`account_id`,`binding_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `lifecycle_events` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `binding_id` VARCHAR(128) NULL,\n  `event_type` LONGTEXT NOT NULL,\n  `occurred_at` VARCHAR(40) NOT NULL,\n  `source` LONGTEXT NOT NULL,\n  `payload_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `created_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_events_account` (`account_id`,`occurred_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `shadow_sync_runs` (\n  `id` VARCHAR(128) NOT NULL,\n  `started_at` LONGTEXT NOT NULL,\n  `finished_at` LONGTEXT NOT NULL DEFAULT (''),\n  `source_hash` LONGTEXT NOT NULL DEFAULT (''),\n  `source_count` BIGINT NOT NULL DEFAULT 0,\n  `account_count` BIGINT NOT NULL DEFAULT 0,\n  `binding_count` BIGINT NOT NULL DEFAULT 0,\n  `relation_count` BIGINT NOT NULL DEFAULT 0,\n  `recovered_count` BIGINT NOT NULL DEFAULT 0,\n  `status` LONGTEXT NOT NULL,\n  `detail_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `sub2api_sync_runs` (\n  `id` VARCHAR(128) NOT NULL,\n  `started_at` LONGTEXT NOT NULL,\n  `finished_at` LONGTEXT NOT NULL DEFAULT (''),\n  `total_count` BIGINT NOT NULL DEFAULT 0,\n  `active_openai_count` BIGINT NOT NULL DEFAULT 0,\n  `matched_count` BIGINT NOT NULL DEFAULT 0,\n  `created_count` BIGINT NOT NULL DEFAULT 0,\n  `rebind_count` BIGINT NOT NULL DEFAULT 0,\n  `conflict_count` BIGINT NOT NULL DEFAULT 0,\n  `skipped_count` BIGINT NOT NULL DEFAULT 0,\n  `status` LONGTEXT NOT NULL,\n  `detail_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `pending_reviews` (\n  `id` VARCHAR(128) NOT NULL,\n  `review_type` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NULL,\n  `candidate_email_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `candidate_email_hash` VARCHAR(128) NOT NULL DEFAULT '',\n  `status` VARCHAR(64) NOT NULL DEFAULT 'pending',\n  `reason` LONGTEXT NOT NULL,\n  `evidence_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `created_at` VARCHAR(40) NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_reviews_status` (`status`,`created_at`),\n  UNIQUE KEY `uq_pending_reviews_1` (`review_type`,`account_id`,`candidate_email_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `settings` (\n  `key` VARCHAR(128) NOT NULL,\n  `value` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`key`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `account_origins` (\n  `account_id` VARCHAR(128) NOT NULL,\n  `source_type` VARCHAR(64) NOT NULL,\n  `source_id` VARCHAR(255) NOT NULL DEFAULT '',\n  `is_auto` BIGINT NOT NULL DEFAULT 0,\n  `first_seen_at` LONGTEXT NOT NULL,\n  `metadata_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  PRIMARY KEY (`account_id`,`source_type`,`source_id`),\n  KEY `idx_origins_workbench` (`source_type`,`is_auto`,`account_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `account_preferences` (\n  `account_id` VARCHAR(128) NOT NULL,\n  `label` LONGTEXT NOT NULL DEFAULT (''),\n  `hide_billing` BIGINT NOT NULL DEFAULT 0,\n  `show_deactivation` BIGINT NOT NULL DEFAULT 0,\n  `hide_promotion` BIGINT NOT NULL DEFAULT 0,\n  `status_message` LONGTEXT NOT NULL DEFAULT (''),\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`account_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `billing_channel_observations` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `channel` LONGTEXT NOT NULL,\n  `source` LONGTEXT NOT NULL,\n  `evidence_id` LONGTEXT NOT NULL DEFAULT (''),\n  `observed_at` LONGTEXT NOT NULL,\n  `active` BIGINT NOT NULL DEFAULT 1,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mailbox_connections` (\n  `id` VARCHAR(128) NOT NULL,\n  `binding_id` VARCHAR(128) NULL,\n  `mailbox_family_id` VARCHAR(128) NULL,\n  `provider` LONGTEXT NOT NULL,\n  `external_account_id` LONGTEXT NOT NULL DEFAULT (''),\n  `external_group_id` LONGTEXT NOT NULL DEFAULT (''),\n  `secret_ref` LONGTEXT NOT NULL DEFAULT (''),\n  `status` LONGTEXT NOT NULL DEFAULT ('active'),\n  `last_checked_at` LONGTEXT NOT NULL DEFAULT (''),\n  `metadata_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  `manager_email_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `credentials_enc` LONGTEXT NOT NULL DEFAULT (''),\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_routing_rules` (\n  `id` VARCHAR(128) NOT NULL,\n  `binding_id` VARCHAR(128) NOT NULL,\n  `sender_pattern` LONGTEXT NOT NULL DEFAULT (''),\n  `recipient_pattern` LONGTEXT NOT NULL DEFAULT (''),\n  `valid_from` LONGTEXT NOT NULL DEFAULT (''),\n  `valid_to` LONGTEXT NOT NULL DEFAULT (''),\n  `source` LONGTEXT NOT NULL,\n  `priority` BIGINT NOT NULL DEFAULT 0,\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `binding_transitions` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `from_binding_id` VARCHAR(128) NOT NULL,\n  `to_binding_id` VARCHAR(128) NOT NULL,\n  `changed_at` VARCHAR(40) NOT NULL,\n  `method` LONGTEXT NOT NULL,\n  `task_id` LONGTEXT NOT NULL DEFAULT (''),\n  `evidence_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `created_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_binding_transitions_account` (`account_id`,`changed_at`),\n  UNIQUE KEY `uq_binding_transitions_1` (`account_id`,`from_binding_id`,`to_binding_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `credential_versions` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `observed_binding_id` VARCHAR(128) NULL,\n  `subject_hash` LONGTEXT NOT NULL DEFAULT (''),\n  `access_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `refresh_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `id_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `session_token_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `openai_password_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `token_fingerprint` VARCHAR(128) NOT NULL,\n  `first_seen_at` LONGTEXT NOT NULL,\n  `last_seen_at` VARCHAR(40) NOT NULL,\n  `validity_status` LONGTEXT NOT NULL DEFAULT ('unknown'),\n  `validity_checked_at` LONGTEXT NOT NULL DEFAULT (''),\n  `source` LONGTEXT NOT NULL,\n  `supersedes_id` VARCHAR(128) NULL,\n  `retired_reason` LONGTEXT NOT NULL DEFAULT (''),\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_credential_versions_account` (`account_id`,`last_seen_at`),\n  UNIQUE KEY `uq_credential_versions_1` (`account_id`,`token_fingerprint`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `account_current_credentials` (\n  `account_id` VARCHAR(128) NOT NULL,\n  `credential_version_id` VARCHAR(128) NOT NULL,\n  `selected_at` LONGTEXT NOT NULL,\n  `selection_reason` LONGTEXT NOT NULL,\n  PRIMARY KEY (`account_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `credential_observations` (\n  `id` VARCHAR(128) NOT NULL,\n  `credential_version_id` VARCHAR(128) NOT NULL,\n  `binding_id` VARCHAR(128) NULL,\n  `source` LONGTEXT NOT NULL,\n  `observed_at` LONGTEXT NOT NULL,\n  `evidence_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `promotion_jobs` (\n  `id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `credential_version_id` VARCHAR(128) NULL,\n  `campaign` LONGTEXT NOT NULL,\n  `region` LONGTEXT NOT NULL DEFAULT ('JP'),\n  `check_kind` LONGTEXT NOT NULL DEFAULT ('auto'),\n  `due_at` VARCHAR(40) NOT NULL,\n  `attempt` BIGINT NOT NULL DEFAULT 0,\n  `status` VARCHAR(64) NOT NULL DEFAULT 'queued',\n  `error_class` LONGTEXT NOT NULL DEFAULT (''),\n  `error_detail` LONGTEXT NOT NULL DEFAULT (''),\n  `next_retry_at` VARCHAR(40) NOT NULL DEFAULT '',\n  `started_at` LONGTEXT NOT NULL DEFAULT (''),\n  `finished_at` LONGTEXT NOT NULL DEFAULT (''),\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_promotion_jobs_due` (`status`,`next_retry_at`,`due_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `promotion_observations` (\n  `id` VARCHAR(128) NOT NULL,\n  `job_id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `credential_version_id` VARCHAR(128) NULL,\n  `campaign` LONGTEXT NOT NULL,\n  `eligible` BIGINT NULL,\n  `result_status` LONGTEXT NOT NULL,\n  `upstream_status` BIGINT NOT NULL DEFAULT 0,\n  `evidence_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `response_hash` LONGTEXT NOT NULL DEFAULT (''),\n  `checked_at` VARCHAR(40) NOT NULL,\n  `expires_at` LONGTEXT NOT NULL DEFAULT (''),\n  `created_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_promotion_observations_account` (`account_id`,`checked_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `oauth_health_jobs` (\n  `id` VARCHAR(128) NOT NULL,\n  `status` LONGTEXT NOT NULL,\n  `total_count` BIGINT NOT NULL DEFAULT 0,\n  `completed_count` BIGINT NOT NULL DEFAULT 0,\n  `error_count` BIGINT NOT NULL DEFAULT 0,\n  `created_at` LONGTEXT NOT NULL,\n  `started_at` LONGTEXT NOT NULL DEFAULT (''),\n  `finished_at` LONGTEXT NOT NULL DEFAULT (''),\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `oauth_health_results` (\n  `id` VARCHAR(128) NOT NULL,\n  `job_id` VARCHAR(128) NOT NULL,\n  `account_id` VARCHAR(128) NOT NULL,\n  `credential_version_id` VARCHAR(128) NULL,\n  `access_status` LONGTEXT NOT NULL DEFAULT ('unknown'),\n  `refresh_status` LONGTEXT NOT NULL DEFAULT ('unknown'),\n  `detail` LONGTEXT NOT NULL DEFAULT (''),\n  `checked_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `change_outbox` (\n  `sequence` BIGINT NOT NULL AUTO_INCREMENT,\n  `event_id` VARCHAR(128) NOT NULL,\n  `aggregate_type` LONGTEXT NOT NULL,\n  `aggregate_id` LONGTEXT NOT NULL,\n  `aggregate_version` BIGINT NOT NULL DEFAULT 1,\n  `event_type` LONGTEXT NOT NULL,\n  `payload_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `source_system` LONGTEXT NOT NULL DEFAULT ('v2'),\n  `occurred_at` LONGTEXT NOT NULL,\n  `committed_at` VARCHAR(40) NOT NULL,\n  PRIMARY KEY (`sequence`),\n  KEY `idx_outbox_committed` (`sequence`,`committed_at`),\n  UNIQUE KEY `uq_change_outbox_1` (`event_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `sync_consumers` (\n  `consumer` VARCHAR(128) NOT NULL,\n  `last_sequence` BIGINT NOT NULL DEFAULT 0,\n  `last_event_id` LONGTEXT NOT NULL DEFAULT (''),\n  `source_cursor` LONGTEXT NOT NULL DEFAULT (''),\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`consumer`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `sync_conflicts` (\n  `id` VARCHAR(128) NOT NULL,\n  `source` LONGTEXT NOT NULL,\n  `aggregate_id` LONGTEXT NOT NULL,\n  `expected_version` BIGINT NOT NULL DEFAULT 0,\n  `received_version` BIGINT NOT NULL DEFAULT 0,\n  `payload_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `status` LONGTEXT NOT NULL DEFAULT ('pending'),\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `source_links` (\n  `source_system` VARCHAR(64) NOT NULL,\n  `source_id` VARCHAR(255) NOT NULL,\n  `aggregate_type` VARCHAR(64) NOT NULL,\n  `aggregate_id` LONGTEXT NOT NULL,\n  `source_version` LONGTEXT NOT NULL DEFAULT (''),\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`source_system`,`source_id`,`aggregate_type`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `worker_heartbeats` (\n  `worker_name` VARCHAR(128) NOT NULL,\n  `artifact_sha256` LONGTEXT NOT NULL DEFAULT (''),\n  `process_id` BIGINT NOT NULL DEFAULT 0,\n  `status` LONGTEXT NOT NULL DEFAULT ('ok'),\n  `detail_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `heartbeat_at` LONGTEXT NOT NULL,\n  `started_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`worker_name`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mailbox_sync_state` (\n  `source` VARCHAR(128) NOT NULL,\n  `cursor` LONGTEXT NOT NULL DEFAULT (''),\n  `source_revision` LONGTEXT NOT NULL DEFAULT (''),\n  `lag_seconds` DOUBLE NOT NULL DEFAULT 0,\n  `last_success_at` LONGTEXT NOT NULL DEFAULT (''),\n  `last_error` LONGTEXT NOT NULL DEFAULT (''),\n  `updated_at` VARCHAR(40) NOT NULL,\n  PRIMARY KEY (`source`),\n  KEY `idx_mailbox_sync_updated` (`updated_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `share_links` (\n  `id` VARCHAR(128) NOT NULL,\n  `token_hash` VARCHAR(128) NOT NULL,\n  `token_enc` LONGTEXT NOT NULL,\n  `label` LONGTEXT NOT NULL DEFAULT (''),\n  `expires_at` LONGTEXT NOT NULL,\n  `max_views` BIGINT NOT NULL DEFAULT 5,\n  `views` BIGINT NOT NULL DEFAULT 0,\n  `last_view_at` LONGTEXT NOT NULL DEFAULT (''),\n  `revoked_at` LONGTEXT NOT NULL DEFAULT (''),\n  `filters_json` LONGTEXT NOT NULL DEFAULT ('{}'),\n  `created_at` VARCHAR(40) NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `idx_share_links_created` (`created_at`),\n  UNIQUE KEY `uq_share_links_1` (`token_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `share_view_dedup` (\n  `link_id` VARCHAR(128) NOT NULL,\n  `visitor_hash` VARCHAR(128) NOT NULL,\n  `expires_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`link_id`,`visitor_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_read_requests` (\n  `id` VARCHAR(128) NOT NULL,\n  `started_at` BIGINT NOT NULL,\n  `rows_read` BIGINT NOT NULL DEFAULT 0,\n  `outcome` LONGTEXT NOT NULL DEFAULT ('pending'),\n  PRIMARY KEY (`id`),\n  KEY `idx_mail_read_started` (`started_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_read_control` (\n  `id` BIGINT NOT NULL,\n  `owner` LONGTEXT NOT NULL DEFAULT (''),\n  `lease_until` BIGINT NOT NULL DEFAULT 0,\n  `blocked_reason` LONGTEXT NOT NULL DEFAULT (''),\n  `backfill_at` BIGINT NOT NULL DEFAULT 0,\n  PRIMARY KEY (`id`),\n  CHECK (id=1)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_read_failures` (\n  `request_key` VARCHAR(255) NOT NULL,\n  `retry_after` BIGINT NOT NULL,\n  `error_code` LONGTEXT NOT NULL,\n  PRIMARY KEY (`request_key`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_ingestion_state` (\n  `provider` VARCHAR(64) NOT NULL,\n  `provider_message_id` VARCHAR(512) NOT NULL,\n  `status` LONGTEXT NOT NULL,\n  `attempts` BIGINT NOT NULL DEFAULT 0,\n  `error_code` LONGTEXT NOT NULL DEFAULT (''),\n  `discovered_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`provider`,`provider_message_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_ingestion_leases` (\n  `provider` VARCHAR(64) NOT NULL,\n  `provider_message_id` VARCHAR(512) NOT NULL,\n  `owner` LONGTEXT NOT NULL DEFAULT (''),\n  `lease_until` BIGINT NOT NULL DEFAULT 0,\n  `retry_after` BIGINT NOT NULL DEFAULT 0,\n  PRIMARY KEY (`provider`,`provider_message_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `account_passwords` (\n  `account_id` VARCHAR(128) NOT NULL,\n  `password_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `totp_secret_enc` LONGTEXT NOT NULL DEFAULT (''),\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`account_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `account_business_evidence` (\n  `account_id` VARCHAR(128) NOT NULL,\n  `hidden_tags_json` LONGTEXT NOT NULL DEFAULT ('[]'),\n  `mail_verified_no_plus` BIGINT NOT NULL DEFAULT 0,\n  `mail_verified_at` LONGTEXT NOT NULL DEFAULT (''),\n  `recycle_generation` BIGINT NULL,\n  `billing_started_at` LONGTEXT NOT NULL DEFAULT (''),\n  `last_activity_at` LONGTEXT NOT NULL DEFAULT (''),\n  `newest_mail_at` LONGTEXT NOT NULL DEFAULT (''),\n  `audit_binding_id` LONGTEXT NOT NULL DEFAULT (''),\n  `audited_at` LONGTEXT NOT NULL DEFAULT (''),\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`account_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `pending_mailboxes` (\n  `id` VARCHAR(128) NOT NULL,\n  `email_hash` VARCHAR(128) NOT NULL,\n  `email_enc` LONGTEXT NOT NULL,\n  `kind` LONGTEXT NOT NULL,\n  `created_at` LONGTEXT NOT NULL,\n  `updated_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq_pending_mailboxes_0` (`email_hash`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `pending_mail_claims` (\n  `pending_id` VARCHAR(128) NOT NULL,\n  `message_id` VARCHAR(128) NOT NULL,\n  `created_at` LONGTEXT NOT NULL,\n  PRIMARY KEY (`pending_id`,`message_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
  "CREATE TABLE IF NOT EXISTS `mail_recipient_index` (\n  `email_hash` VARCHAR(128) NOT NULL,\n  `message_id` VARCHAR(128) NOT NULL,\n  PRIMARY KEY (`email_hash`,`message_id`),\n  KEY `idx_mail_recipient_message` (`message_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin"
];
export const foreignKeys = [
  {
    "table": "email_bindings",
    "name": "fk_email_bindings_0",
    "sql": "ALTER TABLE `email_bindings` ADD CONSTRAINT `fk_email_bindings_0` FOREIGN KEY (`mailbox_family_id`) REFERENCES `mailbox_families` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "email_bindings",
    "name": "fk_email_bindings_1",
    "sql": "ALTER TABLE `email_bindings` ADD CONSTRAINT `fk_email_bindings_1` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "account_relations",
    "name": "fk_account_relations_0",
    "sql": "ALTER TABLE `account_relations` ADD CONSTRAINT `fk_account_relations_0` FOREIGN KEY (`to_account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "account_relations",
    "name": "fk_account_relations_1",
    "sql": "ALTER TABLE `account_relations` ADD CONSTRAINT `fk_account_relations_1` FOREIGN KEY (`from_account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "sales",
    "name": "fk_sales_0",
    "sql": "ALTER TABLE `sales` ADD CONSTRAINT `fk_sales_0` FOREIGN KEY (`binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "sales",
    "name": "fk_sales_1",
    "sql": "ALTER TABLE `sales` ADD CONSTRAINT `fk_sales_1` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "access_grants",
    "name": "fk_access_grants_0",
    "sql": "ALTER TABLE `access_grants` ADD CONSTRAINT `fk_access_grants_0` FOREIGN KEY (`sale_id`) REFERENCES `sales` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "access_grants",
    "name": "fk_access_grants_1",
    "sql": "ALTER TABLE `access_grants` ADD CONSTRAINT `fk_access_grants_1` FOREIGN KEY (`binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "access_grants",
    "name": "fk_access_grants_2",
    "sql": "ALTER TABLE `access_grants` ADD CONSTRAINT `fk_access_grants_2` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "credentials",
    "name": "fk_credentials_0",
    "sql": "ALTER TABLE `credentials` ADD CONSTRAINT `fk_credentials_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "openai_identity_observations",
    "name": "fk_openai_identity_observations_0",
    "sql": "ALTER TABLE `openai_identity_observations` ADD CONSTRAINT `fk_openai_identity_observations_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "payment_exposure_checks",
    "name": "fk_payment_exposure_checks_0",
    "sql": "ALTER TABLE `payment_exposure_checks` ADD CONSTRAINT `fk_payment_exposure_checks_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "payment_exposure_jobs",
    "name": "fk_payment_exposure_jobs_0",
    "sql": "ALTER TABLE `payment_exposure_jobs` ADD CONSTRAINT `fk_payment_exposure_jobs_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "mail_ownership_claims",
    "name": "fk_mail_ownership_claims_0",
    "sql": "ALTER TABLE `mail_ownership_claims` ADD CONSTRAINT `fk_mail_ownership_claims_0` FOREIGN KEY (`binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "mail_ownership_claims",
    "name": "fk_mail_ownership_claims_1",
    "sql": "ALTER TABLE `mail_ownership_claims` ADD CONSTRAINT `fk_mail_ownership_claims_1` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "mail_ownership_claims",
    "name": "fk_mail_ownership_claims_2",
    "sql": "ALTER TABLE `mail_ownership_claims` ADD CONSTRAINT `fk_mail_ownership_claims_2` FOREIGN KEY (`message_id`) REFERENCES `mail_messages` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "lifecycle_events",
    "name": "fk_lifecycle_events_0",
    "sql": "ALTER TABLE `lifecycle_events` ADD CONSTRAINT `fk_lifecycle_events_0` FOREIGN KEY (`binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "lifecycle_events",
    "name": "fk_lifecycle_events_1",
    "sql": "ALTER TABLE `lifecycle_events` ADD CONSTRAINT `fk_lifecycle_events_1` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "pending_reviews",
    "name": "fk_pending_reviews_0",
    "sql": "ALTER TABLE `pending_reviews` ADD CONSTRAINT `fk_pending_reviews_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "account_origins",
    "name": "fk_account_origins_0",
    "sql": "ALTER TABLE `account_origins` ADD CONSTRAINT `fk_account_origins_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "account_preferences",
    "name": "fk_account_preferences_0",
    "sql": "ALTER TABLE `account_preferences` ADD CONSTRAINT `fk_account_preferences_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "billing_channel_observations",
    "name": "fk_billing_channel_observations_0",
    "sql": "ALTER TABLE `billing_channel_observations` ADD CONSTRAINT `fk_billing_channel_observations_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "mailbox_connections",
    "name": "fk_mailbox_connections_0",
    "sql": "ALTER TABLE `mailbox_connections` ADD CONSTRAINT `fk_mailbox_connections_0` FOREIGN KEY (`mailbox_family_id`) REFERENCES `mailbox_families` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "mailbox_connections",
    "name": "fk_mailbox_connections_1",
    "sql": "ALTER TABLE `mailbox_connections` ADD CONSTRAINT `fk_mailbox_connections_1` FOREIGN KEY (`binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "mail_routing_rules",
    "name": "fk_mail_routing_rules_0",
    "sql": "ALTER TABLE `mail_routing_rules` ADD CONSTRAINT `fk_mail_routing_rules_0` FOREIGN KEY (`binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "binding_transitions",
    "name": "fk_binding_transitions_0",
    "sql": "ALTER TABLE `binding_transitions` ADD CONSTRAINT `fk_binding_transitions_0` FOREIGN KEY (`to_binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "binding_transitions",
    "name": "fk_binding_transitions_1",
    "sql": "ALTER TABLE `binding_transitions` ADD CONSTRAINT `fk_binding_transitions_1` FOREIGN KEY (`from_binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "binding_transitions",
    "name": "fk_binding_transitions_2",
    "sql": "ALTER TABLE `binding_transitions` ADD CONSTRAINT `fk_binding_transitions_2` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "credential_versions",
    "name": "fk_credential_versions_0",
    "sql": "ALTER TABLE `credential_versions` ADD CONSTRAINT `fk_credential_versions_0` FOREIGN KEY (`supersedes_id`) REFERENCES `credential_versions` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "credential_versions",
    "name": "fk_credential_versions_1",
    "sql": "ALTER TABLE `credential_versions` ADD CONSTRAINT `fk_credential_versions_1` FOREIGN KEY (`observed_binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "credential_versions",
    "name": "fk_credential_versions_2",
    "sql": "ALTER TABLE `credential_versions` ADD CONSTRAINT `fk_credential_versions_2` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "account_current_credentials",
    "name": "fk_account_current_credentials_0",
    "sql": "ALTER TABLE `account_current_credentials` ADD CONSTRAINT `fk_account_current_credentials_0` FOREIGN KEY (`credential_version_id`) REFERENCES `credential_versions` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "account_current_credentials",
    "name": "fk_account_current_credentials_1",
    "sql": "ALTER TABLE `account_current_credentials` ADD CONSTRAINT `fk_account_current_credentials_1` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "credential_observations",
    "name": "fk_credential_observations_0",
    "sql": "ALTER TABLE `credential_observations` ADD CONSTRAINT `fk_credential_observations_0` FOREIGN KEY (`binding_id`) REFERENCES `email_bindings` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "credential_observations",
    "name": "fk_credential_observations_1",
    "sql": "ALTER TABLE `credential_observations` ADD CONSTRAINT `fk_credential_observations_1` FOREIGN KEY (`credential_version_id`) REFERENCES `credential_versions` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "promotion_jobs",
    "name": "fk_promotion_jobs_0",
    "sql": "ALTER TABLE `promotion_jobs` ADD CONSTRAINT `fk_promotion_jobs_0` FOREIGN KEY (`credential_version_id`) REFERENCES `credential_versions` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "promotion_jobs",
    "name": "fk_promotion_jobs_1",
    "sql": "ALTER TABLE `promotion_jobs` ADD CONSTRAINT `fk_promotion_jobs_1` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "promotion_observations",
    "name": "fk_promotion_observations_0",
    "sql": "ALTER TABLE `promotion_observations` ADD CONSTRAINT `fk_promotion_observations_0` FOREIGN KEY (`credential_version_id`) REFERENCES `credential_versions` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "promotion_observations",
    "name": "fk_promotion_observations_1",
    "sql": "ALTER TABLE `promotion_observations` ADD CONSTRAINT `fk_promotion_observations_1` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "promotion_observations",
    "name": "fk_promotion_observations_2",
    "sql": "ALTER TABLE `promotion_observations` ADD CONSTRAINT `fk_promotion_observations_2` FOREIGN KEY (`job_id`) REFERENCES `promotion_jobs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "oauth_health_results",
    "name": "fk_oauth_health_results_0",
    "sql": "ALTER TABLE `oauth_health_results` ADD CONSTRAINT `fk_oauth_health_results_0` FOREIGN KEY (`credential_version_id`) REFERENCES `credential_versions` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION"
  },
  {
    "table": "oauth_health_results",
    "name": "fk_oauth_health_results_1",
    "sql": "ALTER TABLE `oauth_health_results` ADD CONSTRAINT `fk_oauth_health_results_1` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "oauth_health_results",
    "name": "fk_oauth_health_results_2",
    "sql": "ALTER TABLE `oauth_health_results` ADD CONSTRAINT `fk_oauth_health_results_2` FOREIGN KEY (`job_id`) REFERENCES `oauth_health_jobs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "share_view_dedup",
    "name": "fk_share_view_dedup_0",
    "sql": "ALTER TABLE `share_view_dedup` ADD CONSTRAINT `fk_share_view_dedup_0` FOREIGN KEY (`link_id`) REFERENCES `share_links` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "mail_ingestion_leases",
    "name": "fk_mail_ingestion_leases_0",
    "sql": "ALTER TABLE `mail_ingestion_leases` ADD CONSTRAINT `fk_mail_ingestion_leases_0` FOREIGN KEY (`provider`,`provider_message_id`) REFERENCES `mail_ingestion_state` (`provider`,`provider_message_id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "account_passwords",
    "name": "fk_account_passwords_0",
    "sql": "ALTER TABLE `account_passwords` ADD CONSTRAINT `fk_account_passwords_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "account_business_evidence",
    "name": "fk_account_business_evidence_0",
    "sql": "ALTER TABLE `account_business_evidence` ADD CONSTRAINT `fk_account_business_evidence_0` FOREIGN KEY (`account_id`) REFERENCES `gpt_accounts` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "pending_mail_claims",
    "name": "fk_pending_mail_claims_0",
    "sql": "ALTER TABLE `pending_mail_claims` ADD CONSTRAINT `fk_pending_mail_claims_0` FOREIGN KEY (`message_id`) REFERENCES `mail_messages` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "pending_mail_claims",
    "name": "fk_pending_mail_claims_1",
    "sql": "ALTER TABLE `pending_mail_claims` ADD CONSTRAINT `fk_pending_mail_claims_1` FOREIGN KEY (`pending_id`) REFERENCES `pending_mailboxes` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  },
  {
    "table": "mail_recipient_index",
    "name": "fk_mail_recipient_index_0",
    "sql": "ALTER TABLE `mail_recipient_index` ADD CONSTRAINT `fk_mail_recipient_index_0` FOREIGN KEY (`message_id`) REFERENCES `mail_messages` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION"
  }
];
export const importTables = [
  {
    "name": "schema_meta",
    "columns": [
      {
        "name": "version",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "applied_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "raw_import_records",
    "columns": [
      {
        "name": "source_key",
        "pk": 1,
        "mysqlType": "VARCHAR(255)"
      },
      {
        "name": "source_type",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_path",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_record_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_hash",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "payload_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "imported_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "gpt_accounts",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "lifecycle_status",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "deactivation_locked",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "deactivated_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "admin_deactivated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "retired_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "quarantined_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "quarantine_reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "identity_status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "sold",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "plan",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "billing_channel",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "note",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "payment_link",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "hide_promotion",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "domain_mailbox",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "suspected_unused",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "mark_color",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "group_boundary",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "source_status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "openai_mfa_enabled",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "openai_auth_methods_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "arrived_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "deleted_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "billing_channel_override",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mailbox_families",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "provider",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "canonical_address_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "canonical_address_hash",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "email_bindings",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "mailbox_family_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "email_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "email_hash",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "local_part",
        "pk": 0,
        "mysqlType": "VARCHAR(255)"
      },
      {
        "name": "domain",
        "pk": 0,
        "mysqlType": "VARCHAR(255)"
      },
      {
        "name": "provider",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "valid_from",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "valid_to",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "is_current",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "association_method",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "association_version",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "legacy_mapping_id",
        "pk": 0,
        "mysqlType": "VARCHAR(255)"
      },
      {
        "name": "source_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "receive_disabled_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "account_relations",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "relation_type",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "from_account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "to_account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "changed_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "association_method",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "evidence_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "sales",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "started_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "ended_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "end_reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "first_used_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "last_used_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "routing_endpoints",
    "columns": [
      {
        "name": "email_hash",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "email_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "access_grants",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "sale_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "public_token_hash",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "public_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "legacy_public_token",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "login_identifier_hash",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "login_identifier_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "password_hash",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "password_plain_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "scope",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "visible_from",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "visible_to",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "active",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "first_used_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "last_used_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "revoked_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "revoke_reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "credentials",
    "columns": [
      {
        "name": "account_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "access_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "refresh_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "id_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "session_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "openai_password_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "openai_subject_hash",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "access_token_alive",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "refresh_token_alive",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "access_token_fingerprint",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "access_token_first_seen_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "openai_identity_observations",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "subject_hash",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "first_seen_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "last_seen_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "evidence_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "payment_exposure_checks",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "target",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "ip_country",
        "pk": 0,
        "mysqlType": "VARCHAR(8)"
      },
      {
        "name": "billing_country",
        "pk": 0,
        "mysqlType": "VARCHAR(8)"
      },
      {
        "name": "billing_currency",
        "pk": 0,
        "mysqlType": "VARCHAR(8)"
      },
      {
        "name": "expected_method",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "available_methods_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "matched_methods_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "payment_methods_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "trial_status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "exposed",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "checkout_type",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "detail",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "promo_eligible",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "promo_campaign",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "promo_mode",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "observed_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      }
    ]
  },
  {
    "name": "payment_exposure_jobs",
    "columns": [
      {
        "name": "job_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "remote_job_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "route_key",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "target",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "ip_country",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "billing_country",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "billing_currency",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "job_kind",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "access_token_fingerprint",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "scheduled_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "promo_mode",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "last_error",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "started_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "finished_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      }
    ]
  },
  {
    "name": "mail_messages",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "provider",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "provider_message_id",
        "pk": 0,
        "mysqlType": "VARCHAR(512)"
      },
      {
        "name": "sender",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "recipient_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "subject",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "received_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "folder",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "category",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "is_security",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "metadata_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "indexed_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mail_ownership_claims",
    "columns": [
      {
        "name": "message_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "binding_id",
        "pk": 2,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "claim_type",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "confidence",
        "pk": 0,
        "mysqlType": "DOUBLE"
      },
      {
        "name": "reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "visible_to_customer",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "lifecycle_events",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "event_type",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "occurred_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "payload_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "shadow_sync_runs",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "started_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "finished_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_hash",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "account_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "binding_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "relation_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "recovered_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "detail_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "sub2api_sync_runs",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "started_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "finished_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "total_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "active_openai_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "matched_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "created_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "rebind_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "conflict_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "skipped_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "detail_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "pending_reviews",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "review_type",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "candidate_email_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "candidate_email_hash",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "evidence_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "settings",
    "columns": [
      {
        "name": "key",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "value",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "account_origins",
    "columns": [
      {
        "name": "account_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "source_type",
        "pk": 2,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "source_id",
        "pk": 3,
        "mysqlType": "VARCHAR(255)"
      },
      {
        "name": "is_auto",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "first_seen_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "metadata_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "account_preferences",
    "columns": [
      {
        "name": "account_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "label",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "hide_billing",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "show_deactivation",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "hide_promotion",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "status_message",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "billing_channel_observations",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "channel",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "evidence_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "observed_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "active",
        "pk": 0,
        "mysqlType": "BIGINT"
      }
    ]
  },
  {
    "name": "mailbox_connections",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "mailbox_family_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "provider",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "external_account_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "external_group_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "secret_ref",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "last_checked_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "metadata_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "manager_email_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "credentials_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mail_routing_rules",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "sender_pattern",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "recipient_pattern",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "valid_from",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "valid_to",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "priority",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "binding_transitions",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "from_binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "to_binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "changed_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "method",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "task_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "evidence_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "credential_versions",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "observed_binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "subject_hash",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "access_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "refresh_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "id_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "session_token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "openai_password_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "token_fingerprint",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "first_seen_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "last_seen_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "validity_status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "validity_checked_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "supersedes_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "retired_reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "account_current_credentials",
    "columns": [
      {
        "name": "account_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "credential_version_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "selected_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "selection_reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "credential_observations",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "credential_version_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "binding_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "observed_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "evidence_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "promotion_jobs",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "credential_version_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "campaign",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "region",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "check_kind",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "due_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "attempt",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "error_class",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "error_detail",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "next_retry_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "started_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "finished_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "promotion_observations",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "job_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "credential_version_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "campaign",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "eligible",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "result_status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "upstream_status",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "evidence_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "response_hash",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "checked_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "expires_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "oauth_health_jobs",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "total_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "completed_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "error_count",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "started_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "finished_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "oauth_health_results",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "job_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "account_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "credential_version_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "access_status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "refresh_status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "detail",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "checked_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "change_outbox",
    "columns": [
      {
        "name": "sequence",
        "pk": 1,
        "mysqlType": "BIGINT"
      },
      {
        "name": "event_id",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "aggregate_type",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "aggregate_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "aggregate_version",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "event_type",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "payload_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_system",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "occurred_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "committed_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      }
    ]
  },
  {
    "name": "sync_consumers",
    "columns": [
      {
        "name": "consumer",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "last_sequence",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "last_event_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_cursor",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "sync_conflicts",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "source",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "aggregate_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "expected_version",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "received_version",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "payload_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "source_links",
    "columns": [
      {
        "name": "source_system",
        "pk": 1,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "source_id",
        "pk": 2,
        "mysqlType": "VARCHAR(255)"
      },
      {
        "name": "aggregate_type",
        "pk": 3,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "aggregate_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_version",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "worker_heartbeats",
    "columns": [
      {
        "name": "worker_name",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "artifact_sha256",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "process_id",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "detail_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "heartbeat_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "started_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mailbox_sync_state",
    "columns": [
      {
        "name": "source",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "cursor",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "source_revision",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "lag_seconds",
        "pk": 0,
        "mysqlType": "DOUBLE"
      },
      {
        "name": "last_success_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "last_error",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      }
    ]
  },
  {
    "name": "share_links",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "token_hash",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "token_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "label",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "expires_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "max_views",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "views",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "last_view_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "revoked_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "filters_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "VARCHAR(40)"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "share_view_dedup",
    "columns": [
      {
        "name": "link_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "visitor_hash",
        "pk": 2,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "expires_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mail_read_requests",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "started_at",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "rows_read",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "outcome",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mail_read_control",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "BIGINT"
      },
      {
        "name": "owner",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "lease_until",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "blocked_reason",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "backfill_at",
        "pk": 0,
        "mysqlType": "BIGINT"
      }
    ]
  },
  {
    "name": "mail_read_failures",
    "columns": [
      {
        "name": "request_key",
        "pk": 1,
        "mysqlType": "VARCHAR(255)"
      },
      {
        "name": "retry_after",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "error_code",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mail_ingestion_state",
    "columns": [
      {
        "name": "provider",
        "pk": 1,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "provider_message_id",
        "pk": 2,
        "mysqlType": "VARCHAR(512)"
      },
      {
        "name": "status",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "attempts",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "error_code",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "discovered_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mail_ingestion_leases",
    "columns": [
      {
        "name": "provider",
        "pk": 1,
        "mysqlType": "VARCHAR(64)"
      },
      {
        "name": "provider_message_id",
        "pk": 2,
        "mysqlType": "VARCHAR(512)"
      },
      {
        "name": "owner",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "lease_until",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "retry_after",
        "pk": 0,
        "mysqlType": "BIGINT"
      }
    ]
  },
  {
    "name": "account_passwords",
    "columns": [
      {
        "name": "account_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "password_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "totp_secret_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "account_business_evidence",
    "columns": [
      {
        "name": "account_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "hidden_tags_json",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "mail_verified_no_plus",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "mail_verified_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "recycle_generation",
        "pk": 0,
        "mysqlType": "BIGINT"
      },
      {
        "name": "billing_started_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "last_activity_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "newest_mail_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "audit_binding_id",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "audited_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "pending_mailboxes",
    "columns": [
      {
        "name": "id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "email_hash",
        "pk": 0,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "email_enc",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "kind",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      },
      {
        "name": "updated_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "pending_mail_claims",
    "columns": [
      {
        "name": "pending_id",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "message_id",
        "pk": 2,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "created_at",
        "pk": 0,
        "mysqlType": "LONGTEXT"
      }
    ]
  },
  {
    "name": "mail_recipient_index",
    "columns": [
      {
        "name": "email_hash",
        "pk": 1,
        "mysqlType": "VARCHAR(128)"
      },
      {
        "name": "message_id",
        "pk": 2,
        "mysqlType": "VARCHAR(128)"
      }
    ]
  }
];

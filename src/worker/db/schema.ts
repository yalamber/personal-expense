/**
 * D1 (SQLite) schema for the whole plan.
 *
 * Conventions:
 *  - ids are random UUID strings
 *  - money is stored in minor units (cents) as integers, in the household currency
 *  - timestamps and dates are ISO-8601 strings (sortable, readable in the D1 console)
 *  - rows are never deleted, only voided or marked, so history stays explainable
 *  - every household-owned table carries household_id so access control is one rule
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// ---------------------------------------------------------------------------
// App-wide settings (one row per key), e.g. the generated session-signing secret
// ---------------------------------------------------------------------------

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

// ---------------------------------------------------------------------------
// Household and people
// ---------------------------------------------------------------------------

export const households = sqliteTable("households", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("UTC"),
  monthStartDay: integer("month_start_day").notNull().default(1),
  /**
   * A typical month, typed in when the household starts, so the plan works on day one. Used
   * until the book has a few full months of its own.
   */
  typicalIncomeMinor: integer("typical_income_minor"),
  typicalSpendMinor: integer("typical_spend_minor"),
  /** Secret token in the inbound address: stmt+<token>@domain */
  inboundToken: text("inbound_token").notNull().unique(),
  createdAt: text("created_at").notNull().default(now),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: text("created_at").notNull().default(now),
});

export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    /** Null until the invited person signs in with the matching email. */
    userId: text("user_id").references(() => users.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member", "viewer"] }).notNull().default("member"),
    color: text("color").notNull().default("#0E7C72"),
    invitedAt: text("invited_at").notNull().default(now),
    joinedAt: text("joined_at"),
  },
  (t) => [
    uniqueIndex("members_household_email").on(t.householdId, t.email),
    index("members_user").on(t.userId),
  ],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

export const magicLinks = sqliteTable("magic_links", {
  id: text("id").primaryKey(),
  /** SHA-256 of the token in the emailed link; the token itself is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull().default(now),
});

/**
 * Money we have (checking, savings, cash, mobile wallet, fixed deposit, money lent to someone)
 * and money we owe (credit card, loan). Balances of what we owe are negative.
 */
/**
 * "person" is a contact's khata: a shop, relative or friend the family runs a tab with. Its
 * balance is positive when they owe us and negative when we owe them.
 */
export const accountTypes = ["checking", "savings", "cash", "wallet", "deposit", "lent", "credit", "loan", "person"] as const;
export const depositPayouts = ["maturity", "quarterly", "monthly"] as const;

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    name: text("name").notNull(),
    type: text("type", { enum: accountTypes }).notNull(),
    /** Bank, provider or person: "Nabil Bank", "eSewa", or the friend a loan is from. */
    institution: text("institution"),
    ownerMemberId: text("owner_member_id").references(() => members.id),
    isShared: integer("is_shared", { mode: "boolean" }).notNull().default(true),
    /**
     * Sender allowlist for statement emails, e.g. "alerts@bank.example" or "@bank.example".
     * Several patterns may be separated by commas. Mail from anyone else is quarantined.
     */
    statementSenderPattern: text("statement_sender_pattern"),
    /** JSON CsvMapping (src/shared/csv-mapping.ts) for this bank's CSV export, once mapped. */
    csvMapping: text("csv_mapping"),
    /** Balance the bank showed most recently (from a statement or typed in) and its date. */
    lastStatementBalanceMinor: integer("last_statement_balance_minor"),
    lastStatementAt: text("last_statement_at"),
    /** Balance the book starts from: the bank's figure at the end of this date. */
    openingBalanceMinor: integer("opening_balance_minor"),
    openingBalanceDate: text("opening_balance_date"),
    /** A balance question someone chose to look at later, keyed by the statement date it was about. */
    balanceSnoozedFor: text("balance_snoozed_for"),
    /** The goal this account's money is for (a land FD, an emergency savings account). */
    goalId: text("goal_id"),
    /**
     * Fixed deposits and loans. principal: amount put in or borrowed; rate: yearly, in basis
     * points (8.5% = 850, 0 for a friendly loan); start and end: opened and matures, or borrowed
     * and due to be repaid by.
     */
    principalMinor: integer("principal_minor"),
    rateBp: integer("rate_bp"),
    startDate: text("start_date"),
    endDate: text("end_date"),
    /** Deposits: maturity = interest stays in and compounds quarterly; quarterly/monthly = paid out. */
    depositPayout: text("deposit_payout", { enum: depositPayouts }),
    /** The account deposit interest is paid to, or loan installments are paid from. */
    settleAccountId: text("settle_account_id"),
    /** Loans: the monthly installment (EMI) and the day of the month it is due. */
    installmentMinor: integer("installment_minor"),
    installmentDay: integer("installment_day"),
    /** Contacts: a phone number and a few words about them. */
    phone: text("phone"),
    note: text("note"),
    /** A closed account (a matured FD, a closed card) keeps its history but leaves the totals. */
    closedAt: text("closed_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("accounts_household").on(t.householdId)],
);

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["need", "want", "saving", "transfer", "income"] }).notNull().default("want"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("categories_household").on(t.householdId)],
);

export const merchants = sqliteTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    displayName: text("display_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    /** JSON array of raw descriptions that map to this merchant. */
    aliases: text("aliases").notNull().default("[]"),
    defaultCategoryId: text("default_category_id").references(() => categories.id),
  },
  (t) => [uniqueIndex("merchants_household_norm").on(t.householdId, t.normalizedName)],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    /** YYYY-MM-DD in the household timezone. */
    date: text("date").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    direction: text("direction", { enum: ["out", "in", "transfer"] }).notNull(),
    merchantId: text("merchant_id").references(() => merchants.id),
    categoryId: text("category_id").references(() => categories.id),
    paidByMemberId: text("paid_by_member_id").references(() => members.id),
    /** The description as the bank or the person wrote it, before merchant normalisation. */
    description: text("description"),
    isPersonal: integer("is_personal", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ["manual", "email", "csv", "recurring"] }).notNull(),
    importLineId: text("import_line_id"),
    /** Hash of account, amount and date bucket; used to spot the same transaction twice. */
    dedupeHash: text("dedupe_hash"),
    /** Both sides of a transfer between own accounts share this id. */
    transferPairId: text("transfer_pair_id"),
    note: text("note"),
    /**
     * When a bank statement or alert confirmed this transaction. Lines that arrive from the bank are
     * confirmed when posted; a manual entry is confirmed when a matching bank line turns up.
     */
    confirmedAt: text("confirmed_at"),
    /** The import line that confirmed a manual entry. */
    confirmedLineId: text("confirmed_line_id"),
    /** Set when this transaction is money moved toward a goal. */
    goalId: text("goal_id"),
    voidedAt: text("voided_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("transactions_household_date").on(t.householdId, t.date),
    index("transactions_dedupe").on(t.householdId, t.dedupeHash),
    index("transactions_account_date").on(t.accountId, t.date),
  ],
);

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export const recurringRules = sqliteTable(
  "recurring_rules",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    kind: text("kind", { enum: ["expense", "income"] }).notNull(),
    name: text("name").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    /** RFC 5545 RRULE, e.g. FREQ=MONTHLY;BYMONTHDAY=1 */
    cadence: text("cadence").notNull(),
    nextRun: text("next_run").notNull(),
    endDate: text("end_date"),
    accountId: text("account_id").references(() => accounts.id),
    categoryId: text("category_id").references(() => categories.id),
    merchantId: text("merchant_id").references(() => merchants.id),
    /** JSON array of { from, amountMinor } so price creep can be detected. */
    priceHistory: text("price_history").notNull().default("[]"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("recurring_household").on(t.householdId)],
);

export const incomeStreams = sqliteTable(
  "income_streams",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    name: text("name").notNull(),
    ownerMemberId: text("owner_member_id").references(() => members.id),
    cadence: text("cadence").notNull(),
    expectedNetMinor: integer("expected_net_minor").notNull(),
    variability: text("variability", { enum: ["fixed", "variable", "one_off"] }).notNull().default("fixed"),
    nextExpectedAt: text("next_expected_at"),
    lastReceivedAt: text("last_received_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("income_household").on(t.householdId)],
);

export const budgets = sqliteTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    categoryId: text("category_id").notNull().references(() => categories.id),
    /** YYYY-MM */
    month: text("month").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    rollover: integer("rollover", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("budgets_household_cat_month").on(t.householdId, t.categoryId, t.month)],
);

export const goalKinds = ["safety", "purchase", "build", "education", "other"] as const;

export const goals = sqliteTable(
  "goals",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    name: text("name").notNull(),
    kind: text("kind", { enum: goalKinds }).notNull().default("other"),
    /** Sum of the parts when the goal has parts; otherwise typed in. */
    targetMinor: integer("target_minor").notNull(),
    /** The month the family wants it by, YYYY-MM-DD (first of the month). */
    targetDate: text("target_date"),
    /** Lower comes first; money rolls from a finished goal to the next one in this order. */
    priority: integer("priority").notNull().default(0),
    linkedAccountId: text("linked_account_id").references(() => accounts.id),
    monthlyPlanMinor: integer("monthly_plan_minor"),
    note: text("note"),
    completedAt: text("completed_at"),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("goals_household").on(t.householdId)],
);

/** What a goal's target is made of: cost items for a purchase, stages in order for a build. */
export const goalParts = sqliteTable(
  "goal_parts",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    goalId: text("goal_id").notNull().references(() => goals.id),
    name: text("name").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    sort: integer("sort").notNull().default(0),
    doneAt: text("done_at"),
  },
  (t) => [index("goal_parts_goal").on(t.goalId)],
);

export const contributionKinds = ["saved", "paid", "paid_from_saved"] as const;

export const goalContributions = sqliteTable(
  "goal_contributions",
  {
    id: text("id").primaryKey(),
    goalId: text("goal_id").notNull().references(() => goals.id),
    date: text("date").notNull(),
    /** Positive adds to the goal, negative takes money out (for example, paying a stage). */
    amountMinor: integer("amount_minor").notNull(),
    transactionId: text("transaction_id").references(() => transactions.id),
    note: text("note"),
    memberId: text("member_id").references(() => members.id),
    /**
     * saved: money set aside for the goal. paid: money already paid toward it (a baina or advance
     * to the seller, a builder's stage), from an account or from before the book started.
     * paid_from_saved: paid out of money that was recorded as saved, so it moves from one to the other.
     */
    kind: text("kind", { enum: contributionKinds }).notNull().default("saved"),
  },
  (t) => [index("goal_contributions_goal").on(t.goalId)],
);

// ---------------------------------------------------------------------------
// Ingestion and intelligence
// ---------------------------------------------------------------------------

export const statementEmailStatus = [
  "received", // stored in R2, waiting for the queue
  "quarantined", // sender not on any account's allowlist; admin decides
  "unparsed", // extracted, but no parser matches this sender/subject yet
  "parsed", // import lines written, all auto-posted
  "review", // some import lines need a human decision
  "done", // every line decided
  "failed", // parser threw; raw kept, admin notified
  "forwarding", // a mail provider asking to confirm forwarding; the code is kept in verify_code
] as const;

export const statementEmails = sqliteTable(
  "statement_emails",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    /** Account whose sender allowlist matched, if any. */
    accountId: text("account_id").references(() => accounts.id),
    messageId: text("message_id"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject"),
    receivedAt: text("received_at").notNull().default(now),
    rawSize: integer("raw_size").notNull().default(0),
    /** R2 key of the raw .eml; attachments live under the same prefix. */
    r2Key: text("r2_key").notNull(),
    /** JSON array of { filename, mimeType, size, r2Key } once the consumer has run. */
    attachments: text("attachments").notNull().default("[]"),
    parserKey: text("parser_key"),
    status: text("status", { enum: statementEmailStatus }).notNull().default("received"),
    error: text("error"),
    /** Confirmation code from a forwarding check (for example Gmail's), shown to the family. */
    verifyCode: text("verify_code"),
    processedAt: text("processed_at"),
  },
  (t) => [
    index("statement_emails_household_received").on(t.householdId, t.receivedAt),
    uniqueIndex("statement_emails_household_message").on(t.householdId, t.messageId),
  ],
);

export const importLines = sqliteTable(
  "import_lines",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    statementEmailId: text("statement_email_id").notNull().references(() => statementEmails.id),
    rawText: text("raw_text").notNull(),
    parsedDate: text("parsed_date"),
    parsedAmountMinor: integer("parsed_amount_minor"),
    parsedDescription: text("parsed_description"),
    /** 0..1 confidence of the parse plus categorisation. */
    confidence: integer("confidence").notNull().default(0),
    suggestedCategoryId: text("suggested_category_id").references(() => categories.id),
    matchTransactionId: text("match_transaction_id").references(() => transactions.id),
    /** merged: the line was the bank's copy of a transaction already in the book (match_transaction_id). */
    decision: text("decision", { enum: ["pending", "auto", "accepted", "rejected", "merged"] }).notNull().default("pending"),
    decidedByMemberId: text("decided_by_member_id").references(() => members.id),
    decidedAt: text("decided_at"),
  },
  (t) => [index("import_lines_statement").on(t.statementEmailId)],
);

export const suggestions = sqliteTable(
  "suggestions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    ruleKey: text("rule_key").notNull(),
    title: text("title").notNull(),
    /** JSON: transaction ids and figures that triggered the rule. */
    evidence: text("evidence").notNull().default("{}"),
    estMonthlySavingMinor: integer("est_monthly_saving_minor").notNull().default(0),
    confidence: integer("confidence").notNull().default(0),
    /** 0 invisible, 1 same outcome, 2 slight change, 3 trade-off */
    impactTier: integer("impact_tier").notNull().default(0),
    status: text("status", { enum: ["new", "accepted", "snoozed", "dismissed"] }).notNull().default("new"),
    snoozedUntil: text("snoozed_until"),
    verifiedSavingMinor: integer("verified_saving_minor"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("suggestions_household_status").on(t.householdId, t.status)],
);

export const forecastSnapshots = sqliteTable(
  "forecast_snapshots",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id),
    computedAt: text("computed_at").notNull().default(now),
    horizonMonths: integer("horizon_months").notNull().default(12),
    /** JSON: { months: [{ month, lowMinor, expectedMinor, highMinor }], ... } */
    series: text("series").notNull(),
    safeToSpendMinor: integer("safe_to_spend_minor"),
  },
  (t) => [index("forecast_household_computed").on(t.householdId, t.computedAt)],
);

import { z } from 'zod';

import {
  IsoDateTimeSchema,
  JsonObjectSchema,
  JsonValueSchema,
  NonNegativeNumberSchema,
} from './common.js';
import { IdSchema } from './ids.js';
import { ProviderIdSchema } from './provider.js';

export const GuardActionSchema = z.enum(['allow', 'warn', 'redact', 'pause', 'block']);
export type GuardAction = z.infer<typeof GuardActionSchema>;

export const GuardSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type GuardSeverity = z.infer<typeof GuardSeveritySchema>;

export const GuardRuleKindSchema = z.enum([
  'secret',
  'dangerous_command',
  'loop',
  'budget',
  'egress',
  'custom',
]);
export type GuardRuleKind = z.infer<typeof GuardRuleKindSchema>;

export const GuardRuleSourceSchema = z.enum(['builtin', 'plugin', 'project', 'user']);
export type GuardRuleSource = z.infer<typeof GuardRuleSourceSchema>;

/**
 * Guard rules are data, not code. The per-kind config stays a JSON object on
 * disk so plugins can add fields, but these optional fields are the contract
 * every built-in detector understands.
 */
export const GuardRuleConfigSchema = z.object({
  patterns: z.array(z.string().min(1).max(1000)).max(200).optional(),
  terms: z.array(z.string().min(1).max(500)).max(200).optional(),
  hosts: z.array(z.string().min(1).max(500)).max(200).optional(),
  paths: z.array(z.string().min(1).max(2000)).max(200).optional(),
  threshold: z.number().min(0).max(1).optional(),
  minOccurrences: z.number().int().min(1).max(1000).optional(),
  window: z.number().int().min(1).max(1000).optional(),
  flags: z.string().max(10).optional(),
});
export type GuardRuleConfig = z.infer<typeof GuardRuleConfigSchema>;

export const GuardRuleSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''),
  kind: GuardRuleKindSchema,
  action: GuardActionSchema,
  severity: GuardSeveritySchema,
  source: GuardRuleSourceSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(100),
  config: JsonObjectSchema.default({}),
  createdAt: IsoDateTimeSchema.optional(),
  updatedAt: IsoDateTimeSchema.optional(),
});
export type GuardRule = z.infer<typeof GuardRuleSchema>;

export const GuardRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''),
  kind: GuardRuleKindSchema,
  action: GuardActionSchema,
  severity: GuardSeveritySchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(100),
  config: JsonObjectSchema.default({}),
});
export type GuardRuleInput = z.infer<typeof GuardRuleInputSchema>;

export const GuardRulePatchSchema = GuardRuleInputSchema.partial();
export type GuardRulePatch = z.infer<typeof GuardRulePatchSchema>;

export const GuardRulesResponseSchema = z.object({
  rules: z.array(GuardRuleSchema),
});
export type GuardRulesResponse = z.infer<typeof GuardRulesResponseSchema>;

export const GuardRuleResponseSchema = z.object({
  rule: GuardRuleSchema,
});
export type GuardRuleResponse = z.infer<typeof GuardRuleResponseSchema>;

export const RemoveGuardRuleResponseSchema = z.object({
  removed: z.boolean(),
  id: z.string().min(1).max(100),
});
export type RemoveGuardRuleResponse = z.infer<typeof RemoveGuardRuleResponseSchema>;

export const GuardEventStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'blocked',
  'redacted',
  'warned',
  'expired',
]);
export type GuardEventStatus = z.infer<typeof GuardEventStatusSchema>;

export const GuardEvidenceSchema = z.object({
  field: z.string().max(500).optional(),
  excerpt: z.string().max(20_000).optional(),
  path: z.string().max(4096).optional(),
  line: z.number().int().positive().optional(),
  metadata: JsonObjectSchema.optional(),
});
export type GuardEvidence = z.infer<typeof GuardEvidenceSchema>;

export const GuardEventSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  stepId: IdSchema.optional(),
  ruleId: z.string().min(1).max(100),
  kind: GuardRuleKindSchema,
  action: GuardActionSchema,
  severity: GuardSeveritySchema,
  status: GuardEventStatusSchema,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).default(''),
  command: z.string().max(100_000).optional(),
  evidence: z.array(GuardEvidenceSchema).max(50).default([]),
  requestedAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
  resolvedBy: z.string().max(200).optional(),
  resolutionNote: z.string().max(5000).optional(),
  metadata: JsonObjectSchema.optional(),
});
export type GuardEvent = z.infer<typeof GuardEventSchema>;

export const GuardEventListQuerySchema = z.object({
  sessionId: IdSchema.optional(),
  status: GuardEventStatusSchema.optional(),
  kind: GuardRuleKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type GuardEventListQuery = z.infer<typeof GuardEventListQuerySchema>;

export const GuardEventsResponseSchema = z.object({
  events: z.array(GuardEventSchema),
});
export type GuardEventsResponse = z.infer<typeof GuardEventsResponseSchema>;

export const GuardEventResponseSchema = z.object({
  event: GuardEventSchema,
});
export type GuardEventResponse = z.infer<typeof GuardEventResponseSchema>;

export const BudgetScopeSchema = z.enum(['session', 'project', 'global']);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

export const BudgetPeriodSchema = z.enum(['session', 'day', 'week', 'month']);
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;

export const BudgetEnforcementSchema = z.enum(['warn', 'pause', 'block']);
export type BudgetEnforcement = z.infer<typeof BudgetEnforcementSchema>;

export const BudgetPolicySchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  scope: BudgetScopeSchema,
  period: BudgetPeriodSchema,
  projectId: IdSchema.optional(),
  sessionId: IdSchema.optional(),
  limitUsd: NonNegativeNumberSchema,
  enforcement: BudgetEnforcementSchema,
  enabled: z.boolean().default(true),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const BudgetPolicyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    scope: BudgetScopeSchema,
    period: BudgetPeriodSchema,
    projectId: IdSchema.optional(),
    sessionId: IdSchema.optional(),
    limitUsd: NonNegativeNumberSchema,
    enforcement: BudgetEnforcementSchema,
    enabled: z.boolean().default(true),
  })
  .superRefine((policy, context) => {
    if (policy.scope === 'session' && !policy.sessionId) {
      context.addIssue({
        code: 'custom',
        message: 'A session-scoped budget requires sessionId.',
        path: ['sessionId'],
      });
    }
    if (policy.scope === 'project' && !policy.projectId) {
      context.addIssue({
        code: 'custom',
        message: 'A project-scoped budget requires projectId.',
        path: ['projectId'],
      });
    }
  });
export type BudgetPolicyInput = z.infer<typeof BudgetPolicyInputSchema>;

/**
 * Patches are validated against the merged policy by the daemon so a partial
 * update such as `{ scope: 'session' }` can rely on the stored sessionId.
 */
export const BudgetPolicyPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  scope: BudgetScopeSchema.optional(),
  period: BudgetPeriodSchema.optional(),
  projectId: IdSchema.optional(),
  sessionId: IdSchema.optional(),
  limitUsd: NonNegativeNumberSchema.optional(),
  enforcement: BudgetEnforcementSchema.optional(),
  enabled: z.boolean().optional(),
});
export type BudgetPolicyPatch = z.infer<typeof BudgetPolicyPatchSchema>;

export const BudgetPoliciesResponseSchema = z.object({
  policies: z.array(BudgetPolicySchema),
});
export type BudgetPoliciesResponse = z.infer<typeof BudgetPoliciesResponseSchema>;

export const BudgetPolicyResponseSchema = z.object({
  policy: BudgetPolicySchema,
});
export type BudgetPolicyResponse = z.infer<typeof BudgetPolicyResponseSchema>;

export const RemoveBudgetPolicyResponseSchema = z.object({
  removed: z.boolean(),
  id: IdSchema,
});
export type RemoveBudgetPolicyResponse = z.infer<typeof RemoveBudgetPolicyResponseSchema>;

export const BudgetStatusSchema = z.object({
  policyId: IdSchema,
  name: z.string().min(1).max(200),
  limitUsd: NonNegativeNumberSchema,
  spentUsd: NonNegativeNumberSchema,
  remainingUsd: NonNegativeNumberSchema,
  usageRatio: NonNegativeNumberSchema,
  warning: z.boolean(),
  exceeded: z.boolean(),
  enforcement: BudgetEnforcementSchema,
  period: BudgetPeriodSchema,
  periodStart: IsoDateTimeSchema,
});
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

export const BudgetStatusResponseSchema = z.object({
  statuses: z.array(BudgetStatusSchema),
});
export type BudgetStatusResponse = z.infer<typeof BudgetStatusResponseSchema>;

/**
 * UTC period boundaries keep budget math identical across time zones and
 * machines. Session periods start when the session started.
 */
export function budgetPeriodStart(
  period: BudgetPeriod,
  now: Date = new Date(),
  sessionStartedAt?: Date,
): Date {
  if (period === 'session') {
    return new Date(sessionStartedAt ?? new Date(0));
  }
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  if (period === 'day') return start;
  if (period === 'week') {
    const day = start.getUTCDay();
    const offset = day === 0 ? 6 : day - 1;
    start.setUTCDate(start.getUTCDate() - offset);
    return start;
  }
  start.setUTCDate(1);
  return start;
}

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  note: z.string().max(5000).optional(),
  actor: z.string().max(200).optional(),
  channel: z.enum(['dashboard', 'cli', 'android', 'desktop']).default('dashboard'),
  provider: ProviderIdSchema.optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const RedactionSchema = z.object({
  ruleId: z.string().max(100),
  label: z.string().max(200),
  occurrences: z.number().int().nonnegative(),
  location: z.enum(['request_headers', 'request_body', 'response_headers', 'response_body']),
});
export type Redaction = z.infer<typeof RedactionSchema>;

export const SecretFindingSchema = z.object({
  type: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
  preview: z.string().max(500),
  location: z.enum(['request_headers', 'request_body', 'response_headers', 'response_body']),
  action: GuardActionSchema,
});
export type SecretFinding = z.infer<typeof SecretFindingSchema>;

export const SecretScanResponseSchema = z.object({
  sessionId: IdSchema,
  scannedAt: IsoDateTimeSchema,
  findings: z.array(SecretFindingSchema),
  events: z.array(GuardEventSchema),
  filesExamined: z.number().int().nonnegative(),
});
export type SecretScanResponse = z.infer<typeof SecretScanResponseSchema>;

export const LoopSampleSchema = z.object({
  signature: z.string().max(5000),
  similarity: z.number().min(0).max(1),
  occurrences: z.number().int().positive(),
  firstSeenAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  metadata: JsonObjectSchema.optional(),
});
export type LoopSample = z.infer<typeof LoopSampleSchema>;

export const GuardSignalSchema = z.object({
  ruleId: z.string().max(100),
  kind: GuardRuleKindSchema,
  action: GuardActionSchema,
  severity: GuardSeveritySchema,
  title: z.string().max(300),
  detail: z.string().max(5000).optional(),
  evidence: JsonValueSchema.optional(),
});
export type GuardSignal = z.infer<typeof GuardSignalSchema>;

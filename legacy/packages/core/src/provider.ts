import { z } from 'zod';

export const ProviderProtocolSchema = z.enum(['openai', 'anthropic']);
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;

export const ProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const AgentInfoSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  version: z.string().trim().max(100).optional(),
  userAgent: z.string().max(500).optional(),
  detectedFrom: z.enum(['headers', 'wrapper', 'manual', 'demo', 'unknown']).default('unknown'),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const ModelRefSchema = z.object({
  provider: ProviderIdSchema.optional(),
  protocol: ProviderProtocolSchema.optional(),
  model: z.string().trim().min(1).max(200),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const KNOWN_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  azure: 'Azure OpenAI',
  google: 'Google',
};

import {
  KNOWN_PROVIDER_LABELS,
  totalTokens,
  type Session,
  type SessionStatus,
  type SessionTotals,
} from '@cockpit/core';

export function providerLabel(provider: string | undefined): string {
  if (!provider) return 'Provider not recorded';
  return KNOWN_PROVIDER_LABELS[provider] ?? provider;
}

export function agentLabel(session: Session): string {
  const name = session.agent?.name;
  if (!name) return 'Unattributed agent';
  const version = session.agent?.version;
  return version ? `${name} ${version}` : name;
}

export function modelLabel(session: Session): string {
  const provider = session.modelRef?.provider;
  const model = session.modelRef?.model;
  if (model && provider) return `${providerLabel(provider)} · ${model}`;
  if (model) return model;
  return 'Model not recorded';
}

export function sessionTokenTotal(totals: SessionTotals): number {
  return totalTokens(totals);
}

export function isSessionLive(status: SessionStatus): boolean {
  return status === 'active';
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function eventTypeLabel(type: string): string {
  switch (type) {
    case 'session.started':
      return 'Session opened';
    case 'session.updated':
      return 'Totals updated';
    case 'session.completed':
      return 'Session completed';
    case 'session.killed':
      return 'Session killed';
    case 'step.started':
      return 'Step started';
    case 'step.completed':
      return 'Step completed';
    case 'stream.chunk':
      return 'Streaming';
    case 'tool.started':
      return 'Tool started';
    case 'tool.completed':
      return 'Tool completed';
    case 'guard.triggered':
      return 'Guard triggered';
    case 'guard.resolved':
      return 'Guard resolved';
    case 'budget.warning':
      return 'Budget warning';
    case 'budget.exceeded':
      return 'Budget exceeded';
    case 'understanding.updated':
      return 'Understanding updated';
    case 'analysis.updated':
      return 'Analysis updated';
    case 'pairing.requested':
      return 'Pairing requested';
    default:
      return type;
  }
}

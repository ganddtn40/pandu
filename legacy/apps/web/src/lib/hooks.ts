import type {
  AnalyticsQuery,
  AnalyticsResponse,
  ArenaRun,
  ArenaRunInput,
  BrainFormat,
  BrainProjectStatus,
  BrainSyncResponse,
  BudgetPolicy,
  BudgetStatus,
  CapturedStep,
  CheatAnalysis,
  ContextSnapshotDetailResponse,
  CreateReplayForkInput,
  Device,
  GuardEvent,
  GuardRule,
  HandoffBrief,
  JournalEntry,
  LiveEvent,
  OverviewStats,
  PairingSession,
  PairingSessionStatus,
  Plugin,
  PluginRun,
  PluginRunInput,
  Project,
  QuizSubmitInput,
  QuizSubmitResponse,
  QuizView,
  ReplayFork,
  SecretScanResponse,
  Session,
  SessionContextResponse,
  SessionProvenanceResponse,
  SessionReplayResponse,
  SessionStepsResponse,
  SnapshotDetailResponse,
  StepDetailResponse,
  UnderstandingDebtSummary,
  UnderstandingDetailResponse,
  UnderstandingFileView,
} from '@cockpit/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from './api-context';
import { describeError, type SessionStatusFilter } from './api';
import { useLiveSubscription } from './live';

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

export interface StatsResource {
  stats: OverviewStats | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

export function useStats(): StatsResource {
  const client = useApiClient();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.stats({ signal: controller.signal });
        if (controller.signal.aborted) return;
        setStats(response.stats);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  return { stats, error, loading, refreshing, refresh };
}

export interface SessionFiltersState {
  search: string;
  status: SessionStatusFilter;
  limit?: number;
}

export interface SessionsResource {
  sessions: Session[];
  nextCursor: string | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  refresh: () => void;
  loadMore: () => void;
}

export function useSessions(filters: SessionFiltersState): SessionsResource {
  const client = useApiClient();
  const { search, status, limit = 50 } = filters;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (cursor: string | null, mode: 'initial' | 'refresh' | 'more') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      if (mode === 'more') setLoadingMore(true);

      try {
        const response = await client.listSessions(
          {
            search,
            status,
            ...(cursor ? { cursor } : {}),
            limit,
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        setSessions((previous) =>
          mode === 'more' ? [...previous, ...response.sessions] : response.sessions,
        );
        setNextCursor(response.nextCursor);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [client, search, status, limit],
  );

  useEffect(() => {
    void load(null, 'initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load(null, 'refresh');
  }, [load]);

  const loadMore = useCallback(() => {
    if (nextCursor === null || loadingMore) return;
    void load(nextCursor, 'more');
  }, [load, nextCursor, loadingMore]);

  return {
    sessions,
    nextCursor,
    error,
    loading,
    refreshing,
    loadingMore,
    refresh,
    loadMore,
  };
}

export interface SessionDetailResource {
  session: Session | null;
  steps: CapturedStep[];
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

export interface SessionDetailOptions {
  stepsLimit?: number;
}

export function useSessionDetail(
  sessionId: string,
  options: SessionDetailOptions = {},
): SessionDetailResource {
  const client = useApiClient();
  const { stepsLimit = 2000 } = options;
  const [session, setSession] = useState<Session | null>(null);
  const [steps, setSteps] = useState<CapturedStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const [sessionResponse, stepsResponse]: [{ session: Session }, SessionStepsResponse] =
          await Promise.all([
            client.getSession(sessionId, { signal: controller.signal }),
            client.getSessionSteps(sessionId, {
              signal: controller.signal,
              limit: stepsLimit,
            }),
          ]);
        if (controller.signal.aborted) return;

        setSession(sessionResponse.session);
        setSteps(stepsResponse.steps);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, sessionId, stepsLimit],
  );

  useEffect(() => {
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  return { session, steps, error, loading, refreshing, refresh };
}

export interface StepDetailResource {
  data: StepDetailResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useStepDetail(stepId: string | null): StepDetailResource {
  const client = useApiClient();
  const [data, setData] = useState<StepDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(stepId !== null);
  const [version, setVersion] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(stepId !== null);
  }, [stepId]);

  useEffect(() => {
    if (stepId === null) {
      controllerRef.current?.abort();
      setLoading(false);
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);

    void (async () => {
      try {
        const response = await client.getStep(stepId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [client, stepId, version]);

  const refresh = useCallback(() => {
    setVersion((value) => value + 1);
  }, []);

  return { data, error, loading, refresh };
}

export interface SessionReplayResource {
  replay: SessionReplayResponse | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

export function useSessionReplay(sessionId: string): SessionReplayResource {
  const client = useApiClient();
  const [replay, setReplay] = useState<SessionReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.getSessionReplay(sessionId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setReplay(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, sessionId],
  );

  useEffect(() => {
    setReplay(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  return { replay, error, loading, refreshing, refresh };
}

export interface SnapshotDetailResource {
  data: SnapshotDetailResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Snapshot diffs never change once captured, so scrubbing back and forth uses
 * an in-memory cache instead of re-downloading the same patch.
 */
export function useSnapshotDetail(snapshotId: string | null): SnapshotDetailResource {
  const client = useApiClient();
  const cacheRef = useRef(new Map<string, SnapshotDetailResponse>());
  const [data, setData] = useState<SnapshotDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(snapshotId !== null);
  const [version, setVersion] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setError(null);

    if (snapshotId === null) {
      setData(null);
      setLoading(false);
      return;
    }

    const cached = cacheRef.current.get(snapshotId);
    if (cached) {
      setData(cached);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setData(null);
    setLoading(true);

    void (async () => {
      try {
        const response = await client.getSnapshot(snapshotId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        cacheRef.current.set(snapshotId, response);
        setData(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [client, snapshotId, version]);

  const refresh = useCallback(() => {
    if (snapshotId !== null) cacheRef.current.delete(snapshotId);
    setVersion((value) => value + 1);
  }, [snapshotId]);

  return { data, error, loading, refresh };
}

export interface ReplayForkActionsResource {
  creating: boolean;
  removingId: string | null;
  error: string | null;
  clearError: () => void;
  createFork: (input?: CreateReplayForkInput) => Promise<ReplayFork | null>;
  removeFork: (forkId: string) => Promise<ReplayFork | null>;
}

export function useReplayForkActions(
  sessionId: string,
  onChange: () => void,
): ReplayForkActionsResource {
  const client = useApiClient();
  const onChangeRef = useRef(onChange);
  const [creating, setCreating] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const createFork = useCallback(
    async (input: CreateReplayForkInput = {}): Promise<ReplayFork | null> => {
      setCreating(true);
      setError(null);
      try {
        const response = await client.createFork(sessionId, input);
        onChangeRef.current();
        return response.fork;
      } catch (createError) {
        setError(describeError(createError));
        return null;
      } finally {
        setCreating(false);
      }
    },
    [client, sessionId],
  );

  const removeFork = useCallback(
    async (forkId: string): Promise<ReplayFork | null> => {
      setRemovingId(forkId);
      setError(null);
      try {
        const response = await client.removeFork(forkId);
        onChangeRef.current();
        return response.fork;
      } catch (removeError) {
        setError(describeError(removeError));
        return null;
      } finally {
        setRemovingId(null);
      }
    },
    [client],
  );

  const clearError = useCallback(() => setError(null), []);

  return { creating, removingId, error, clearError, createFork, removeFork };
}

export interface GuardsResource {
  rules: GuardRule[];
  events: GuardEvent[];
  policies: BudgetPolicy[];
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  busyId: string | null;
  refresh: () => void;
  clearActionError: () => void;
  toggleRule: (rule: GuardRule) => Promise<boolean>;
  decideEvent: (eventId: string, decision: 'approve' | 'deny') => Promise<boolean>;
  removePolicy: (policyId: string) => Promise<boolean>;
}

export function useGuards(): GuardsResource {
  const client = useApiClient();
  const [rules, setRules] = useState<GuardRule[]>([]);
  const [events, setEvents] = useState<GuardEvent[]>([]);
  const [policies, setPolicies] = useState<BudgetPolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const [ruleList, eventList, policyList] = await Promise.all([
          client.listGuardRules({ signal: controller.signal }),
          client.listGuardEvents({ limit: 200 }, { signal: controller.signal }),
          client.listBudgetPolicies({ signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setRules(ruleList);
        setEvents(eventList);
        setPolicies(policyList);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const toggleRule = useCallback(
    async (rule: GuardRule): Promise<boolean> => {
      setBusyId(rule.id);
      setActionError(null);
      try {
        const updated = await client.updateGuardRule(rule.id, { enabled: !rule.enabled });
        setRules((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [client],
  );

  const decideEvent = useCallback(
    async (eventId: string, decision: 'approve' | 'deny'): Promise<boolean> => {
      setBusyId(eventId);
      setActionError(null);
      try {
        const updated = await client.decideGuardEvent(eventId, {
          decision,
          channel: 'dashboard',
        });
        setEvents((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [client],
  );

  const removePolicy = useCallback(
    async (policyId: string): Promise<boolean> => {
      setBusyId(policyId);
      setActionError(null);
      try {
        await client.deleteBudgetPolicy(policyId);
        setPolicies((previous) => previous.filter((item) => item.id !== policyId));
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [client],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return {
    rules,
    events,
    policies,
    error,
    actionError,
    loading,
    refreshing,
    busyId,
    refresh,
    clearActionError,
    toggleRule,
    decideEvent,
    removePolicy,
  };
}

export interface TrustResource {
  analysis: CheatAnalysis | null;
  budgets: BudgetStatus[];
  scanResult: SecretScanResponse | null;
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  analyzing: boolean;
  scanning: boolean;
  refresh: () => void;
  recompute: () => Promise<boolean>;
  scan: () => Promise<boolean>;
}

export function useTrust(sessionId: string): TrustResource {
  const client = useApiClient();
  const [analysis, setAnalysis] = useState<CheatAnalysis | null>(null);
  const [budgets, setBudgets] = useState<BudgetStatus[]>([]);
  const [scanResult, setScanResult] = useState<SecretScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const [trust, statuses] = await Promise.all([
          client.getTrust(sessionId, { signal: controller.signal }),
          client.getSessionBudgets(sessionId, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setAnalysis(trust.analysis);
        setBudgets(statuses);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, sessionId],
  );

  useEffect(() => {
    setAnalysis(null);
    setScanResult(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const recompute = useCallback(async (): Promise<boolean> => {
    setAnalyzing(true);
    setActionError(null);
    try {
      const response = await client.analyzeTrust(sessionId);
      setAnalysis(response.analysis);
      return true;
    } catch (actionFailure) {
      setActionError(describeError(actionFailure));
      return false;
    } finally {
      setAnalyzing(false);
    }
  }, [client, sessionId]);

  const scan = useCallback(async (): Promise<boolean> => {
    setScanning(true);
    setActionError(null);
    try {
      const result = await client.scanSession(sessionId);
      setScanResult(result);
      return true;
    } catch (actionFailure) {
      setActionError(describeError(actionFailure));
      return false;
    } finally {
      setScanning(false);
    }
  }, [client, sessionId]);

  return {
    analysis,
    budgets,
    scanResult,
    error,
    actionError,
    loading,
    refreshing,
    analyzing,
    scanning,
    refresh,
    recompute,
    scan,
  };
}

export interface DebtResource {
  files: UnderstandingFileView[];
  summary: UnderstandingDebtSummary | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

export function useDebt(sessionId?: string): DebtResource {
  const client = useApiClient();
  const [files, setFiles] = useState<UnderstandingFileView[]>([]);
  const [summary, setSummary] = useState<UnderstandingDebtSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = sessionId
          ? await client.listSessionUnderstanding(sessionId, {}, { signal: controller.signal })
          : await client.listUnderstanding({}, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setFiles(response.files);
        setSummary(response.summary);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, sessionId],
  );

  useEffect(() => {
    setFiles([]);
    setSummary(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  return { files, summary, error, loading, refreshing, refresh };
}

export interface UnderstandingDetailResource {
  detail: UnderstandingDetailResponse | null;
  explanation: string | null;
  quiz: QuizView | null;
  quizResult: QuizSubmitResponse | null;
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  busy: string | null;
  refresh: () => void;
  clearActionError: () => void;
  open: () => Promise<boolean>;
  acknowledge: () => Promise<boolean>;
  explain: () => Promise<boolean>;
  startQuiz: () => Promise<boolean>;
  submitQuiz: (input: QuizSubmitInput) => Promise<boolean>;
}

export function useUnderstandingDetail(understandingId: string): UnderstandingDetailResource {
  const client = useApiClient();
  const [detail, setDetail] = useState<UnderstandingDetailResponse | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<QuizView | null>(null);
  const [quizResult, setQuizResult] = useState<QuizSubmitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.getUnderstanding(understandingId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDetail(response);
        if (response.file.explanation) setExplanation(response.file.explanation);
        const latest = response.quizzes.find((item) => item.completedAt === undefined);
        if (latest) setQuiz(latest);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, understandingId],
  );

  useEffect(() => {
    setDetail(null);
    setExplanation(null);
    setQuiz(null);
    setQuizResult(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const clearActionError = useCallback(() => setActionError(null), []);

  const open = useCallback(async (): Promise<boolean> => {
    setBusy('open');
    setActionError(null);
    try {
      const response = await client.openUnderstanding(understandingId);
      setDetail((previous) => (previous ? { ...previous, file: response.file } : previous));
      return true;
    } catch (actionFailure) {
      setActionError(describeError(actionFailure));
      return false;
    } finally {
      setBusy(null);
    }
  }, [client, understandingId]);

  const acknowledge = useCallback(async (): Promise<boolean> => {
    setBusy('acknowledge');
    setActionError(null);
    try {
      const response = await client.acknowledgeUnderstanding(understandingId);
      setDetail((previous) => (previous ? { ...previous, file: response.file } : previous));
      return true;
    } catch (actionFailure) {
      setActionError(describeError(actionFailure));
      return false;
    } finally {
      setBusy(null);
    }
  }, [client, understandingId]);

  const explain = useCallback(async (): Promise<boolean> => {
    setBusy('explain');
    setActionError(null);
    try {
      const response = await client.explainUnderstanding(understandingId);
      setExplanation(response.explanation);
      return true;
    } catch (actionFailure) {
      setActionError(describeError(actionFailure));
      return false;
    } finally {
      setBusy(null);
    }
  }, [client, understandingId]);

  const startQuiz = useCallback(async (): Promise<boolean> => {
    setBusy('quiz');
    setActionError(null);
    try {
      const response = await client.startUnderstandingQuiz(understandingId);
      setQuiz(response.quiz);
      setQuizResult(null);
      return true;
    } catch (actionFailure) {
      setActionError(describeError(actionFailure));
      return false;
    } finally {
      setBusy(null);
    }
  }, [client, understandingId]);

  const submitQuiz = useCallback(
    async (input: QuizSubmitInput): Promise<boolean> => {
      if (!quiz) return false;
      setBusy('submit');
      setActionError(null);
      try {
        const response = await client.submitUnderstandingQuiz(quiz.id, input);
        setQuizResult(response);
        setQuiz(response.quiz);
        await load('refresh');
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [client, quiz, load],
  );

  return {
    detail,
    explanation,
    quiz,
    quizResult,
    error,
    actionError,
    loading,
    refreshing,
    busy,
    refresh,
    clearActionError,
    open,
    acknowledge,
    explain,
    startQuiz,
    submitQuiz,
  };
}

export interface ContextDoctorResource {
  context: SessionContextResponse | null;
  detail: ContextSnapshotDetailResponse | null;
  selectedSnapshotId: string | null;
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  recomputing: boolean;
  refresh: () => void;
  selectSnapshot: (snapshotId: string) => void;
  recompute: () => Promise<boolean>;
}

export function useContextDoctor(sessionId: string): ContextDoctorResource {
  const client = useApiClient();
  const [context, setContext] = useState<SessionContextResponse | null>(null);
  const [detail, setDetail] = useState<ContextSnapshotDetailResponse | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const loadDetail = useCallback(
    async (snapshotId: string, signal: AbortSignal) => {
      const response = await client.getContextSnapshot(snapshotId, { signal });
      if (signal.aborted) return;
      setDetail(response);
      setSelectedSnapshotId(snapshotId);
    },
    [client],
  );

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.getSessionContext(sessionId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setContext(response);
        setError(null);
        if (response.latest) {
          await loadDetail(response.latest.id, controller.signal);
        } else {
          setDetail(null);
          setSelectedSnapshotId(null);
        }
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, sessionId, loadDetail],
  );

  useEffect(() => {
    setContext(null);
    setDetail(null);
    setSelectedSnapshotId(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const selectSnapshot = useCallback(
    (snapshotId: string) => {
      const controller = new AbortController();
      controllerRef.current?.abort();
      controllerRef.current = controller;
      setActionError(null);
      void loadDetail(snapshotId, controller.signal).catch((loadError: unknown) => {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setActionError(describeError(loadError));
      });
    },
    [loadDetail],
  );

  const recompute = useCallback(async (): Promise<boolean> => {
    setRecomputing(true);
    setActionError(null);
    try {
      const response = await client.recomputeSessionContext(sessionId);
      setContext(response);
      if (response.latest) {
        const controller = new AbortController();
        controllerRef.current?.abort();
        controllerRef.current = controller;
        await loadDetail(response.latest.id, controller.signal);
      } else {
        setDetail(null);
        setSelectedSnapshotId(null);
      }
      return true;
    } catch (actionFailure) {
      setActionError(describeError(actionFailure));
      return false;
    } finally {
      setRecomputing(false);
    }
  }, [client, sessionId, loadDetail]);

  return {
    context,
    detail,
    selectedSnapshotId,
    error,
    actionError,
    loading,
    refreshing,
    recomputing,
    refresh,
    selectSnapshot,
    recompute,
  };
}

export interface ProvenanceResource {
  provenance: SessionProvenanceResponse | null;
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  recomputing: boolean;
  refresh: () => void;
  recompute: () => Promise<boolean>;
}

export function useProvenance(sessionId: string): ProvenanceResource {
  const client = useApiClient();
  const [provenance, setProvenance] = useState<SessionProvenanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.getSessionProvenance(sessionId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setProvenance(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, sessionId],
  );

  useEffect(() => {
    setProvenance(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const recompute = useCallback(async (): Promise<boolean> => {
    setRecomputing(true);
    setActionError(null);
    try {
      const response = await client.recomputeSessionProvenance(sessionId);
      setProvenance(response);
      return true;
    } catch (actionFailure) {
      setActionError(describeError(actionFailure));
      return false;
    } finally {
      setRecomputing(false);
    }
  }, [client, sessionId]);

  return {
    provenance,
    error,
    actionError,
    loading,
    refreshing,
    recomputing,
    refresh,
    recompute,
  };
}

export interface AnalyticsResource {
  data: AnalyticsResponse | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

export function useAnalytics(query: Partial<AnalyticsQuery> = {}): AnalyticsResource {
  const client = useApiClient();
  const { days = 30, projectId, agent } = query;
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.getAnalytics(
          {
            days,
            ...(projectId ? { projectId } : {}),
            ...(agent ? { agent } : {}),
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setData(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [agent, client, days, projectId],
  );

  useEffect(() => {
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  return { data, error, loading, refreshing, refresh };
}

export interface ProjectsResource {
  projects: Project[];
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

export function useProjects(): ProjectsResource {
  const client = useApiClient();
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.listProjects({ signal: controller.signal });
        if (controller.signal.aborted) return;
        setProjects(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  return { projects, error, loading, refreshing, refresh };
}

export interface BrainSyncOptions {
  formats?: BrainFormat[];
  force?: boolean;
  dryRun?: boolean;
}

export interface BrainResource {
  status: BrainProjectStatus | null;
  syncResult: BrainSyncResponse | null;
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  generating: boolean;
  syncing: boolean;
  refresh: () => void;
  clearActionError: () => void;
  generate: (formats?: BrainFormat[]) => Promise<boolean>;
  sync: (options?: BrainSyncOptions) => Promise<boolean>;
}

export function useBrain(projectId: string | null): BrainResource {
  const client = useApiClient();
  const [status, setStatus] = useState<BrainProjectStatus | null>(null);
  const [syncResult, setSyncResult] = useState<BrainSyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(projectId !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      if (projectId === null) {
        setStatus(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.getBrainStatus(projectId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, projectId],
  );

  useEffect(() => {
    setStatus(null);
    setSyncResult(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const clearActionError = useCallback(() => setActionError(null), []);

  const generate = useCallback(
    async (formats?: BrainFormat[]): Promise<boolean> => {
      if (!projectId) return false;
      setGenerating(true);
      setActionError(null);
      try {
        const response = await client.generateBrain(projectId, formats);
        setStatus(response);
        setSyncResult(null);
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setGenerating(false);
      }
    },
    [client, projectId],
  );

  const sync = useCallback(
    async (options: BrainSyncOptions = {}): Promise<boolean> => {
      if (!projectId) return false;
      setSyncing(true);
      setActionError(null);
      try {
        const response = await client.syncBrain(projectId, {
          ...(options.formats ? { formats: options.formats } : {}),
          force: options.force === true,
          dryRun: options.dryRun === true,
        });
        setSyncResult(response);
        setStatus(response.status);
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setSyncing(false);
      }
    },
    [client, projectId],
  );

  return {
    status,
    syncResult,
    error,
    actionError,
    loading,
    refreshing,
    generating,
    syncing,
    refresh,
    clearActionError,
    generate,
    sync,
  };
}

export interface SessionStepsResource {
  steps: CapturedStep[];
  error: string | null;
  loading: boolean;
}

export function useSessionSteps(sessionId: string | null): SessionStepsResource {
  const client = useApiClient();
  const [steps, setSteps] = useState<CapturedStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(sessionId !== null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    if (sessionId === null) {
      setSteps([]);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setSteps([]);
    setLoading(true);

    void (async () => {
      try {
        const response = await client.getSessionSteps(sessionId, {
          signal: controller.signal,
          limit: 500,
        });
        if (controller.signal.aborted) return;
        setSteps(response.steps);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [client, sessionId]);

  return { steps, error, loading };
}

export interface ArenaResource {
  runs: ArenaRun[];
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  running: boolean;
  refresh: () => void;
  clearActionError: () => void;
  run: (sessionId: string, input: ArenaRunInput) => Promise<ArenaRun[] | null>;
}

export function useArenaRuns(limit = 20): ArenaResource {
  const client = useApiClient();
  const [runs, setRuns] = useState<ArenaRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.listArenaRuns({ limit }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRuns(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, limit],
  );

  useEffect(() => {
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const clearActionError = useCallback(() => setActionError(null), []);

  const run = useCallback(
    async (sessionId: string, input: ArenaRunInput): Promise<ArenaRun[] | null> => {
      setRunning(true);
      setActionError(null);
      try {
        const created = await client.runArena(sessionId, input);
        setRuns((previous) => [...created, ...previous].slice(0, Math.max(limit, created.length)));
        return created;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return null;
      } finally {
        setRunning(false);
      }
    },
    [client, limit],
  );

  return {
    runs,
    error,
    actionError,
    loading,
    refreshing,
    running,
    refresh,
    clearActionError,
    run,
  };
}

export interface HandoffResource {
  briefs: HandoffBrief[];
  selected: HandoffBrief | null;
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  generating: boolean;
  refresh: () => void;
  select: (briefId: string) => void;
  generate: (stepId?: string) => Promise<HandoffBrief | null>;
}

export function useHandoffs(sessionId: string): HandoffResource {
  const client = useApiClient();
  const [briefs, setBriefs] = useState<HandoffBrief[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.listHandoffs(sessionId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setBriefs(response);
        setSelectedId((previous) => {
          if (previous && response.some((brief) => brief.id === previous)) return previous;
          return response[0]?.id ?? null;
        });
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, sessionId],
  );

  useEffect(() => {
    setBriefs([]);
    setSelectedId(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const select = useCallback((briefId: string) => setSelectedId(briefId), []);

  const generate = useCallback(
    async (stepId?: string): Promise<HandoffBrief | null> => {
      setGenerating(true);
      setActionError(null);
      try {
        const brief = await client.generateHandoff(sessionId, stepId ? { stepId } : {});
        setBriefs((previous) => [brief, ...previous.filter((item) => item.id !== brief.id)]);
        setSelectedId(brief.id);
        return brief;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return null;
      } finally {
        setGenerating(false);
      }
    },
    [client, sessionId],
  );

  const selected = briefs.find((brief) => brief.id === selectedId) ?? briefs[0] ?? null;

  return {
    briefs,
    selected,
    error,
    actionError,
    loading,
    refreshing,
    generating,
    refresh,
    select,
    generate,
  };
}

export interface JournalResource {
  entries: JournalEntry[];
  selected: JournalEntry | null;
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  generating: boolean;
  refresh: () => void;
  select: (entryId: string) => void;
  generate: (input?: { projectId?: string; weekStart?: string }) => Promise<JournalEntry | null>;
}

export function useJournal(projectId?: string): JournalResource {
  const client = useApiClient();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.listJournal(
          { ...(projectId ? { projectId } : {}) },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setEntries(response);
        setSelectedId((previous) => {
          if (previous && response.some((entry) => entry.id === previous)) return previous;
          return response[0]?.id ?? null;
        });
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, projectId],
  );

  useEffect(() => {
    setEntries([]);
    setSelectedId(null);
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const select = useCallback((entryId: string) => setSelectedId(entryId), []);

  const generate = useCallback(
    async (
      input: { projectId?: string; weekStart?: string } = {},
    ): Promise<JournalEntry | null> => {
      setGenerating(true);
      setActionError(null);
      try {
        const entry = await client.generateJournal(input);
        setEntries((previous) => [entry, ...previous.filter((item) => item.id !== entry.id)]);
        setSelectedId(entry.id);
        return entry;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return null;
      } finally {
        setGenerating(false);
      }
    },
    [client],
  );

  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null;

  return {
    entries,
    selected,
    error,
    actionError,
    loading,
    refreshing,
    generating,
    refresh,
    select,
    generate,
  };
}

export interface PluginsResource {
  plugins: Plugin[];
  runs: Record<string, PluginRun[]>;
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  busy: string | null;
  refresh: () => void;
  clearActionError: () => void;
  install: (path: string) => Promise<boolean>;
  toggle: (plugin: Plugin) => Promise<boolean>;
  remove: (pluginId: string) => Promise<boolean>;
  run: (pluginId: string, input: PluginRunInput) => Promise<PluginRun | null>;
  loadRuns: (pluginId: string) => Promise<boolean>;
}

export function usePlugins(): PluginsResource {
  const client = useApiClient();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [runs, setRuns] = useState<Record<string, PluginRun[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const response = await client.listPlugins({ signal: controller.signal });
        if (controller.signal.aborted) return;
        setPlugins(response);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const clearActionError = useCallback(() => setActionError(null), []);

  const install = useCallback(
    async (pluginPath: string): Promise<boolean> => {
      setBusy('install');
      setActionError(null);
      try {
        const plugin = await client.installPlugin({ path: pluginPath });
        setPlugins((previous) => {
          const exists = previous.some((item) => item.id === plugin.id);
          return exists
            ? previous.map((item) => (item.id === plugin.id ? plugin : item))
            : [...previous, plugin];
        });
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  const toggle = useCallback(
    async (plugin: Plugin): Promise<boolean> => {
      setBusy(plugin.id);
      setActionError(null);
      try {
        const updated = await client.updatePlugin(plugin.id, { enabled: !plugin.enabled });
        setPlugins((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  const remove = useCallback(
    async (pluginId: string): Promise<boolean> => {
      setBusy(pluginId);
      setActionError(null);
      try {
        await client.removePlugin(pluginId);
        setPlugins((previous) => previous.filter((item) => item.id !== pluginId));
        setRuns((previous) => {
          const next = { ...previous };
          delete next[pluginId];
          return next;
        });
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  const run = useCallback(
    async (pluginId: string, input: PluginRunInput): Promise<PluginRun | null> => {
      setBusy(pluginId);
      setActionError(null);
      try {
        const result = await client.runPlugin(pluginId, input);
        setRuns((previous) => ({
          ...previous,
          [pluginId]: [result, ...(previous[pluginId] ?? [])],
        }));
        return result;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  const loadRuns = useCallback(
    async (pluginId: string): Promise<boolean> => {
      setBusy(pluginId);
      setActionError(null);
      try {
        const response = await client.listPluginRuns(pluginId, 20);
        setRuns((previous) => ({ ...previous, [pluginId]: response }));
        return true;
      } catch (actionFailure) {
        setActionError(describeError(actionFailure));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  return {
    plugins,
    runs,
    error,
    actionError,
    loading,
    refreshing,
    busy,
    refresh,
    clearActionError,
    install,
    toggle,
    remove,
    run,
    loadRuns,
  };
}

/**
 * Refresh overview data shortly after flight lifecycle events. Stream chunks
 * are intentionally ignored: totals change with `session.updated`, not with
 * every token.
 */
export function useLiveRefresh(
  refresh: () => void,
  delay = 400,
  shouldRefresh: (event: LiveEvent) => boolean = (event) => event.type.startsWith('session.'),
): void {
  const timer = useRef<number | undefined>(undefined);
  const refreshRef = useRef(refresh);
  const predicateRef = useRef(shouldRefresh);

  useEffect(() => {
    refreshRef.current = refresh;
    predicateRef.current = shouldRefresh;
  }, [refresh, shouldRefresh]);

  useLiveSubscription((event) => {
    if (!predicateRef.current(event)) return;
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      refreshRef.current();
    }, delay);
  });

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );
}

export interface PairingResource {
  session: PairingSession | null;
  status: PairingSessionStatus | null;
  error: string | null;
  busy: boolean;
  create: (input?: { name?: string; ttlSeconds?: number }) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

export function usePairing(): PairingResource {
  const client = useApiClient();
  const [session, setSession] = useState<PairingSession | null>(null);
  const [status, setStatus] = useState<PairingSessionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  const reset = useCallback(() => {
    if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
    pollRef.current = undefined;
    setSession(null);
    setStatus(null);
    setError(null);
  }, []);

  const create = useCallback(
    async (input: { name?: string; ttlSeconds?: number } = {}) => {
      setBusy(true);
      setError(null);
      try {
        const created = await client.createPairing({
          ...(input.name ? { name: input.name } : {}),
          ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
        });
        setSession(created);
        setStatus({
          id: created.id,
          expiresAt: created.expiresAt,
          expired: false,
          claimed: false,
        });
      } catch (createError) {
        setError(describeError(createError));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const cancel = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await client.cancelPairing(session.id);
      reset();
    } catch (cancelError) {
      setError(describeError(cancelError));
    } finally {
      setBusy(false);
    }
  }, [client, reset, session]);

  useEffect(() => {
    if (!session || status?.claimed || status?.expired) return undefined;

    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const next = await client.getPairingSession(session.id);
        if (cancelled) return;
        setStatus(next);
        if (next.claimed || next.expired) {
          window.clearInterval(pollRef.current);
          pollRef.current = undefined;
        }
      } catch (pollError) {
        if (!cancelled) setError(describeError(pollError));
      }
    };

    pollRef.current = window.setInterval(() => {
      void tick();
    }, 2_000);
    void tick();

    return () => {
      cancelled = true;
      if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
      pollRef.current = undefined;
    };
  }, [client, session, status?.claimed, status?.expired]);

  return { session, status, error, busy, create, cancel, reset };
}

export interface DevicesResource {
  devices: Device[];
  error: string | null;
  actionError: string | null;
  loading: boolean;
  refreshing: boolean;
  busyId: string | null;
  refresh: () => void;
  revoke: (id: string) => Promise<void>;
}

export function useDevices(): DevicesResource {
  const client = useApiClient();
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const next = await client.listDevices({ signal: controller.signal });
        if (controller.signal.aborted) return;
        setDevices(next);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted || isAbortError(loadError)) return;
        setError(describeError(loadError));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void load('initial');
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  const revoke = useCallback(
    async (id: string) => {
      setBusyId(id);
      setActionError(null);
      try {
        await client.revokeDevice(id);
        await load('refresh');
      } catch (revokeError) {
        setActionError(describeError(revokeError));
      } finally {
        setBusyId(null);
      }
    },
    [client, load],
  );

  return {
    devices,
    error,
    actionError,
    loading,
    refreshing,
    busyId,
    refresh,
    revoke,
  };
}

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

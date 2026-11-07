import { WebSocketServerMessageSchema, type LiveEvent } from '@cockpit/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface LiveFeedValue {
  status: LiveStatus;
  subscribe: (listener: (event: LiveEvent) => void) => () => void;
}

const noopSubscribe = (): (() => void) => () => undefined;

const LiveFeedContext = createContext<LiveFeedValue>({
  status: 'offline',
  subscribe: noopSubscribe,
});

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const KEEP_ALIVE_MS = 30_000;

export function buildWebSocketUrl(
  sessionId?: string,
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  const explicit = import.meta.env['VITE_COCKPIT_WS_URL'];
  const fallbackOrigin = `${location.protocol}//${location.host}`;
  const url =
    typeof explicit === 'string' && explicit.trim().length > 0
      ? new URL(explicit.trim(), fallbackOrigin)
      : new URL(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws`);

  if (sessionId) url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

export function liveStatusLabel(status: LiveStatus): string {
  switch (status) {
    case 'live':
      return 'Live';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'offline':
      return 'Offline';
  }
}

export interface LiveFeedProviderProps {
  children: ReactNode;
  sessionId?: string;
}

export function LiveFeedProvider({ children, sessionId }: LiveFeedProviderProps) {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const listeners = useRef(new Set<(event: LiveEvent) => void>());

  const subscribe = useCallback((listener: (event: LiveEvent) => void): (() => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (typeof WebSocket === 'undefined') {
      setStatus('offline');
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let keepAliveTimer: number | undefined;
    let attempts = 0;

    const clearKeepAlive = (): void => {
      if (keepAliveTimer !== undefined) {
        window.clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
      }
    };

    const scheduleReconnect = (): void => {
      if (disposed) return;
      setStatus('reconnecting');
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempts, 4));
      attempts += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };

    const connect = (): void => {
      if (disposed) return;
      setStatus(attempts === 0 ? 'connecting' : 'reconnecting');

      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(buildWebSocketUrl(sessionId));
      } catch {
        scheduleReconnect();
        return;
      }
      socket = nextSocket;

      nextSocket.onopen = () => {
        if (disposed) return;
        attempts = 0;
        setStatus('live');
        clearKeepAlive();
        keepAliveTimer = window.setInterval(() => {
          if (nextSocket.readyState === WebSocket.OPEN) {
            nextSocket.send(JSON.stringify({ type: 'ping' }));
          }
        }, KEEP_ALIVE_MS);
      };

      nextSocket.onmessage = (message: MessageEvent<unknown>) => {
        if (disposed || typeof message.data !== 'string') return;

        let payload: unknown;
        try {
          payload = JSON.parse(message.data) as unknown;
        } catch {
          return;
        }

        const parsed = WebSocketServerMessageSchema.safeParse(payload);
        if (!parsed.success || parsed.data.type !== 'event') return;

        for (const listener of listeners.current) {
          try {
            listener(parsed.data.event);
          } catch {
            // A failing listener must not break the feed.
          }
        }
      };

      nextSocket.onerror = () => {
        if (!disposed) setStatus('reconnecting');
      };

      nextSocket.onclose = () => {
        clearKeepAlive();
        if (!disposed) scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      clearKeepAlive();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close(1000, 'Cockpit dashboard closed the live feed.');
      socket = null;
    };
  }, [sessionId]);

  const value = useMemo<LiveFeedValue>(() => ({ status, subscribe }), [status, subscribe]);

  return <LiveFeedContext.Provider value={value}>{children}</LiveFeedContext.Provider>;
}

export function useLiveFeed(): LiveFeedValue {
  return useContext(LiveFeedContext);
}

export function useLiveStatus(): LiveStatus {
  return useContext(LiveFeedContext).status;
}

export function useLiveSubscription(handler: (event: LiveEvent) => void): void {
  const { subscribe } = useLiveFeed();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => subscribe((event) => handlerRef.current(event)), [subscribe]);
}

export function useRecentLiveEvents(filter: (event: LiveEvent) => boolean, limit = 8): LiveEvent[] {
  const [recent, setRecent] = useState<LiveEvent[]>([]);
  const filterRef = useRef(filter);

  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  useLiveSubscription((event) => {
    if (!filterRef.current(event)) return;
    setRecent((previous) => [...previous.slice(-(limit - 1)), event]);
  });

  return recent;
}

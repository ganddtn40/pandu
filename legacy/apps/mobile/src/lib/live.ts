import { WebSocketServerMessageSchema, type LiveEvent } from '@cockpit/core';
import { useEffect, useRef, useState } from 'react';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface LiveState {
  status: LiveStatus;
  lastEvent: LiveEvent | null;
  eventCount: number;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 20_000;
const KEEP_ALIVE_MS = 30_000;

export function buildMobileWebSocketUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = new URLSearchParams({ token }).toString();
  return url.toString();
}

export function useLiveFeed(baseUrl: string, token: string): LiveState {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let reconnectTimer: number | undefined;
    let keepAliveTimer: number | undefined;

    const clearTimers = (): void => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (keepAliveTimer !== undefined) window.clearInterval(keepAliveTimer);
      reconnectTimer = undefined;
      keepAliveTimer = undefined;
    };

    const connect = (): void => {
      if (disposed) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

      let socket: WebSocket;
      try {
        socket = new WebSocket(buildMobileWebSocketUrl(baseUrl, token));
      } catch {
        setStatus('offline');
        return;
      }
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (disposed) return;
        attempt = 0;
        setStatus('live');
        socket.send(JSON.stringify({ type: 'subscribe' }));
        keepAliveTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, KEEP_ALIVE_MS);
      });

      socket.addEventListener('message', (event) => {
        if (disposed || typeof event.data !== 'string') return;
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(event.data);
        } catch {
          return;
        }
        const parsed = WebSocketServerMessageSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.type !== 'event') return;
        setLastEvent(parsed.data.event);
        setEventCount((count) => count + 1);
      });

      const scheduleReconnect = (): void => {
        if (disposed) return;
        setStatus('reconnecting');
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };

      socket.addEventListener('error', () => {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
      });

      socket.addEventListener('close', () => {
        if (disposed) return;
        if (keepAliveTimer !== undefined) {
          window.clearInterval(keepAliveTimer);
          keepAliveTimer = undefined;
        }
        scheduleReconnect();
      });
    };

    connect();

    return () => {
      disposed = true;
      clearTimers();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [baseUrl, token]);

  return { status, lastEvent, eventCount };
}

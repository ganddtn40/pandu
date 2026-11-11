use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use pandu_core::model::LiveEvent;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::store::{Store, now_iso};

const CHANNEL_CAPACITY: usize = 1024;

/// Fan-out bus for the live UI. Every event is persisted best-effort so a
/// reconnect can replay what it missed; a storage failure must never break the
/// proxy, so persistence errors are only logged.
pub struct LiveBus {
    sender: broadcast::Sender<LiveEvent>,
    sequence: AtomicU64,
    store: Arc<Store>,
}

impl LiveBus {
    pub fn new(store: Arc<Store>, initial_sequence: u64) -> Arc<Self> {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Arc::new(Self {
            sender,
            sequence: AtomicU64::new(initial_sequence),
            store,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LiveEvent> {
        self.sender.subscribe()
    }

    pub fn current_sequence(&self) -> u64 {
        self.sequence.load(Ordering::Relaxed)
    }

    pub fn publish(
        &self,
        event_type: &str,
        session_id: Option<&str>,
        step_id: Option<&str>,
        payload: Value,
    ) -> LiveEvent {
        self.publish_with_persist(event_type, session_id, step_id, payload, true)
    }

    /// Publish an event that is useful live but too noisy to store, such as
    /// individual stream deltas.
    pub fn publish_transient(
        &self,
        event_type: &str,
        session_id: Option<&str>,
        step_id: Option<&str>,
        payload: Value,
    ) -> LiveEvent {
        self.publish_with_persist(event_type, session_id, step_id, payload, false)
    }

    fn publish_with_persist(
        &self,
        event_type: &str,
        session_id: Option<&str>,
        step_id: Option<&str>,
        payload: Value,
        persist: bool,
    ) -> LiveEvent {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let event = LiveEvent {
            sequence,
            event_type: event_type.to_string(),
            at: now_iso(),
            session_id: session_id.map(str::to_string),
            step_id: step_id.map(str::to_string),
            payload,
        };

        if persist && let Err(error) = self.store.insert_live_event(&event) {
            tracing::warn!(%error, "could not persist a live event");
        }
        // A missing receiver is normal: nobody has the UI open.
        let _ = self.sender.send(event.clone());
        event
    }

    pub fn replay(&self, limit: u32) -> Vec<LiveEvent> {
        self.store
            .recent_live_events(limit)
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "could not read recent live events");
                Vec::new()
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_and_replays() {
        let store = Arc::new(Store::open(":memory:").unwrap());
        let bus = LiveBus::new(store, 0);
        let event = bus.publish("step.started", Some("s"), Some("t"), serde_json::json!({}));
        assert_eq!(event.sequence, 1);
        assert_eq!(bus.current_sequence(), 1);
        let replay = bus.replay(10);
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].event_type, "step.started");
    }
}

#[cfg(not(target_os = "macos"))]
use rdev::listen_with_ready;
#[cfg(target_os = "macos")]
use rdev::listen_with_ready_and_error;
use rdev::{Event, EventType};
#[cfg(target_os = "windows")]
use rdev::{Keyboard, KeyboardState};
use serde::Serialize;
use serde_json::{Value, json};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Runtime, command};

#[derive(Debug, Clone, Serialize)]
pub enum DeviceEventKind {
    MousePress,
    MouseRelease,
    MouseMove,
    KeyboardPress,
    KeyboardRelease,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceEvent {
    kind: DeviceEventKind,
    value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum DeviceListenerState {
    Starting,
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceListenerStatus {
    state: DeviceListenerState,
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListenerLifecycle {
    Stopped,
    Starting,
    Ready,
}

static LISTENER_STATE: Mutex<ListenerLifecycle> = Mutex::new(ListenerLifecycle::Stopped);

struct ListeningGuard {
    reset_on_drop: bool,
}

impl ListeningGuard {
    fn acquire() -> Result<Self, ListenerLifecycle> {
        let mut state = LISTENER_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if *state != ListenerLifecycle::Stopped {
            return Err(*state);
        }

        *state = ListenerLifecycle::Starting;
        Ok(Self {
            reset_on_drop: true,
        })
    }

    #[cfg(target_os = "macos")]
    fn detach(mut self) {
        self.reset_on_drop = false;
    }
}

impl Drop for ListeningGuard {
    fn drop(&mut self) {
        if self.reset_on_drop {
            let mut state = LISTENER_STATE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *state = ListenerLifecycle::Stopped;
        }
    }
}

#[command]
pub fn start_device_listening<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    let listening_guard = loop {
        match ListeningGuard::acquire() {
            Ok(guard) => break guard,
            Err(_) => {
                let state = LISTENER_STATE
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());

                match *state {
                    ListenerLifecycle::Stopped => continue,
                    ListenerLifecycle::Starting => {
                        emit_listener_status(&app_handle, DeviceListenerState::Starting, None)
                    }
                    ListenerLifecycle::Ready => {
                        emit_listener_status(&app_handle, DeviceListenerState::Ready, None)
                    }
                }

                return Ok(());
            }
        }
    };

    emit_listener_status(&app_handle, DeviceListenerState::Starting, None);

    let spawn_error_handle = app_handle.clone();
    thread::Builder::new()
        .name("device-listener".into())
        .spawn(move || {
            let event_app_handle = app_handle.clone();

            #[cfg(target_os = "windows")]
            let mut keyboard = Keyboard::new();

            let callback = move |event: Event| {
                let label = event
                    .unicode
                    .as_ref()
                    .and_then(|unicode| unicode.name.clone());
                #[cfg(target_os = "windows")]
                let label = label.or_else(|| {
                    keyboard
                        .add(&event.event_type)
                        .and_then(|unicode| unicode.name)
                });

                let device_event = match event.event_type {
                    EventType::ButtonPress(button) => DeviceEvent {
                        kind: DeviceEventKind::MousePress,
                        value: json!(format!("{:?}", button)),
                    },
                    EventType::ButtonRelease(button) => DeviceEvent {
                        kind: DeviceEventKind::MouseRelease,
                        value: json!(format!("{:?}", button)),
                    },
                    EventType::MouseMove { x, y } => DeviceEvent {
                        kind: DeviceEventKind::MouseMove,
                        value: json!({ "x": x, "y": y }),
                    },
                    EventType::KeyPress(key) => DeviceEvent {
                        kind: DeviceEventKind::KeyboardPress,
                        value: json!({
                            "code": format!("{:?}", key),
                            "label": label,
                        }),
                    },
                    EventType::KeyRelease(key) => DeviceEvent {
                        kind: DeviceEventKind::KeyboardRelease,
                        value: json!({
                            "code": format!("{:?}", key),
                            "label": label,
                        }),
                    },
                    _ => return,
                };

                let _ = event_app_handle.emit("device-changed", device_event);
            };

            let ready_app_handle = app_handle.clone();
            let ready = move || mark_listener_ready(&ready_app_handle);

            #[cfg(target_os = "macos")]
            let result = {
                let failure_app_handle = app_handle.clone();
                let failure = move |err| {
                    mark_listener_runtime_failed(
                        &failure_app_handle,
                        format!("Device listener stopped: {err:?}"),
                    );
                };
                catch_unwind(AssertUnwindSafe(|| {
                    listen_with_ready_and_error(callback, ready, failure)
                }))
            };

            #[cfg(not(target_os = "macos"))]
            let result = catch_unwind(AssertUnwindSafe(|| listen_with_ready(callback, ready)));

            #[cfg(target_os = "macos")]
            match result {
                Ok(Ok(())) => {
                    listening_guard.detach();
                }
                Ok(Err(err)) => {
                    let message = format!("Failed to listen device: {err:?}");

                    drop(listening_guard);
                    emit_listener_unavailable(&app_handle, message);
                }
                Err(_) => {
                    drop(listening_guard);
                    emit_listener_unavailable(
                        &app_handle,
                        "Device listener thread panicked".to_owned(),
                    );
                }
            }

            #[cfg(not(target_os = "macos"))]
            {
                let error = match result {
                    Ok(Ok(())) => "Device listener stopped unexpectedly".to_owned(),
                    Ok(Err(err)) => format!("Failed to listen device: {err:?}"),
                    Err(_) => "Device listener thread panicked".to_owned(),
                };

                drop(listening_guard);
                emit_listener_unavailable(&app_handle, error);
            }
        })
        .map_err(|err| {
            let message = format!("Failed to start device listener thread: {err}");
            emit_listener_unavailable(&spawn_error_handle, message.clone());
            message
        })?;

    Ok(())
}

fn mark_listener_ready<R: Runtime>(app_handle: &AppHandle<R>) {
    let mut state = LISTENER_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if *state == ListenerLifecycle::Starting {
        *state = ListenerLifecycle::Ready;
        emit_listener_status(app_handle, DeviceListenerState::Ready, None);
    }
}

fn emit_listener_unavailable<R: Runtime>(app_handle: &AppHandle<R>, error: String) {
    let state = LISTENER_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if *state == ListenerLifecycle::Stopped {
        emit_listener_status(app_handle, DeviceListenerState::Unavailable, Some(error));
    }
}

#[cfg(target_os = "macos")]
fn mark_listener_runtime_failed<R: Runtime>(app_handle: &AppHandle<R>, error: String) {
    let mut state = LISTENER_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if *state != ListenerLifecycle::Stopped {
        *state = ListenerLifecycle::Stopped;
        emit_listener_status(app_handle, DeviceListenerState::Unavailable, Some(error));
    }
}

fn emit_listener_status<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: DeviceListenerState,
    error: Option<String>,
) {
    let _ = app_handle.emit(
        "device-listener-status",
        DeviceListenerStatus { state, error },
    );
}

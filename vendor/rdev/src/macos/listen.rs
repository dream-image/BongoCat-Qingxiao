use crate::macos::common::*;
use crate::rdev::{Event, ListenError};
use cocoa::base::nil;
use cocoa::foundation::NSAutoreleasePool;
use core_foundation::base::CFRelease;
use core_graphics::event::{CGEventTapLocation, CGEventType};
use dispatch::Queue;
use std::os::raw::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

static mut GLOBAL_CALLBACK: Option<Box<dyn FnMut(Event) + Send>> = None;
static mut GLOBAL_FAILURE_CALLBACK: Option<Box<dyn FnOnce(ListenError) + Send>> = None;
static mut EVENT_TAP: CFMachPortRef = null();
static mut EVENT_SOURCE: CFRunLoopSourceRef = null_mut();
static CALLBACK_GATE: Mutex<()> = Mutex::new(());
const LISTENER_INACTIVE: u8 = 0;
const LISTENER_INSTALLING: u8 = 1;
const LISTENER_COMMITTED: u8 = 2;
const LISTENER_CALLBACK_FAILED: u8 = 3;
const LISTENER_SETUP_FAILED: u8 = 4;
static LISTENER_PHASE: AtomicU8 = AtomicU8::new(LISTENER_INACTIVE);

extern "C" {
    fn pthread_main_np() -> i32;
}

struct ListenerResources {
    tap: CFMachPortRef,
    source: CFRunLoopSourceRef,
    source_added: bool,
    owns_listener: bool,
}

impl ListenerResources {
    fn new() -> Self {
        Self {
            tap: null(),
            source: null_mut(),
            source_added: false,
            owns_listener: true,
        }
    }

    fn disarm(&mut self) {
        self.tap = null();
        self.source = null_mut();
        self.source_added = false;
        self.owns_listener = false;
    }
}

impl Drop for ListenerResources {
    fn drop(&mut self) {
        if !self.owns_listener {
            return;
        }

        unsafe {
            if LISTENER_PHASE.load(Ordering::Acquire) == LISTENER_CALLBACK_FAILED {
                let _callback_guard = CALLBACK_GATE
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                self.disarm();
                LISTENER_PHASE.store(LISTENER_INACTIVE, Ordering::Release);
                return;
            }

            let tap = self.tap;
            let source = self.source;
            let source_added = self.source_added;
            self.disarm();
            cleanup_setup_listener(tap, source, source_added);
        }
    }
}

unsafe extern "C" fn raw_callback(
    _proxy: CGEventTapProxy,
    _type: CGEventType,
    cg_event: CGEventRef,
    _user_info: *mut c_void,
) -> CGEventRef {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let _callback_guard = CALLBACK_GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(
            _type,
            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
        ) {
            handle_disabled_event_tap();
            return;
        }
        let Some(cg_event_ref) = borrow_cg_event(cg_event) else {
            return;
        };
        if catch_unwind(AssertUnwindSafe(|| {
            handle_event(_type, &cg_event_ref);
        }))
        .is_err()
        {
            stop_listener_after_runtime_failure(ListenError::CallbackPanic);
        }
    }));

    cg_event
}

unsafe extern "C" fn raw_invalidation_callback(tap: CFMachPortRef, _info: *mut c_void) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let _callback_guard = CALLBACK_GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if tap == EVENT_TAP {
            stop_listener_after_runtime_failure(ListenError::EventTapInvalidated);
        }
    }));
}

unsafe fn handle_disabled_event_tap() {
    if !listener_accepts_events() || EVENT_TAP.is_null() {
        return;
    }

    CGEventTapEnable(EVENT_TAP, true);
    if !CGEventTapIsEnabled(EVENT_TAP) {
        stop_listener_after_runtime_failure(ListenError::EventTapDisabled);
    }
}

unsafe fn handle_event(event_type: CGEventType, cg_event: &core_graphics::event::CGEvent) {
    if !listener_accepts_events() {
        return;
    }

    if let Ok(mut state) = KEYBOARD_STATE.lock() {
        if let Some(keyboard) = state.as_mut() {
            if let Some(event) = convert(event_type, cg_event, keyboard) {
                if let Some(callback) = &mut GLOBAL_CALLBACK {
                    if catch_unwind(AssertUnwindSafe(|| callback(event))).is_err() {
                        stop_listener_after_runtime_failure(ListenError::CallbackPanic);
                    }
                }
            }
        }
    }
}

fn listener_accepts_events() -> bool {
    LISTENER_PHASE.load(Ordering::Acquire) == LISTENER_COMMITTED
}

unsafe fn stop_listener_after_runtime_failure(error: ListenError) {
    let previous_phase = loop {
        let phase = LISTENER_PHASE.load(Ordering::Acquire);
        if !matches!(phase, LISTENER_INSTALLING | LISTENER_COMMITTED) {
            return;
        }
        let failure_phase = if phase == LISTENER_INSTALLING {
            LISTENER_SETUP_FAILED
        } else {
            LISTENER_CALLBACK_FAILED
        };
        if LISTENER_PHASE
            .compare_exchange(phase, failure_phase, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            break phase;
        }
    };

    let tap = EVENT_TAP;
    let source = EVENT_SOURCE;

    if previous_phase == LISTENER_INSTALLING {
        if !tap.is_null() {
            CFMachPortSetInvalidationCallBack(tap, None);
        }
        return;
    }

    let failure_callback = GLOBAL_FAILURE_CALLBACK.take();

    EVENT_TAP = null();
    EVENT_SOURCE = null_mut();
    GLOBAL_CALLBACK = None;

    if !tap.is_null() {
        CFMachPortSetInvalidationCallBack(tap, None);
        CGEventTapEnable(tap, false);
    }
    if !source.is_null() {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    }

    release_listener_resources_async(tap, source, failure_callback, error);
}

unsafe fn cleanup_setup_listener(
    tap: CFMachPortRef,
    source: CFRunLoopSourceRef,
    source_added: bool,
) {
    let tap_address = tap as usize;
    let source_address = source as usize;
    let cleanup = move || unsafe {
        let tap = tap_address as CFMachPortRef;
        let source = source_address as CFRunLoopSourceRef;
        if !tap.is_null() {
            CFMachPortSetInvalidationCallBack(tap, None);
        }

        GLOBAL_CALLBACK = None;
        GLOBAL_FAILURE_CALLBACK = None;
        EVENT_TAP = null();
        EVENT_SOURCE = null_mut();
        LISTENER_PHASE.store(LISTENER_INACTIVE, Ordering::Release);

        if !tap.is_null() {
            CGEventTapEnable(tap, false);
        }
        if source_added && !source.is_null() {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
        }
        if !source.is_null() {
            CFRelease(source.cast());
        }
        if !tap.is_null() {
            CFRelease(tap.cast());
        }
    };

    if source_added && pthread_main_np() == 0 {
        Queue::main().exec_sync(cleanup);
    } else {
        cleanup();
    }
}

unsafe fn release_listener_resources_async(
    tap: CFMachPortRef,
    source: CFRunLoopSourceRef,
    failure_callback: Option<Box<dyn FnOnce(ListenError) + Send>>,
    error: ListenError,
) {
    let tap_address = tap as usize;
    let source_address = source as usize;
    Queue::main().exec_async(move || unsafe {
        if source_address != 0 {
            CFRelease((source_address as *const c_void).cast());
        }
        if tap_address != 0 {
            CFRelease((tap_address as *const c_void).cast());
        }
        let _ = LISTENER_PHASE.compare_exchange(
            LISTENER_CALLBACK_FAILED,
            LISTENER_INACTIVE,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if let Some(failure_callback) = failure_callback {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                failure_callback(error);
            }));
        }
    });
}

pub fn listen<T>(callback: T) -> Result<(), ListenError>
where
    T: FnMut(Event) + Send + 'static,
{
    listen_with_ready_and_error(callback, || {}, |_| {})
}

pub fn listen_with_ready<T, R>(callback: T, ready: R) -> Result<(), ListenError>
where
    T: FnMut(Event) + Send + 'static,
    R: FnOnce() + 'static,
{
    listen_with_ready_and_error(callback, ready, |_| {})
}

pub fn listen_with_ready_and_error<T, R, F>(
    callback: T,
    ready: R,
    failure: F,
) -> Result<(), ListenError>
where
    T: FnMut(Event) + Send + 'static,
    R: FnOnce() + 'static,
    F: FnOnce(ListenError) + Send + 'static,
{
    let mut types = kCGEventMaskForAllEvents;
    if crate::keyboard_only() {
        types = (1 << CGEventType::KeyDown as u64)
            + (1 << CGEventType::KeyUp as u64)
            + (1 << CGEventType::FlagsChanged as u64);
    }
    unsafe {
        LISTENER_PHASE.store(LISTENER_INACTIVE, Ordering::Release);
        GLOBAL_CALLBACK = Some(Box::new(callback));
        GLOBAL_FAILURE_CALLBACK = Some(Box::new(failure));
        let mut resources = ListenerResources::new();
        let _pool = NSAutoreleasePool::new(nil);
        let tap = CGEventTapCreate(
            CGEventTapLocation::HID, // HID, Session, AnnotatedSession,
            kCGHeadInsertEventTap,
            CGEventTapOption::ListenOnly,
            types,
            raw_callback,
            nil,
        );
        if tap.is_null() {
            return Err(ListenError::EventTapError);
        }
        resources.tap = tap;
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0);
        if source.is_null() {
            return Err(ListenError::LoopSourceError);
        }
        resources.source = source;

        let current_loop = CFRunLoopGetMain();
        CFRunLoopAddSource(current_loop, source, kCFRunLoopCommonModes);
        resources.source_added = true;
        EVENT_TAP = tap;
        EVENT_SOURCE = source;

        LISTENER_PHASE.store(LISTENER_INSTALLING, Ordering::Release);
        CFMachPortSetInvalidationCallBack(tap, Some(raw_invalidation_callback));
        {
            let _callback_guard = CALLBACK_GATE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if LISTENER_PHASE.load(Ordering::Acquire) != LISTENER_INSTALLING {
                return Err(ListenError::EventTapInvalidated);
            }
            CGEventTapEnable(tap, true);
            if !CGEventTapIsEnabled(tap) {
                LISTENER_PHASE.store(LISTENER_SETUP_FAILED, Ordering::Release);
                return Err(ListenError::EventTapDisabled);
            }
            if catch_unwind(AssertUnwindSafe(ready)).is_err() {
                let _ = LISTENER_PHASE.compare_exchange(
                    LISTENER_INSTALLING,
                    LISTENER_SETUP_FAILED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                return Err(ListenError::CallbackPanic);
            }
            if LISTENER_PHASE
                .compare_exchange(
                    LISTENER_INSTALLING,
                    LISTENER_COMMITTED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_err()
            {
                return Err(ListenError::CallbackPanic);
            }
        }
        resources.disarm();
        CFRunLoopRun();
    }
    Ok(())
}

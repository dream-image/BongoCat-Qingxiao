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

// 系统回调与失败清理不保证停留在创建线程，所以被长期保存的闭包显式要求 Send。
static mut GLOBAL_CALLBACK: Option<Box<dyn FnMut(Event) + Send>> = None;
static mut GLOBAL_FAILURE_CALLBACK: Option<Box<dyn FnOnce(ListenError) + Send>> = None;
static mut EVENT_TAP: CFMachPortRef = null();
static mut EVENT_SOURCE: CFRunLoopSourceRef = null_mut();
// CoreGraphics 回调、安装失败清理和主队列异步释放都可能触碰同一组全局指针。
// 统一门禁让“回调仍在使用”和“资源开始释放”形成明确的先后关系，避免 use-after-free。
static CALLBACK_GATE: Mutex<()> = Mutex::new(());

// 安装与运行时失败的资源所有者不同：INSTALLING 仍由栈上 RAII 对象持有，COMMITTED
// 已转交给全局监听器；分开记录才能保证每个 CF 对象只释放一次。
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
        // 只在全局状态成功接管资源后解除 RAII，后续提前返回仍由 Drop 完整回滚。
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
                // 运行时失败路径已经把释放工作投递到主队列；这里只交还栈上所有权，防止双重释放。
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
    // Rust panic 绝不能越过 C ABI；即使业务回调异常，也必须原样返回系统拥有的事件指针。
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let _callback_guard = CALLBACK_GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(
            _type,
            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
        ) {
            // macOS 会因回调超时或用户输入暂时禁用 tap，收到系统事件后尝试自愈并验证结果。
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
    // invalidation 可能与安装提交同时发生，必须走同一门禁和状态机，不能直接释放全局指针。
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
    // ready 回调执行完且资源所有权提交之前不派发事件，避免前端收到事件时仍认为监听器未就绪。
    LISTENER_PHASE.load(Ordering::Acquire) == LISTENER_COMMITTED
}

unsafe fn stop_listener_after_runtime_failure(error: ListenError) {
    // 多个系统回调可能同时观察到失败；CAS 只允许一个调用者成为清理者并通知应用。
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
        // 安装阶段仍由 ListenerResources::drop 回滚；这里只撤掉失效回调，避免两条路径抢着释放。
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
    // dispatch crate 要求闭包可跨线程发送，而裸 CF 指针不是 Send；转为地址只用于传递，
    // 进入拥有 RunLoop 的主队列后立即还原，并仍在 CALLBACK_GATE 下访问。
    let tap_address = tap as usize;
    let source_address = source as usize;
    let cleanup = move || unsafe {
        let _callback_guard = CALLBACK_GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

    // 已加入主 RunLoop 的 source 必须在主线程移除；若尚未加入或本就在主线程则直接清理。
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
    // 失效通知发生在 CoreGraphics 回调栈内，不能当场 CFRelease 正在回调的 tap。
    // 延迟到主队列释放后再通知上层，保证上层重启时旧实例已完全退出。
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
        // 安装 invalidation 回调后还必须在门禁内复查 phase，因为系统可能同步宣告 tap 已失效。
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
            // 所有权转移必须和 COMMITTED 写入处于同一临界区；否则失效回调可能先安排释放，
            // 栈上 Drop 又释放一次同一资源。
            resources.disarm();
        }
        CFRunLoopRun();
    }
    Ok(())
}

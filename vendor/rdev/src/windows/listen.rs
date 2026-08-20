use crate::{
    rdev::{Event, ListenError},
    windows::common::{
        convert, get_scan_code, set_key_hook, set_mouse_hook, HookError, KEYBOARD_HOOK, MOUSE_HOOK,
    },
};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{mem::zeroed, os::raw::c_int, ptr::null_mut, time::SystemTime};
use winapi::{
    shared::{
        basetsd::ULONG_PTR,
        minwindef::{LPARAM, LRESULT, WPARAM},
    },
    um::winuser::{
        CallNextHookEx, DispatchMessageA, GetMessageA, PostQuitMessage, TranslateMessage,
        UnhookWindowsHookEx, HC_ACTION, MSG, PKBDLLHOOKSTRUCT, PMOUSEHOOKSTRUCT,
    },
};

static mut GLOBAL_CALLBACK: Option<Box<dyn FnMut(Event)>> = None;
static CALLBACK_PANICKED: AtomicBool = AtomicBool::new(false);

struct ListenerResources;

impl Drop for ListenerResources {
    fn drop(&mut self) {
        unsafe {
            if !MOUSE_HOOK.is_null() {
                UnhookWindowsHookEx(MOUSE_HOOK);
                MOUSE_HOOK = null_mut();
            }
            if !KEYBOARD_HOOK.is_null() {
                UnhookWindowsHookEx(KEYBOARD_HOOK);
                KEYBOARD_HOOK = null_mut();
            }
            GLOBAL_CALLBACK = None;
        }
    }
}

impl From<HookError> for ListenError {
    fn from(error: HookError) -> Self {
        match error {
            HookError::Mouse(code) => ListenError::MouseHookError(code),
            HookError::Key(code) => ListenError::KeyHookError(code),
        }
    }
}

unsafe fn raw_callback(
    code: c_int,
    param: WPARAM,
    lpdata: LPARAM,
    f_get_extra_data: impl FnOnce(isize) -> ULONG_PTR,
) -> LRESULT {
    if code == HC_ACTION {
        let (opt, code) = convert(param, lpdata);
        if let Some(event_type) = opt {
            let event = Event {
                event_type,
                time: SystemTime::now(),
                unicode: None,
                platform_code: code as _,
                position_code: get_scan_code(lpdata),
                usb_hid: 0,
                extra_data: f_get_extra_data(lpdata),
            };
            if let Some(callback) = &mut GLOBAL_CALLBACK {
                callback(event);
            }
        }
    }
    CallNextHookEx(null_mut(), code, param, lpdata)
}

unsafe extern "system" fn raw_callback_mouse(code: i32, param: usize, lpdata: isize) -> isize {
    match catch_unwind(AssertUnwindSafe(|| {
        raw_callback(code, param, lpdata, |data: isize| unsafe {
            (*(data as PMOUSEHOOKSTRUCT)).dwExtraInfo
        })
    })) {
        Ok(result) => result,
        Err(_) => {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                signal_callback_panic();
            }));
            CallNextHookEx(null_mut(), code, param, lpdata)
        }
    }
}

unsafe extern "system" fn raw_callback_keyboard(code: i32, param: usize, lpdata: isize) -> isize {
    match catch_unwind(AssertUnwindSafe(|| {
        raw_callback(code, param, lpdata, |data: isize| unsafe {
            (*(data as PKBDLLHOOKSTRUCT)).dwExtraInfo
        })
    })) {
        Ok(result) => result,
        Err(_) => {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                signal_callback_panic();
            }));
            CallNextHookEx(null_mut(), code, param, lpdata)
        }
    }
}

unsafe fn signal_callback_panic() {
    CALLBACK_PANICKED.store(true, Ordering::Release);
    GLOBAL_CALLBACK = None;
    PostQuitMessage(1);
}

pub fn listen<T>(callback: T) -> Result<(), ListenError>
where
    T: FnMut(Event) + 'static,
{
    listen_with_ready(callback, || {})
}

pub fn listen_with_ready<T, R>(callback: T, ready: R) -> Result<(), ListenError>
where
    T: FnMut(Event) + 'static,
    R: FnOnce() + 'static,
{
    unsafe {
        CALLBACK_PANICKED.store(false, Ordering::Release);
        GLOBAL_CALLBACK = Some(Box::new(callback));
        let _resources = ListenerResources;
        set_key_hook(raw_callback_keyboard)?;
        if !crate::keyboard_only() {
            set_mouse_hook(raw_callback_mouse)?;
        }

        if catch_unwind(AssertUnwindSafe(ready)).is_err() {
            return Err(ListenError::CallbackPanic);
        }

        let mut message: MSG = zeroed();
        loop {
            let result = GetMessageA(&mut message, null_mut(), 0, 0);
            if result > 0 {
                TranslateMessage(&message);
                DispatchMessageA(&message);
            } else if result == 0 {
                return if CALLBACK_PANICKED.load(Ordering::Acquire) {
                    Err(ListenError::CallbackPanic)
                } else {
                    Ok(())
                };
            } else {
                return Err(ListenError::MessageLoopError(
                    winapi::um::errhandlingapi::GetLastError(),
                ));
            }
        }
    }
}

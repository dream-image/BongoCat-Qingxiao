extern crate libc;
extern crate x11;
use crate::linux::common::{convert, FALSE, KEYBOARD};
use crate::linux::keyboard::Keyboard;
use crate::rdev::{Event, ListenError};
use std::convert::TryInto;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_uchar, c_uint, c_ulong};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use x11::xlib;
use x11::xrecord;

static mut RECORD_ALL_CLIENTS: c_ulong = xrecord::XRecordAllClients;
static mut GLOBAL_CALLBACK: Option<Box<dyn FnMut(Event)>> = None;
static mut GLOBAL_READY_CALLBACK: Option<Box<dyn FnOnce()>> = None;
static mut CALLBACK_CONTROL_DISPLAY: *mut xlib::Display = null_mut();
static mut CALLBACK_CONTEXT: c_ulong = 0;
static CALLBACK_PANICKED: AtomicBool = AtomicBool::new(false);

struct ListenerResources {
    control_display: *mut xlib::Display,
    data_display: *mut xlib::Display,
    range: *mut xrecord::XRecordRange,
    context: c_ulong,
}

impl ListenerResources {
    fn new() -> Self {
        Self {
            control_display: null_mut(),
            data_display: null_mut(),
            range: null_mut(),
            context: 0,
        }
    }
}

impl Drop for ListenerResources {
    fn drop(&mut self) {
        unsafe {
            GLOBAL_READY_CALLBACK = None;
            GLOBAL_CALLBACK = None;
            CALLBACK_CONTROL_DISPLAY = null_mut();
            CALLBACK_CONTEXT = 0;
            KEYBOARD = None;

            if self.context != 0 && !self.control_display.is_null() {
                xrecord::XRecordFreeContext(self.control_display, self.context);
            }
            if !self.range.is_null() {
                xlib::XFree(self.range.cast());
            }
            if !self.data_display.is_null() {
                xlib::XCloseDisplay(self.data_display);
            }
            if !self.control_display.is_null() {
                xlib::XCloseDisplay(self.control_display);
            }
        }
    }
}

struct InterceptData(*mut xrecord::XRecordInterceptData);

impl Drop for InterceptData {
    fn drop(&mut self) {
        unsafe {
            xrecord::XRecordFreeData(self.0);
        }
    }
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
    let keyboard = Keyboard::new().ok_or(ListenError::KeyboardError)?;

    unsafe {
        CALLBACK_PANICKED.store(false, Ordering::Release);
        KEYBOARD = Some(keyboard);
        GLOBAL_CALLBACK = Some(Box::new(callback));
        GLOBAL_READY_CALLBACK = Some(Box::new(ready));
        let mut resources = ListenerResources::new();
        // Open displays
        let control_display = xlib::XOpenDisplay(null());
        if control_display.is_null() {
            return Err(ListenError::MissingDisplayError);
        }
        resources.control_display = control_display;
        let data_display = xlib::XOpenDisplay(null());
        if data_display.is_null() {
            return Err(ListenError::MissingDisplayError);
        }
        resources.data_display = data_display;
        let extension_name = CStr::from_bytes_with_nul(b"RECORD\0")
            .map_err(|_| ListenError::XRecordExtensionError)?;
        let control_extension = xlib::XInitExtension(control_display, extension_name.as_ptr());
        let data_extension = xlib::XInitExtension(data_display, extension_name.as_ptr());
        if control_extension.is_null() || data_extension.is_null() {
            return Err(ListenError::XRecordExtensionError);
        }

        // Prepare record range
        let record_range = xrecord::XRecordAllocRange();
        if record_range.is_null() {
            return Err(ListenError::RecordRangeError);
        }
        resources.range = record_range;
        (*record_range).device_events.first = xlib::KeyPress as c_uchar;
        (*record_range).device_events.last = if crate::keyboard_only() {
            xlib::KeyRelease
        } else {
            xlib::MotionNotify
        } as c_uchar;

        // Create context
        let mut record_range_arg = record_range;
        let context = xrecord::XRecordCreateContext(
            control_display,
            0,
            &mut RECORD_ALL_CLIENTS,
            1,
            &mut record_range_arg,
            1,
        );

        if context == 0 {
            return Err(ListenError::RecordContextError);
        }
        resources.context = context;
        CALLBACK_CONTROL_DISPLAY = control_display;
        CALLBACK_CONTEXT = context;

        xlib::XSync(control_display, FALSE);
        // Run
        let result =
            xrecord::XRecordEnableContext(data_display, context, Some(record_callback), &mut 0);
        if CALLBACK_PANICKED.load(Ordering::Acquire) {
            return Err(ListenError::CallbackPanic);
        }
        if result == 0 {
            return Err(ListenError::RecordContextEnablingError);
        }
    }
    Ok(())
}

// No idea how to do that properly relevant doc lives here:
// https://www.x.org/releases/X11R7.7/doc/libXtst/recordlib.html#Datum_Flags
// https://docs.rs/xproto/1.1.5/xproto/struct._xEvent__bindgen_ty_1.html
// 0.4.2: xproto was removed for some reason and contained the real structs
// but we can't use it anymore.
#[repr(C)]
struct XRecordDatum {
    type_: u8,
    code: u8,
    _rest: u64,
    _1: bool,
    _2: bool,
    _3: bool,
    root_x: i16,
    root_y: i16,
    event_x: i16,
    event_y: i16,
    state: u16,
}

unsafe extern "C" fn record_callback(
    _null: *mut c_char,
    raw_data: *mut xrecord::XRecordInterceptData,
) {
    if catch_unwind(AssertUnwindSafe(|| handle_record_callback(raw_data))).is_err() {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            signal_callback_panic();
        }));
    }
}

unsafe fn handle_record_callback(raw_data: *mut xrecord::XRecordInterceptData) {
    let Some(data) = raw_data.as_ref() else {
        return;
    };
    let _data = InterceptData(raw_data);

    if data.category == xrecord::XRecordStartOfData {
        if let Some(ready) = GLOBAL_READY_CALLBACK.take() {
            if catch_unwind(AssertUnwindSafe(ready)).is_err() {
                signal_callback_panic();
            }
        }
        return;
    }

    if data.category != xrecord::XRecordFromServer {
        return;
    }

    debug_assert!(data.data_len * 4 >= std::mem::size_of::<XRecordDatum>().try_into().unwrap());
    // Cast binary data
    #[allow(clippy::cast_ptr_alignment)]
    let Some(xdatum) = (data.data as *const XRecordDatum).as_ref() else {
        return;
    };

    let code: c_uint = xdatum.code.into();
    let type_: c_int = xdatum.type_.into();
    // let state = xdatum.state;

    let x = xdatum.root_x as f64;
    let y = xdatum.root_y as f64;

    if let Some(event) = convert(&mut KEYBOARD, code, type_, x, y) {
        if let Some(callback) = &mut GLOBAL_CALLBACK {
            if catch_unwind(AssertUnwindSafe(|| callback(event))).is_err() {
                signal_callback_panic();
            }
        }
    }
}

unsafe fn signal_callback_panic() {
    CALLBACK_PANICKED.store(true, Ordering::Release);
    GLOBAL_READY_CALLBACK = None;
    GLOBAL_CALLBACK = None;

    if !CALLBACK_CONTROL_DISPLAY.is_null() && CALLBACK_CONTEXT != 0 {
        xrecord::XRecordDisableContext(CALLBACK_CONTROL_DISPLAY, CALLBACK_CONTEXT);
        xlib::XFlush(CALLBACK_CONTROL_DISPLAY);
    }
}
